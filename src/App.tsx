import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, baseName, errText, type Done, type Found, type Meta, type VideoInfo } from "./api.ts";
import { parseEvents, fmt, type Ev } from "./timeline.ts";
import Record, { type Resume } from "./Record.tsx";
import Review from "./Review.tsx";
import { Complete, Exporting } from "./Export.tsx";
import logo from "./logo.png";

type Screen =
  | { s: "top" }
  | { s: "select" }
  | { s: "credits" }
  | { s: "record"; video: VideoInfo; resume?: Resume; prev?: Done }
  | { s: "review"; done: Done; error?: string; notice?: string }
  | { s: "export"; done: Done; folder: string }
  | { s: "complete"; done: Done; path: string; folder: string };

/** Returns true when it is OK to quit (screen-specific confirmation + cleanup). */
/** "keep": quit without deleting the session (it stays recoverable). */
export type CloseGuard = (() => Promise<boolean | "keep">) | null;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ s: "top" });
  const [found, setFound] = useState<Found | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "recover" | "start" | "exit" | "drop">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const guard = useRef<CloseGuard>(null);
  const live = useRef({ screen, found });
  live.current = { screen, found };

  // leftover session = abnormal termination last time
  useEffect(() => {
    if (screen.s === "top") api.find().then(setFound).catch(() => setFound(null));
    if (screen.s !== "record" && screen.s !== "review" && screen.s !== "export") guard.current = null;
  }, [screen.s]);

  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested(async (e) => {
      e.preventDefault();
      const { screen, found } = live.current;
      if (found && screen.s === "top") return setModal("exit");
      const g = guard.current ? await guard.current() : true;
      if (!g) return;
      if (g !== "keep") await api.discard(null, true).catch(() => {});
      await w.destroy();
    });
    return () => void un.then((f) => f());
  }, []);

  const home = async () => {
    await api.discard(null, true).catch(() => {});
    setFolder(null);
    setScreen({ s: "top" });
  };

  const recoverConfirm = async (f: Found) => {
    setModal(null);
    setBusy("記録済み部分を確定しています…");
    try {
      const meta: Meta = JSON.parse(f.meta);
      const [wav, duration] = await api.finalize(f.dir);
      setFound(null);
      setFolder(null);
      setScreen({ s: "review", done: { dir: f.dir, wav, duration, events: parseEvents(f.events), video: meta.video, gains: meta.gains } });
    } catch (e) {
      setFound({ ...f, error: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const recoverContinue = (f: Found) => {
    setModal(null);
    try {
      const meta: Meta = JSON.parse(f.meta);
      setFound(null);
      setFolder(null);
      setScreen({ s: "record", video: meta.video, resume: { dir: f.dir, events: parseEvents(f.events) as Ev[], audio: f.audio, gains: meta.gains } });
    } catch (e) {
      setFound({ ...f, error: errText(e) });
    }
  };

  const discardFound = async () => {
    const m = modal;
    setModal(null);
    await api.discard(null, true).catch(() => {});
    setFound(null);
    if (m === "start") setScreen({ s: "select" });
    if (m === "exit") await getCurrentWindow().destroy();
  };

  let body: ReactNode;
  switch (screen.s) {
    case "top":
      body = (
        <Top
          found={found}
          onStart={() => (found ? setModal("start") : setScreen({ s: "select" }))}
          onRecover={() => setModal(found?.error ? "drop" : "recover")}
          onCredits={() => setScreen({ s: "credits" })}
        />
      );
      break;
    case "select":
      body = <Select onBack={() => setScreen({ s: "top" })} onPicked={(video) => setScreen({ s: "record", video })} />;
      break;
    case "credits":
      body = <Credits onBack={() => setScreen({ s: "top" })} />;
      break;
    case "record":
      body = (
        <Record
          key={screen.video.path + (screen.resume?.dir ?? "")}
          video={screen.video}
          resume={screen.resume}
          prev={screen.prev}
          guard={guard}
          onDone={(done, notice) => setScreen({ s: "review", done, notice })}
          onBack={() => (screen.prev ? setScreen({ s: "review", done: screen.prev }) : screen.resume ? setScreen({ s: "top" }) : setScreen({ s: "select" }))}
          onChangeVideo={() => setScreen({ s: "select" })}
        />
      );
      break;
    case "review":
      body = (
        <Review
          done={screen.done}
          error={screen.error}
          notice={screen.notice}
          folder={folder}
          setFolder={setFolder}
          guard={guard}
          onExport={(f) => setScreen({ s: "export", done: screen.done, folder: f })}
          onRedo={() => setScreen({ s: "record", video: screen.done.video, prev: screen.done })}
          onHome={home}
        />
      );
      break;
    case "export":
      body = (
        <Exporting
          done={screen.done}
          folder={screen.folder}
          guard={guard}
          onBack={(error) => setScreen({ s: "review", done: screen.done, error })}
          onComplete={(path) => {
            api.discard(null, true).catch(() => {}); // the MP4 is the result; nothing left to recover
            setScreen({ s: "complete", done: screen.done, path, folder: screen.folder });
          }}
        />
      );
      break;
    case "complete":
      body = <Complete done={screen.done} path={screen.path} folder={screen.folder} onHome={home} />;
      break;
  }

  return (
    <>
      {body}
      {modal === "recover" && found && (
        <Modal onClose={() => setModal(null)} title="収録を復旧します" icon="↺">
          <p className="modal-text">
            {found.audio ? `記録済み ${fmt(found.audio)}` : ""}　復旧方法を選んでください。
          </p>
          <div className="recover-options">
            <button className="option" onClick={() => recoverConfirm(found)}>
              <b>記録済み部分を確定してプレビュー</b>
              <span>残っている音声と操作を一つの収録として確定し、収録確認へ進みます。</span>
            </button>
            <button className="option" onClick={() => recoverContinue(found)}>
              <b>中断地点から収録を続ける</b>
              <span>動画の位置・表示・ボードを中断前の状態に戻します。「収録を再開」を押すまで録音しません。</span>
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setModal(null)}>
              キャンセル
            </button>
          </div>
        </Modal>
      )}
      {(modal === "start" || modal === "exit" || modal === "drop") && (
        <Modal onClose={() => setModal(null)} title="未復旧の収録を破棄しますか？" icon="!" danger>
          <p className="modal-text">
            {modal === "start"
              ? "新しい収録を始めると、異常終了した収録データは破棄され、元に戻せません。"
              : modal === "exit"
                ? "復旧せずに終了すると、異常終了した収録データは破棄され、次回は復旧できません。"
                : "この収録データは復旧できないため、破棄します。"}
          </p>
          <div className="modal-actions">
            <button className="btn wide" onClick={() => setModal(null)}>
              取り消す
            </button>
            <button className="btn danger-fill wide" onClick={discardFound}>
              {modal === "start" ? "破棄して新しく始める" : modal === "exit" ? "破棄して終了" : "破棄する"}
            </button>
          </div>
        </Modal>
      )}
      {busy && <Busy text={busy} />}
    </>
  );
}

export function Modal(props: { title: string; icon?: string; danger?: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="dialog-head">
          {props.icon && <span className={"dialog-icon" + (props.danger ? " danger" : "")}>{props.icon}</span>}
          <h2>{props.title}</h2>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function Busy({ text, ratio }: { text: string; ratio?: number }) {
  return (
    <div className="backdrop busy">
      <div className="busy-card">
        <div className="spinner" />
        <p>{text}</p>
        {ratio !== undefined && <p className="muted">{Math.round(ratio * 100)}%</p>}
      </div>
    </div>
  );
}

function Top(props: { found: Found | null; onStart: () => void; onRecover: () => void; onCredits: () => void }) {
  const f = props.found;
  let name = "";
  try {
    name = f ? (JSON.parse(f.meta) as Meta).video.name : "";
  } catch {}
  return (
    <div className="top">
      {f && (
        <div className={"recover-banner" + (f.error ? " broken" : "")} role="alert">
          <span className="rb-icon">!</span>
          <div className="rb-text">
            <b>{f.error ? "前回の収録を復旧できません" : "前回の収録が途中で終了しています"}</b>
            <span>{f.error ? `${f.error}。データを破棄できます。` : `${name || "収録"}・記録済み ${fmt(f.audio)}`}</span>
          </div>
          <button className={"btn " + (f.error ? "danger" : "primary")} onClick={props.onRecover}>
            {f.error ? "破棄する" : "復旧する"}
          </button>
        </div>
      )}
      <img className="top-logo" src={logo} alt="さといも" />
      <button className="start-circle" onClick={props.onStart}>
        はじめる
      </button>
      <button className="credits-link" onClick={props.onCredits}>
        CREDITS ›
      </button>
    </div>
  );
}

const VIDEO_EXT = ["mp4", "mov", "m4v", "mkv", "avi", "webm", "mts", "m2ts", "wmv", "MP4", "MOV"];

function Select(props: { onBack: () => void; onPicked: (v: VideoInfo) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pick = async () => {
    setError(null);
    const path = await open({ multiple: false, directory: false, filters: [{ name: "動画", extensions: VIDEO_EXT }] });
    if (typeof path !== "string") return; // cancelled: stay here
    setLoading(true);
    try {
      const p = await api.probe(path);
      if (!(p.duration > 0)) throw "動画の長さを読み取れません。別の動画を選び直してください。";
      props.onPicked({ path, name: baseName(path), playPath: path, fps: p.fps, duration: p.duration, hasAudio: p.hasAudio, colorTagged: p.colorTagged });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="select">
      <button className="icon-btn back-corner" onClick={props.onBack} aria-label="戻る">
        ←
      </button>
      <img className="select-logo" src={logo} alt="さといも" />
      <h1>動画を選択してください</h1>
      <p className="muted">収録に使用する動画を1本選びます</p>
      <button className="pick-circle" onClick={pick} disabled={loading}>
        <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span>{loading ? "読み込み中…" : "動画を選ぶ"}</span>
      </button>
      {error && (
        <div className="inline-error" role="alert">
          <b>この動画は使用できません</b>
          <span>{error}</span>
          <span>「動画を選ぶ」から別の動画を選び直してください。</span>
        </div>
      )}
    </div>
  );
}

const MEMBERS = [{ name: "Tsubasa KAWAGISHI", affiliation: "筑波大学アルティメット同好会INVERHOUSE 42期", github: "tsusu0409" }];

function Credits({ onBack }: { onBack: () => void }) {
  return (
    <div className="credits">
      <button className="btn back-top" onClick={onBack}>
        ← トップへ
      </button>
      <img className="credits-logo" src={logo} alt="さといも" />
      <div className="kicker">CREDITS</div>
      <div className="accent" />
      <div className="credits-body">
        <section className="members">
          <h2>実装メンバー</h2>
          {MEMBERS.map((m, i) => (
            <div className="member" key={m.github}>
              <div className="member-main">
                <b>{m.name}</b>
                <span>{m.affiliation}</span>
                <button className="gh" onClick={() => openUrl(`https://github.com/${m.github}`)}>
                  GitHub @{m.github} ↗
                </button>
              </div>
              <span className="member-no">{String(i + 1).padStart(2, "0")}</span>
            </div>
          ))}
        </section>
        <div className="licenses">
          <section className="license">
            <span className="muted small">ライセンス</span>
            <b>MIT License</b>
            <span className="muted small">正式な文面は同梱の LICENSE を参照してください。</span>
          </section>
          <section className="license third">
            <span className="muted small">同梱ソフトウェア</span>
            <span>
              <b className="small-b">FFmpeg</b> — LGPL（x264 等の GPL 部品を含まないビルド）。
              <button className="link" onClick={() => openUrl("https://ffmpeg.org/legal.html")}>
                ライセンス
              </button>
            </span>
            <span>
              <b className="small-b">Noto Sans JP</b> — SIL Open Font License 1.1
            </span>
            <span className="muted small">詳細とソースの入手方法は THIRD_PARTY_NOTICES.md に記載しています。</span>
          </section>
        </div>
      </div>
    </div>
  );
}
