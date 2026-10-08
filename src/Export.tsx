import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, baseName, errText, outputName, stem, type Done } from "./api.ts";
import { compile, overlayKey, sceneAt } from "./timeline.ts";
import { drawScene } from "./render.ts";
import { type CloseGuard } from "./App.tsx";
import { shortPath } from "./Review.tsx";
import logo from "./logo.png";

const FPS = 30;
const PREP = 0.15; // share of the progress bar used by overlay rendering

/** Renders one PNG per distinct overlay state (same renderer as the preview). */
async function renderOverlays(done: Done, cancelled: () => boolean, progress: (r: number) => void) {
  const tl = compile(done.events, done.duration, done.video.duration);
  const canvas = new OffscreenCanvas(1920, 1080);
  const ctx = canvas.getContext("2d")!;
  await document.fonts.load('700 12px "Noto Sans JP Variable"');
  const frames = Math.ceil(done.duration * FPS);
  const overlays: { frame: number; file: string | null }[] = [];
  let prev: string | null = null;
  for (let f = 0; f < frames; f++) {
    const s = sceneAt(tl, f / FPS);
    const key = overlayKey(s);
    if (key !== prev) {
      prev = key;
      if (!key) overlays.push({ frame: f, file: null });
      else {
        drawScene(ctx, 1920, 1080, s);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const file = await api.writeOverlay(`ov_${f}.png`, new Uint8Array(await blob.arrayBuffer()));
        overlays.push({ frame: f, file });
      }
    }
    if (f % 600 === 0) {
      if (cancelled()) return null;
      progress(f / frames);
      await new Promise((r) => setTimeout(r)); // keep the UI (and Cancel) responsive
    }
  }
  return { tl, overlays };
}

export function Exporting({ done, folder, guard, onBack, onComplete }: { done: Done; folder: string; guard: MutableRefObject<CloseGuard>; onBack: (error?: string) => void; onComplete: (path: string) => void }) {
  const [ratio, setRatio] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const cancelled = useRef(false);
  const finished = useRef<(r: { Ok?: string; Err?: string }) => void>(() => {});
  const t0 = useRef(performance.now());

  useEffect(() => {
    const t = setInterval(() => setElapsed((performance.now() - t0.current) / 1000), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const unP = listen<{ phase: string; ratio: number }>("export-progress", (e) => {
      const { phase, ratio } = e.payload;
      setRatio(phase === "audio" ? PREP + ratio * 0.05 : phase === "video" ? PREP + 0.05 + ratio * (0.99 - PREP - 0.05) : 0.99);
    });
    const done$ = new Promise<{ Ok?: string; Err?: string }>((res) => (finished.current = res));
    const unD = listen<{ Ok?: string; Err?: string }>("export-done", (e) => finished.current(e.payload));
    (async () => {
      try {
        await api.exportWorkDir();
        const r = await renderOverlays(done, () => cancelled.current, (x) => setRatio(x * PREP));
        if (!r || cancelled.current) return alive && onBack();
        await api.exportStart({
          source: done.video.path,
          srcFps: done.video.fps,
          srcDuration: done.video.duration,
          hasAudio: done.video.hasAudio,
          colorTagged: !!done.video.colorTagged,
          commentary: done.wav,
          duration: done.duration,
          segs: r.tl.keys.map((k) => ({ t: k.t, pos: k.pos, playing: k.playing, rate: k.rate, board: k.mode === "board" })),
          overlays: r.overlays,
          outDir: folder,
          fileName: outputName(done.video),
          voiceGain: done.gains.voice,
          sourceGain: done.gains.source,
        });
        const res = await done$;
        if (!alive) return;
        if (res.Ok) onComplete(res.Ok);
        else onBack(res.Err === "cancelled" ? undefined : res.Err);
      } catch (e) {
        if (alive) onBack(errText(e));
      }
    })();
    return () => {
      alive = false;
      unP.then((f) => f());
      unD.then((f) => f());
    };
  }, []);

  useEffect(() => {
    guard.current = async () => {
      const ok = await ask("書き出しを中止して終了しますか？ 書き出していない収録は破棄されます。", { title: "さといも", kind: "warning", okLabel: "中止して終了", cancelLabel: "取り消す" });
      if (ok) {
        cancelled.current = true;
        await api.exportCancel();
        await new Promise((r) => setTimeout(r, 800)); // let ffmpeg children be killed
      }
      return ok;
    };
  }, []);

  const cancel = async () => {
    setCancelling(true);
    cancelled.current = true;
    await api.exportCancel();
  };

  const pct = Math.floor(ratio * 100);
  const remain = ratio > 0.03 ? (elapsed * (1 - ratio)) / ratio : null;
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const R = 70,
    C = 2 * Math.PI * R;
  return (
    <div className="center-screen">
      <SimpleHeader done={done} step="書き出し中" status="● 書き出し中" />
      <div className="glow" />
      <div className="center-card">
        <svg className="ring" width="154" height="154" viewBox="0 0 154 154" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <circle cx="77" cy="77" r={R} className="ring-track" />
          <circle cx="77" cy="77" r={R} className="ring-value" strokeDasharray={C} strokeDashoffset={C * (1 - ratio)} />
          <text x="77" y="88" textAnchor="middle">
            {pct}%
          </text>
        </svg>
        <h1>{cancelling ? "キャンセルしています…" : "動画を書き出しています"}</h1>
        <p className="muted">完成動画を作成しています。完了までお待ちください。</p>
        <p className="muted small">処理中はウィンドウを閉じないでください。</p>
        <div className="two-stats">
          <div>
            <span className="muted small">経過時間</span>
            <b>{mmss(elapsed)}</b>
          </div>
          <div>
            <span className="muted small">残り時間の目安</span>
            <b>{remain === null ? "計算中" : mmss(remain)}</b>
          </div>
        </div>
        <div className="save-box">
          <span className="muted small">保存先フォルダー</span>
          <b title={folder}>{shortPath(folder, 48)}</b>
          <span className="muted tiny">{outputName(done.video)} を作成しています</span>
        </div>
        <button className="btn danger cancel-btn" onClick={cancel} disabled={cancelling}>
          書き出しをキャンセル
        </button>
      </div>
    </div>
  );
}

export function Complete({ done, path, folder, onHome }: { done: Done; path: string; folder: string; onHome: () => void }) {
  return (
    <div className="center-screen">
      <SimpleHeader done={done} step="書き出し完了" status="● 書き出し完了" />
      <div className="glow" />
      <div className="center-card done-card">
        <div className="success">✓</div>
        <h1>実況動画が完成しました</h1>
        <p className="muted">MP4の書き出しが完了しました。</p>
        <div className="save-box">
          <span className="muted small">完成したファイル</span>
          <b>{baseName(path)}</b>
          <span className="muted small" title={folder}>
            保存先：{shortPath(folder, 56)}
          </span>
        </div>
        <div className="two-btn">
          <button className="btn primary" onClick={() => revealItemInDir(path)}>
            保存先で表示
          </button>
          <button className="btn" onClick={onHome}>
            ホームへ戻る
          </button>
        </div>
      </div>
    </div>
  );
}

function SimpleHeader({ done, step, status }: { done: Done; step: string; status: string }) {
  return (
    <header className="app-header simple">
      <div className="hdr-left">
        <img src={logo} className="hdr-logo" alt="さといも" />
        <div className="proj">
          <b>{stem(done.video.name)}</b>
          <span>{step}</span>
        </div>
      </div>
      <span className="status-chip done">{status}</span>
    </header>
  );
}
