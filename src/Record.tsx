import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as RPE } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errText, src, stem, type Done, type Gains, type VideoInfo } from "./api.ts";
import { compile, defaultPieces, endState, fmt, SPEEDS, type Dir, type Ev, type Mode, type Pieces, type Pt, type XY } from "./timeline.ts";
import { drawScene, hitPiece, toBoard, PEN_COLORS, PEN_WIDTHS } from "./render.ts";
import { Busy, Modal, type CloseGuard } from "./App.tsx";
import logo from "./logo.png";

export interface Resume {
  dir: string;
  events: Ev[];
  audio: number;
  gains: Gains;
}

interface Props {
  video: VideoInfo;
  resume?: Resume;
  prev?: Done;
  guard: MutableRefObject<CloseGuard>;
  onDone: (d: Done, notice?: string) => void;
  onBack: () => void;
  onChangeVideo: () => void;
}

type LiveStroke = { id: string; layer: Mode; color: string; w: number; t0: number; pts: Pt[] };
type Phase = "prep" | "recording" | "finishing";
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

export default function Record({ video, resume, prev, guard, onDone, onBack, onChangeVideo }: Props) {
  const vref = useRef<HTMLVideoElement>(null);
  const cref = useRef<HTMLCanvasElement>(null);
  const srcTimeRef = useRef<HTMLSpanElement>(null);
  const stageTimeRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const recTimeRefs = useRef<(HTMLElement | null)[]>([]);

  const [phase, setPhase] = useState<Phase>("prep");
  const [mode, setModeS] = useState<Mode>("video");
  const [tool, setTool] = useState<"select" | "pen">("pen");
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [width, setWidth] = useState<number>(PEN_WIDTHS["中"]);
  const [dir, setDirS] = useState<Dir>(1);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateS] = useState(1);
  const [gains, setGains] = useState<Gains>(resume?.gains ?? prev?.gains ?? { voice: 1, source: 0.2 });
  const [playPath, setPlayPath] = useState(video.playPath);
  const [proxy, setProxy] = useState<number | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [mics, setMics] = useState<{ id: string; name: string }[]>([]);
  const [micId, setMicId] = useState("");
  const [mic, setMic] = useState<{ ok: boolean; msg: string }>({ ok: false, msg: "マイクを確認しています…" });
  const [level, setLevel] = useState(0);
  const [save, setSave] = useState<"idle" | "saved" | "error">("idle");
  const [toolsOpen, setToolsOpen] = useState(true);
  const [confirm, setConfirm] = useState<null | "abort" | "reset">(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [frozenPos, setFrozenPos] = useState(0);

  const live = useRef({ pieces: defaultPieces() as Pieces, strokes: [] as LiveStroke[], dir: 1 as Dir, mode: "video" as Mode, boardUndo: [] as { id: string; from: XY }[] });
  const rec = useRef<null | { dir: string; base: number; perf0: number; key: { t: number; pos: number; playing: boolean; rate: number }; pending: string[]; events: Ev[] }>(null);
  const flushing = useRef<Promise<void>>(Promise.resolve());
  const restorePos = useRef<number | null>(null);
  const ptr = useRef<null | { kind: "pen"; s: LiveStroke; perf0: number } | { kind: "drag"; id: string; from: XY; last: number }>(null);
  const lastSeekLog = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finishing = useRef(false);
  const keepOnExit = useRef(false);
  const finishRef = useRef<(notice?: string) => void>(() => {});
  const resumePrep = !!resume && phase === "prep";
  const recording = phase === "recording";

  // ---- recording clock & event log ----
  const now = () => (rec.current ? rec.current.base + (performance.now() - rec.current.perf0) / 1000 : 0);
  const log = (e: Ev) => {
    const r = rec.current;
    if (!r) return;
    r.pending.push(JSON.stringify(e));
    r.events.push(e);
  };
  const logV = () => {
    const v = vref.current;
    if (!v || !rec.current) return;
    const k = { t: now(), pos: v.currentTime, playing: !v.paused && !v.ended, rate: v.playbackRate };
    rec.current.key = k;
    log({ k: "v", ...k });
  };
  const flush = () =>
    (flushing.current = flushing.current.then(async () => {
      const r = rec.current;
      if (!r || !r.pending.length) return;
      const text = r.pending.join("\n") + "\n";
      r.pending = [];
      try {
        await api.append(r.dir, text);
        setSave("saved");
      } catch {
        r.pending.unshift(text.trimEnd());
        setSave("error");
      }
    }));

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(flush, 500);
    return () => clearInterval(t);
  }, [recording]);

  // ---- restore state after a crash (S03-R) ----
  useEffect(() => {
    if (!resume) return;
    try {
      const st = endState(compile(resume.events, resume.audio, video.duration));
      Object.assign(live.current, { pieces: st.pieces, dir: st.dir, mode: st.mode });
      live.current.strokes = st.strokes.map((s) => ({ id: s.id, layer: s.layer, color: s.color, w: s.w, t0: s.t0, pts: s.pts }));
      setModeS(st.mode);
      setDirS(st.dir);
      setTool(st.mode === "board" ? "select" : "pen");
      setRateS(st.rate);
      restorePos.current = st.pos;
      setFrozenPos(st.pos);
    } catch (e) {
      setError("復旧データを読み込めませんでした: " + errText(e));
    }
  }, []);

  // ---- microphone ----
  const openMic = async (id: string | null) => {
    setMic({ ok: false, msg: "マイクを確認しています…" });
    try {
      setMic({ ok: true, msg: await api.micOpen(id) });
    } catch (e) {
      setMic({ ok: false, msg: errText(e) });
    }
  };
  useEffect(() => {
    api.micList().then(setMics).catch(() => {});
    openMic(null);
    return () => void api.micClose();
  }, []);
  useEffect(() => {
    const t = setInterval(async () => {
      const [l, fault] = await api.micLevel();
      setLevel(l);
      if (!fault) return;
      setMic((m) => (m.ok ? { ok: false, msg: fault } : m));
      // the commentary is no longer being saved: stop and keep what was recorded
      if (phaseRef.current === "recording") finishRef.current(`録音が途中で止まりました: ${fault}`);
    }, 120);
    return () => clearInterval(t);
  }, []);

  // ---- close guard ----
  useEffect(() => {
    guard.current = async () => {
      if (keepOnExit.current)
        return (await ask("収録データは保存されています。終了後、アプリを再起動すると復旧できます。終了しますか？", { title: "さといも", kind: "info", okLabel: "終了", cancelLabel: "取り消す" })) && "keep";
      if (phaseRef.current === "prep" && !resume && !prev) return true;
      const ok = await ask(
        phaseRef.current === "prep" ? "保持している収録データは破棄されます。終了しますか？" : "収録中です。終了すると、この収録は破棄されます。終了しますか？",
        { title: "さといも", kind: "warning", okLabel: "破棄して終了", cancelLabel: "取り消す" },
      );
      if (ok) await api.recStop().catch(() => {});
      return ok;
    };
  }, []);

  // ---- video transport ----
  const v = () => vref.current!;
  const clearLayer = (layer: Mode) => {
    const L = live.current;
    const ids = L.strokes.filter((s) => s.layer === layer).map((s) => s.id);
    if (!ids.length) return;
    L.strokes = L.strokes.filter((s) => s.layer !== layer);
    log({ k: "rm", t: now(), ids });
  };
  const play = () => {
    if (live.current.mode !== "video" || resumePrep) return;
    clearLayer("video"); // drawings belong to the still frame
    v().play().catch(() => {});
    setPlaying(true);
    logV();
  };
  const pause = () => {
    v().pause();
    setPlaying(false);
    logV();
  };
  const toggle = () => (v().paused ? play() : pause());
  const seek = (x: number, final = true) => {
    if (resumePrep) return;
    v().currentTime = clamp(x, 0, video.duration);
    if (final || performance.now() - lastSeekLog.current > 100) {
      lastSeekLog.current = performance.now();
      logV();
    }
  };
  const step = (n: number) => {
    if (!v().paused) pause();
    seek(v().currentTime + n / video.fps);
  };
  const setRate = (r: number) => {
    if (resumePrep) return;
    v().playbackRate = r;
    setRateS(r);
    logV();
  };
  const setMode = (m: Mode) => {
    const L = live.current;
    if (m === L.mode || resumePrep) return;
    if (m === "board" && !v().paused) {
      v().pause();
      setPlaying(false);
      logV();
    }
    if (m === "board") setFrozenPos(v().currentTime);
    L.mode = m;
    setModeS(m);
    setTool(m === "board" ? "select" : "pen");
    log({ k: "mode", t: now(), mode: m });
  };

  // ---- drawing & board ----
  const undoStroke = () => {
    const L = live.current;
    for (let i = L.strokes.length - 1; i >= 0; i--)
      if (L.strokes[i].layer === L.mode) {
        const [s] = L.strokes.splice(i, 1);
        log({ k: "rm", t: now(), ids: [s.id] });
        return;
      }
  };
  const setPiece = (id: string, xy: XY) => {
    live.current.pieces = { ...live.current.pieces, [id]: xy };
    log({ k: "p", t: now(), id, x: r4(xy[0]), y: r4(xy[1]) });
  };
  const boardUndo = () => {
    const u = live.current.boardUndo.pop();
    if (u) setPiece(u.id, u.from);
  };
  const boardReset = () => {
    const d = defaultPieces();
    for (const [id, xy] of Object.entries(d)) {
      const cur = live.current.pieces[id];
      if (!cur || cur[0] !== xy[0] || cur[1] !== xy[1]) setPiece(id, xy);
    }
    live.current.boardUndo = [];
    setConfirm(null);
  };
  const toggleDir = () => {
    const d = (live.current.dir * -1) as Dir;
    live.current.dir = d;
    setDirS(d);
    log({ k: "dir", t: now(), dir: d });
  };

  const pos = (e: RPE) => {
    const r = cref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const onDown = (e: RPE<HTMLCanvasElement>) => {
    if (resumePrep || phase === "finishing") return;
    const L = live.current;
    const p = pos(e);
    if (tool === "pen") {
      if (L.mode === "video" && !v().paused) return flashHint("描画するには映像を停止してください（Space）");
      const s: LiveStroke = { id: Math.random().toString(36).slice(2, 10), layer: L.mode, color, w: width, t0: now(), pts: [[r4(p.x / p.w), r4(p.y / p.h), 0]] };
      L.strokes.push(s);
      ptr.current = { kind: "pen", s, perf0: performance.now() };
    } else if (L.mode === "board") {
      const [bx, by] = toBoard(p.x, p.y, p.w, p.h);
      const id = hitPiece(L.pieces, bx, by);
      if (!id) return;
      ptr.current = { kind: "drag", id, from: L.pieces[id], last: 0 };
    } else return;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPE<HTMLCanvasElement>) => {
    const d = ptr.current;
    if (!d) return;
    const p = pos(e);
    if (d.kind === "pen") {
      const x = r4(p.x / p.w),
        y = r4(p.y / p.h);
      const last = d.s.pts[d.s.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.0015) return;
      d.s.pts.push([x, y, r4((performance.now() - d.perf0) / 1000)]);
    } else {
      const [bx, by] = toBoard(p.x, p.y, p.w, p.h);
      const xy: XY = [clamp(bx, 0.01, 0.99), clamp(by, 0.01, 0.99)];
      live.current.pieces = { ...live.current.pieces, [d.id]: xy };
      if (performance.now() - d.last > 33) {
        d.last = performance.now();
        setPiece(d.id, xy);
      }
    }
  };
  const onUp = () => {
    const d = ptr.current;
    ptr.current = null;
    if (!d) return;
    if (d.kind === "pen") {
      const s = d.s;
      log({ k: "s", t: s.t0, id: s.id, layer: s.layer, color: s.color, w: s.w, pts: s.pts });
    } else {
      const xy = live.current.pieces[d.id];
      if (xy[0] !== d.from[0] || xy[1] !== d.from[1]) {
        setPiece(d.id, xy);
        live.current.boardUndo.push({ id: d.id, from: d.from });
      }
    }
  };
  const flashHint = (h: string) => {
    setHint(h);
    setTimeout(() => setHint((x) => (x === h ? null : x)), 2200);
  };

  // ---- render loop (canvas + time labels without React re-renders) ----
  useEffect(() => {
    let id = 0;
    const tick = () => {
      const c = cref.current,
        vv = vref.current;
      if (c) {
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr),
          h = Math.round(r.height * dpr);
        if (w && (c.width !== w || c.height !== h)) Object.assign(c, { width: w, height: h });
        drawScene(c.getContext("2d")!, c.width, c.height, live.current);
      }
      if (vv) {
        const t = fmt(vv.currentTime, "cs");
        if (srcTimeRef.current) srcTimeRef.current.textContent = t;
        if (stageTimeRef.current) stageTimeRef.current.textContent = t;
        if (sliderRef.current && document.activeElement !== sliderRef.current) sliderRef.current.value = String(vv.currentTime);
        // keep the logged model in step with what the video element actually shows
        const r = rec.current;
        if (r && r.key.playing && !vv.paused && !vv.seeking && Math.abs(vv.currentTime - (r.key.pos + (now() - r.key.t) * r.key.rate)) > 0.12) logV();
      }
      const rt = fmt(rec.current ? now() : (resume?.audio ?? 0));
      for (const el of recTimeRefs.current) if (el) el.textContent = rt;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // ---- keyboard: Space play/pause, C clear ----
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "SELECT" || confirm || e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (live.current.mode === "video") toggle();
      } else if (e.key === "c" || e.key === "C") {
        if (!resumePrep) clearLayer(live.current.mode);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  // ---- proxy (working copy) ----
  const makeProxy = async () => {
    restorePos.current = vref.current?.currentTime ?? 0;
    setProxy(0);
    setVideoError(null);
    const un = await listen<number>("proxy-progress", (e) => setProxy(e.payload));
    try {
      setPlayPath(await api.makeProxy(video));
    } catch (e) {
      setVideoError(errText(e));
    } finally {
      un();
      setProxy(null);
    }
  };
  const onVideoError = () => {
    if (playPath === video.path && proxy === null && phase === "prep") makeProxy();
    else setVideoError("この動画を再生できません。別の動画を選び直してください。");
  };

  // ---- start / finish / abort ----
  const start = async () => {
    if (!mic.ok) return setError("マイクが使えないため収録を開始できません。右の「音声」でマイクの接続と選択を確認してください。");
    if (videoError || proxy !== null) return;
    setError(null);
    const vv = v();
    let dir = "";
    try {
      let base = 0;
      let events: Ev[] = [];
      if (resume) {
        dir = resume.dir;
        base = await api.audioLen(dir);
        // Operations saved after the last recovered audio never "happened" in the finished video.
        // Drop them from the log on disk too, or they would replay once the timeline grows past them.
        events = resume.events.filter((e) => e.t <= base);
        await api.rewriteEvents(dir, events.map((e) => JSON.stringify(e) + "\n").join(""));
      } else dir = await api.sessionCreate({ video: { ...video, playPath }, gains });
      await api.recStart(dir);
      rec.current = { dir, base, perf0: performance.now(), key: { t: base, pos: vv.currentTime, playing: false, rate: vv.playbackRate }, pending: [], events };
    } catch (e) {
      if (!resume && dir) await api.discard(prev?.dir ?? null).catch(() => {});
      return setError(errText(e));
    }
    const L = live.current;
    if (!resume) {
      L.strokes = [];
      L.boardUndo = [];
      log({ k: "init", t: 0, pos: vv.currentTime, mode: L.mode, pieces: L.pieces, dir: L.dir });
      if (!vv.paused) logV();
    } else logV(); // re-anchor: the restored video is paused at the interruption point
    setPhase("recording");
    flush();
  };

  /** `notice`: why recording stopped on its own (shown on the review screen). */
  const finish = async (notice?: string) => {
    const r = rec.current;
    if (!r || finishing.current) return;
    finishing.current = true;
    setPhase("finishing");
    vref.current?.pause();
    try {
      await flush();
      await api.recStop();
      const [wav, duration] = await api.finalize(r.dir);
      if (prev) await api.discard(r.dir); // the new take is complete: drop the previous one
      rec.current = null;
      onDone({ dir: r.dir, wav, duration, events: r.events, video: { ...video, playPath }, gains }, notice);
    } catch (e) {
      keepOnExit.current = true; // data is on disk: a normal quit must not delete it
      setError(`${notice ? notice + "。" : ""}収録を確定できませんでした（${errText(e)}）。収録データは保存されています。空き容量などを確認してからアプリを再起動すると、復旧できます。`);
    }
  };
  finishRef.current = finish;

  const abort = async () => {
    setConfirm(null);
    if (rec.current) {
      await api.recStop().catch(() => {});
      rec.current = null;
      await api.discard(prev?.dir ?? null).catch(() => {});
    }
    onBack();
  };

  const back = () => (recording ? setConfirm("abort") : onBack());

  // ---- view ----
  const status = !recording
    ? { cls: "idle", text: phase === "finishing" ? "確定中…" : resumePrep ? "再開待ち・未録音" : "準備中・未録音" }
    : !mic.ok
      ? { cls: "rec", text: "録音エラー" }
      : mode === "board"
        ? { cls: "rec", text: "録音中・ボード表示" }
        : playing
          ? { cls: "rec", text: "録音中・映像再生" }
          : { cls: "rec", text: "録音中・映像停止" };
  const lvlLabel = !mic.ok ? "—" : level < 0.01 ? "無音" : level > 0.95 ? "大きすぎ" : "正常";
  const recTime = (i: number) => (el: HTMLElement | null) => void (recTimeRefs.current[i] = el);

  return (
    <div className="rec-screen">
      <header className="app-header">
        <div className="hdr-left">
          <button className="icon-btn" onClick={back} aria-label="戻る">
            ←
          </button>
          <img src={logo} className="hdr-logo" alt="さといも" />
          <div className="proj">
            <b title={video.name}>{stem(video.name)}</b>
            <span className={save === "error" ? "save-err" : ""}>
              {save === "error" ? "⚠ 保存に失敗しました（再試行中）" : save === "saved" ? "ローカル保存済み" : recording ? "保存中…" : "未収録"}
            </span>
          </div>
        </div>
        <div className="hdr-center">
          <span className={"status-chip " + status.cls}>
            <i />
            {status.text}
          </span>
          <b className="rec-clock" ref={recTime(0)} title="収録時間">
            00:00:00
          </b>
        </div>
        <div className="hdr-right">
          <button className="btn" onClick={() => setToolsOpen((o) => !o)}>
            {toolsOpen ? "ツールを閉じる" : "ツールを開く"}
          </button>
          {phase === "prep" ? (
            <button className="btn rec-start" onClick={start} disabled={!mic.ok || !!videoError || proxy !== null}>
              ● {resume ? "収録を再開" : "収録を開始"}
            </button>
          ) : (
            <HoldButton disabled={phase === "finishing"} onDone={finish} onShort={() => flashHint("終了するには1秒長押ししてください")} />
          )}
        </div>
      </header>

      <div className="rec-body">
        <main className="rec-main">
          <div className="source-row">
            <div className="source-chip" title={video.path}>
              <span className="src-ico">▣</span>
              <b>{video.name}</b>
              {phase === "prep" && !resume && (
                <button className="link" onClick={onChangeVideo}>
                  変更
                </button>
              )}
            </div>
            <div className="seg-toggle" role="tablist" aria-label="表示切替">
              <button role="tab" aria-selected={mode === "video"} className={mode === "video" ? "on" : ""} onClick={() => setMode("video")} disabled={resumePrep}>
                動画
              </button>
              <button role="tab" aria-selected={mode === "board"} className={mode === "board" ? "on" : ""} onClick={() => setMode("board")} disabled={resumePrep}>
                ボード
              </button>
            </div>
            <span className="record-hint">切替も完成動画に記録されます</span>
          </div>

          <div className="stage-wrap">
            <div className={"stage" + (mode === "board" ? " board" : "")}>
              <video
                ref={vref}
                src={src(playPath)}
                preload="auto"
                style={{ visibility: mode === "video" ? "visible" : "hidden" }}
                onLoadedMetadata={(e) => {
                  e.currentTarget.volume = gains.source;
                  e.currentTarget.playbackRate = rate;
                  if (restorePos.current !== null) e.currentTarget.currentTime = restorePos.current;
                  restorePos.current = null;
                }}
                onEnded={() => {
                  setPlaying(false);
                  logV();
                }}
                onError={onVideoError}
              />
              <canvas ref={cref} className={"overlay " + (tool === "pen" ? "pen" : mode === "board" ? "grab" : "")} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
              <div className="stage-chip">
                {resumePrep ? (
                  <>
                    <span className="dot blue" />
                    中断前の状態を復元しました・「収録を再開」で録音します
                  </>
                ) : mode === "board" ? (
                  <>
                    <span className="dot red" />
                    ボード表示中{recording ? "・実況は継続" : ""}
                  </>
                ) : playing ? (
                  <>
                    <span className="red">▶</span>再生中
                  </>
                ) : (
                  <>
                    <span className="red">Ⅱ</span>映像停止中・描画できます
                  </>
                )}
              </div>
              {mode === "video" && (
                <span className="stage-label">
                  元動画 <span ref={stageTimeRef}>00:00:00.00</span>
                </span>
              )}
              {hint && <div className="stage-hint">{hint}</div>}
              {proxy !== null && (
                <div className="stage-cover">
                  <div className="spinner" />
                  <b>作業用動画を作成しています… {Math.round(proxy * 100)}%</b>
                  <span>この動画は直接再生できない、または重いため、収録用の軽い動画を作っています。元動画の画質は書き出しで保たれます。</span>
                </div>
              )}
              {videoError && (
                <div className="stage-cover error">
                  <b>動画を再生できません</b>
                  <span>{videoError}</span>
                  {!resume && (
                    <button className="btn primary" onClick={onChangeVideo}>
                      動画を選び直す
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {mode === "video" ? (
            <div className="transport card">
              <div className="tl-row">
                <b ref={srcTimeRef}>00:00:00.00</b>
                <input
                  ref={sliderRef}
                  type="range"
                  min={0}
                  max={video.duration}
                  step={0.01}
                  defaultValue={0}
                  aria-label="元動画の位置"
                  disabled={resumePrep}
                  onChange={(e) => seek(+e.currentTarget.value, false)}
                  onPointerUp={(e) => seek(+e.currentTarget.value)}
                  onKeyUp={(e) => seek(+e.currentTarget.value)}
                />
                <span className="muted">{fmt(video.duration, "cs")}</span>
              </div>
              <div className="pb-row">
                <div className="seek-btns">
                  <button className="btn sq" onClick={() => seek(v().currentTime - 10)} disabled={resumePrep}>
                    −10
                  </button>
                  <button className="btn sq" onClick={() => seek(v().currentTime - 5)} disabled={resumePrep}>
                    −5
                  </button>
                  <button className="play-btn" onClick={toggle} disabled={resumePrep} aria-label={playing ? "停止" : "再生"}>
                    {playing ? "❚❚" : "▶"}
                  </button>
                  <button className="btn sq" onClick={() => seek(v().currentTime + 5)} disabled={resumePrep}>
                    ＋5
                  </button>
                  <button className="btn sq" onClick={() => seek(v().currentTime + 10)} disabled={resumePrep}>
                    ＋10
                  </button>
                </div>
                <div className="frame-btns">
                  <button className="btn sq muted-btn" onClick={() => step(-1)} disabled={resumePrep}>
                    ‹ 1f
                  </button>
                  <button className="btn sq muted-btn" onClick={() => step(1)} disabled={resumePrep}>
                    1f ›
                  </button>
                </div>
                <div className="speed" role="group" aria-label="再生速度">
                  {SPEEDS.map((s) => (
                    <button key={s} className={rate === s ? "on" : ""} aria-pressed={rate === s} onClick={() => setRate(s)} disabled={resumePrep}>
                      {s === 1 ? "1×" : s === 2 ? "2×" : s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="transport card board-bar">
              <div className="bb-inner">
                <div>
                  <b className="blue-title">{recording ? "ボードを完成動画に記録中" : "ボード表示（未録音）"}</b>
                  <b className="small-b">元動画は {fmt(frozenPos, "cs")} で停止中です</b>
                  <span className="muted small">選手・ディスクの移動と描画が記録されます</span>
                </div>
                <button className="btn primary" onClick={() => setMode("video")} disabled={resumePrep}>
                  動画へ戻る
                </button>
              </div>
            </div>
          )}
        </main>

        {toolsOpen && (
          <aside className="tools">
            <div className="tools-head">
              <h2>収録ツール</h2>
              <span className="muted tiny">マイクは収録中ロック</span>
            </div>
            <section className="card tcard">
              <div className="tc-head">
                <b>音声</b>
                {recording && <span title="収録中は変更できません">🔒 ロック中</span>}
              </div>
              <select
                className="mic-select"
                value={micId}
                disabled={phase !== "prep"}
                onChange={(e) => {
                  setMicId(e.target.value);
                  openMic(e.target.value || null);
                }}
                aria-label="マイク"
              >
                <option value="">既定のマイク{mic.ok && !micId ? `（${mic.msg}）` : ""}</option>
                {mics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {!mic.ok && (
                <div className="mic-error" role="alert">
                  {mic.msg}
                  {mic.msg !== "マイクを確認しています…" && <span className="muted">マイクの接続と、OSの設定でマイクの使用が許可されているかを確認してください。</span>}
                  {phase === "prep" && (
                    <button className="link" onClick={() => openMic(micId || null)}>
                      再試行
                    </button>
                  )}
                </div>
              )}
              <div className="meter-row">
                <span>入力</span>
                <div className="meter">
                  <div style={{ width: `${Math.min(100, level * 140)}%` }} className={level > 0.95 ? "hot" : ""} />
                </div>
                <b className={lvlLabel === "正常" ? "ok" : lvlLabel === "大きすぎ" ? "bad" : "muted"}>{lvlLabel}</b>
              </div>
              <label className="vol-row">
                <span>実況</span>
                <input type="range" min={0} max={1} step={0.05} value={gains.voice} onChange={(e) => setGains({ ...gains, voice: +e.target.value })} />
                <b>{Math.round(gains.voice * 100)}%</b>
              </label>
              <label className="vol-row">
                <span>元動画</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={gains.source}
                  onChange={(e) => {
                    setGains({ ...gains, source: +e.target.value });
                    if (vref.current) vref.current.volume = +e.target.value;
                  }}
                />
                <b>{Math.round(gains.source * 100)}%</b>
              </label>
            </section>

            <section className="card tcard">
              <b>描画</b>
              <div className="seg2">
                <button className={tool === "select" ? "on" : ""} onClick={() => setTool("select")} aria-pressed={tool === "select"}>
                  選択
                </button>
                <button className={tool === "pen" ? "on" : ""} onClick={() => setTool("pen")} aria-pressed={tool === "pen"}>
                  ペン
                </button>
              </div>
              <div className="color-row">
                <span>色</span>
                {PEN_COLORS.map((c) => (
                  <button key={c} className={"swatch" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} aria-label={`色 ${c}`} aria-pressed={color === c} />
                ))}
              </div>
              <div className="width-row">
                <span>太さ</span>
                {Object.entries(PEN_WIDTHS).map(([k, w]) => (
                  <button key={k} className={"btn xs" + (width === w ? " sel" : "")} onClick={() => setWidth(w)} aria-pressed={width === w}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="two">
                <button className="btn" onClick={undoStroke} disabled={resumePrep}>
                  ↶ 1つ戻す
                </button>
                <button className="btn danger" onClick={() => clearLayer(live.current.mode)} disabled={resumePrep}>
                  すべて消す
                </button>
              </div>
              <span className="muted tiny">{mode === "video" ? "動画は停止中のみ描画できます。再生すると描画は消えます" : "ボードではいつでも描画できます"}</span>
            </section>

            {mode === "video" ? (
              <section className="card state-card">
                <b className="blue-title">{!recording ? (resumePrep ? "収録の再開待ちです" : "収録前です") : playing ? "映像を再生中です" : "映像は停止中です"}</b>
                <b className="small-b">{recording ? "実況音声の収録は続いています" : `「${resume ? "収録を再開" : "収録を開始"}」を押すと録音が始まります`}</b>
                <span className="muted tiny">Spaceで再生／停止 ・ Cですべて消去</span>
                <div className="session-strip">
                  <span>収録時間</span>
                  <b ref={recTime(1)}>00:00:00</b>
                </div>
              </section>
            ) : (
              <section className="card tcard">
                <b>ボード</b>
                <div className="dir-row">
                  <span>攻撃方向</span>
                  <button className="link" onClick={toggleDir} disabled={resumePrep}>
                    {dir === 1 ? "→ 右" : "← 左"}（切替）
                  </button>
                </div>
                <div className="legend">
                  <span>
                    <i className="lg-off" />
                    オフェンス 7
                  </span>
                  <span>
                    <i className="lg-def" />
                    ディフェンス 7
                  </span>
                </div>
                <div className="two">
                  <button className="btn" onClick={boardUndo} disabled={resumePrep}>
                    配置を戻す
                  </button>
                  <button className="btn danger" onClick={() => setConfirm("reset")} disabled={resumePrep}>
                    ボードを初期化
                  </button>
                </div>
              </section>
            )}
            {video.fps > 31 && playPath === video.path && phase === "prep" && !resume && (
              <button className="link small" onClick={makeProxy} disabled={proxy !== null}>
                再生が重いときは作業用動画（720p・30fps）を作成
              </button>
            )}
          </aside>
        )}
      </div>

      {error && (
        <div className="toast error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {phase === "finishing" && !error && <Busy text="収録を確定しています…" />}
      {confirm === "abort" && (
        <Modal title="収録を中止しますか？" icon="!" danger onClose={() => setConfirm(null)}>
          <p className="modal-text">ここまでの収録は破棄されます。{prev ? "以前の収録確認画面に戻ります。" : ""}</p>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setConfirm(null)}>
              収録を続ける
            </button>
            <button className="btn danger-fill wide" onClick={abort}>
              破棄して戻る
            </button>
          </div>
        </Modal>
      )}
      {confirm === "reset" && (
        <Modal title="ボードを初期化しますか？" icon="!" onClose={() => setConfirm(null)}>
          <p className="modal-text">選手とディスクを既定の配置に戻します。描画は残ります。</p>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setConfirm(null)}>
              キャンセル
            </button>
            <button className="btn primary wide" onClick={boardReset}>
              初期化する
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function HoldButton({ onDone, onShort, disabled }: { onDone: () => void; onShort: () => void; disabled?: boolean }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef(0);
  const down = () => {
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      setHolding(false);
      onDone();
    }, 1000);
  };
  const up = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = 0;
    setHolding(false);
    onShort();
  };
  return (
    <button className={"hold-btn" + (holding ? " holding" : "")} disabled={disabled} onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
      onKeyDown={(e) => e.key === "Enter" && !e.repeat && down()}
      onKeyUp={(e) => e.key === "Enter" && up()}
      onClick={(e) => e.preventDefault()}>
      <span className="hold-fill" />
      <span className="hold-label">● 1秒長押しで終了</span>
    </button>
  );
}
