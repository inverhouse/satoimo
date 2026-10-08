import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { outputName, src, stem, type Done } from "./api.ts";
import { compile, fmt, sceneAt, segmentCount } from "./timeline.ts";
import { drawScene } from "./render.ts";
import { Modal, type CloseGuard } from "./App.tsx";
import logo from "./logo.png";

interface Props {
  done: Done;
  error?: string;
  notice?: string;
  folder: string | null;
  setFolder: (f: string) => void;
  guard: MutableRefObject<CloseGuard>;
  onExport: (folder: string) => void;
  onRedo: () => void;
  onHome: () => void;
}

/** Long paths: keep the end (the part people recognise). */
export const shortPath = (p: string, n = 34) => (p.length > n ? "…" + p.slice(-n) : p);

export default function Review({ done, error, notice, folder, setFolder, guard, onExport, onRedo, onHome }: Props) {
  const tl = useMemo(() => compile(done.events, done.duration, done.video.duration), [done]);
  const aref = useRef<HTMLAudioElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const cref = useRef<HTMLCanvasElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);
  const [boardShown, setBoardShown] = useState(tl.keys[0].mode === "board");
  const [modal, setModal] = useState<null | "folder" | "redo" | "home">(null);
  const playingRef = useRef(false);
  playingRef.current = playing;

  useEffect(() => {
    guard.current = () =>
      ask("書き出していない収録は破棄されます。終了しますか？", { title: "さといも", kind: "warning", okLabel: "破棄して終了", cancelLabel: "取り消す" });
  }, []);

  // Commentary audio is the master clock; the source video is slaved to the recorded timeline.
  useEffect(() => {
    let id = 0;
    const fd = 1 / done.video.fps;
    const tick = () => {
      const a = aref.current,
        v = vref.current,
        c = cref.current;
      if (a && v && c) {
        const t = a.currentTime;
        const s = sceneAt(tl, t);
        const want = playingRef.current && s.mode === "video" && s.playing;
        if (want) {
          if (v.playbackRate !== s.rate) v.playbackRate = s.rate;
          if (v.paused) {
            v.currentTime = s.pos;
            v.play().catch(() => {});
          } else if (!v.seeking && Math.abs(v.currentTime - s.pos) > 0.25) v.currentTime = s.pos;
        } else {
          if (!v.paused) v.pause();
          if (!v.seeking && Math.abs(v.currentTime - s.pos) > fd / 2) v.currentTime = s.pos;
        }
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr),
          h = Math.round(r.height * dpr);
        if (w && (c.width !== w || c.height !== h)) Object.assign(c, { width: w, height: h });
        drawScene(c.getContext("2d")!, c.width, c.height, s);
        setBoardShown(s.mode === "board");
        const txt = fmt(t, "cs");
        if (curRef.current) curRef.current.textContent = txt;
        if (labelRef.current) labelRef.current.textContent = fmt(t);
        if (sliderRef.current && document.activeElement !== sliderRef.current) sliderRef.current.value = String(t);
        if (a.ended && playingRef.current) setPlaying(false);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [tl]);

  useEffect(() => {
    const a = aref.current!;
    if (playing) {
      if (a.ended || a.currentTime >= done.duration - 0.05) a.currentTime = 0;
      a.play().catch(() => setPlaying(false));
    } else a.pause();
  }, [playing]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Space" && !modal) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [modal]);

  const exportClick = () => (folder ? onExport(folder) : setModal("folder"));
  const chooseFolder = async (thenExport: boolean) => {
    const f = await open({ directory: true, multiple: false, title: "保存先フォルダーを選択" });
    if (typeof f !== "string") return setModal(null); // cancelled: back to preview, nothing starts
    setFolder(f);
    setModal(null);
    if (thenExport) onExport(f);
  };

  return (
    <div className="review">
      <header className="app-header">
        <div className="hdr-left">
          <button className="icon-btn" onClick={() => setModal("home")} aria-label="ホームへ">
            ←
          </button>
          <img src={logo} className="hdr-logo" alt="さといも" />
          <div className="proj">
            <b title={done.video.name}>{stem(done.video.name)}</b>
            <span>収録確認</span>
          </div>
        </div>
        <div className="hdr-center">
          <span className="status-chip done">✓ 収録が完了しました</span>
        </div>
        <div className="hdr-right">
          <b className="page-label">プレビュー</b>
        </div>
      </header>
      <div className="review-body">
        <div className="review-main">
          <h1>完成動画を確認</h1>
          <p className="muted">声・映像操作・描画を、完成動画の時間に沿って再生します。</p>
          <div className="stage-wrap">
            <div className="stage">
              <video ref={vref} src={src(done.video.playPath)} preload="auto" style={{ visibility: boardShown ? "hidden" : "visible" }} onLoadedMetadata={(e) => (e.currentTarget.volume = done.gains.source)} />
              <canvas ref={cref} className="overlay" onClick={() => setPlaying((p) => !p)} />
              <audio ref={aref} src={src(done.wav)} preload="auto" onLoadedMetadata={(e) => (e.currentTarget.volume = Math.min(1, done.gains.voice))} />
              <div className="stage-chip">
                <span className="red">{playing ? "▶" : "Ⅱ"}</span>完成動画をプレビュー
              </div>
              {!playing && (
                <button className="big-play" onClick={() => setPlaying(true)} aria-label="再生">
                  ▶
                </button>
              )}
              <span className="stage-label">
                完成動画 <span ref={labelRef}>00:00:00</span>
              </span>
            </div>
          </div>
          <div className="card final-tl">
            <b>完成動画の時間</b>
            <div className="tl-row">
              <b ref={curRef}>00:00:00.00</b>
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={done.duration}
                step={0.01}
                defaultValue={0}
                aria-label="完成動画の位置"
                onChange={(e) => {
                  if (aref.current) aref.current.currentTime = +e.currentTarget.value;
                }}
              />
              <span className="muted">{fmt(done.duration, "cs")}</span>
            </div>
            <div className="pb-row">
              <button className="mini-play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "停止" : "再生"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <span className="small">再生 / 停止</span>
              <span className="muted tiny right">プレビュー中は編集できません</span>
            </div>
          </div>
        </div>
        <aside className="card summary">
          <div className="sum-head">
            <span className="check-badge">✓</span>
            <div>
              <b>収録が完了しました</b>
              <span className="muted tiny">書き出し時に保存先を選びます</span>
            </div>
          </div>
          <hr />
          <span className="muted small">完成動画の長さ</span>
          <b className="big-time">{fmt(done.duration)}</b>
          <div className="stats">
            <div>
              <b>{segmentCount(tl)}</b>
              <span>セグメント</span>
            </div>
            <div>
              <b>{tl.strokes.length}</b>
              <span>本の描画</span>
            </div>
          </div>
          <p className="small">停止や巻き戻しも、収録した順序で完成動画に反映されます。</p>
          <div className="format">MP4 ・ 1080p / 30fps</div>
          <div className="folder-card">
            <span className="muted tiny">保存先フォルダー</span>
            {folder ? (
              <>
                <b title={folder}>{shortPath(folder)}</b>
                <button className="link" onClick={() => chooseFolder(false)}>
                  変更
                </button>
              </>
            ) : (
              <>
                <b>未選択</b>
                <span className="muted small">書き出し時に選択します</span>
              </>
            )}
          </div>
          {notice && !error && (
            <div className="inline-error" role="alert">
              <b>収録が途中で止まりました</b>
              <span>{notice}</span>
              <span>止まるまでの収録を確認・書き出しできます。</span>
            </div>
          )}
          {error && (
            <div className="inline-error" role="alert">
              <b>書き出せませんでした</b>
              <span>{error}</span>
              <span>収録は保持されています。「MP4を書き出す」で再試行できます。</span>
            </div>
          )}
          <button className="btn primary export-btn" onClick={exportClick}>
            MP4を書き出す →
          </button>
          <button className="btn danger" onClick={() => setModal("redo")}>
            全体をやり直す
          </button>
        </aside>
      </div>

      {modal === "folder" && (
        <Modal title="保存先を選択してください" icon="!" onClose={() => setModal(null)}>
          <p className="modal-text">MP4を書き出す前に、保存先フォルダーを選んでください。</p>
          <p className="muted small">選択したフォルダーに完成動画を保存します。</p>
          <div className="out-file">
            <span className="muted tiny">出力ファイル</span>
            <b>{outputName(done.video)}</b>
          </div>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setModal(null)}>
              キャンセル
            </button>
            <button className="btn primary wide" onClick={() => chooseFolder(true)}>
              フォルダーを選ぶ →
            </button>
          </div>
        </Modal>
      )}
      {modal === "redo" && (
        <Modal title="全体をやり直しますか？" icon="!" danger onClose={() => setModal(null)}>
          <p className="modal-text">新しく収録し直します。新しい収録が完了すると、今の収録は失われます。</p>
          <p className="muted small">新しい収録を途中でやめた場合は、この画面に戻れます。</p>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setModal(null)}>
              キャンセル
            </button>
            <button className="btn danger-fill wide" onClick={onRedo}>
              やり直す
            </button>
          </div>
        </Modal>
      )}
      {modal === "home" && (
        <Modal title="ホームへ戻りますか？" icon="!" danger onClose={() => setModal(null)}>
          <p className="modal-text">書き出していない収録は破棄され、後から開き直すことはできません。</p>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setModal(null)}>
              キャンセル
            </button>
            <button className="btn danger-fill wide" onClick={onHome}>
              破棄してホームへ
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
