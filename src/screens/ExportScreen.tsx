import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { displayedExportPercent, isFinalizingExport } from "../core/exportProgress";
import { native } from "../native";
import type { ExportProgress, Project } from "../types";

const duration = (us: number | null) => us == null ? "計算中" : `${Math.floor(us / 60_000_000)}分 ${Math.floor((us % 60_000_000) / 1_000_000)}秒`;

export function ExportScreen({ project, outputPath, onComplete, onCancel, onError }: { project: Project; outputPath: string; onComplete: () => void; onCancel: () => void; onError: (e: unknown) => void }) {
  const [progress, setProgress] = useState<ExportProgress>({ percent: 0, elapsedUs: 0, remainingUs: null, outputPath });
  const [canceling, setCanceling] = useState(false);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    native.onExportProgress((p) => { if (!disposed) setProgress(p); }).then((fn) => unlisten = fn);
    native.exportVideo(project.projectPath, outputPath).then(() => { if (!disposed) onComplete(); }).catch((error) => { if (!disposed) { onError(error); onCancel(); } });
    return () => { disposed = true; unlisten?.(); };
  }, [onCancel, onComplete, onError, outputPath, project.projectPath]);
  const cancel = async () => { setCanceling(true); try { await native.cancelExport(); onCancel(); } catch (error) { setCanceling(false); onError(error); } };
  const finalizing = isFinalizingExport(progress.percent);
  const shownPercent = displayedExportPercent(progress.percent);
  return <main className="center-screen export-screen"><div className="export-card"><div className="export-art"><span>{shownPercent}%</span><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" /><circle className="progress-ring" cx="60" cy="60" r="52" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - shownPercent} /></svg></div><span className="eyebrow">EXPORTING</span><h1>{finalizing ? "動画ファイルを仕上げています" : "動画を書き出しています"}</h1><p>{finalizing ? "再生に必要な情報を確定しています。この処理が終わるまでお待ちください。" : "ウィンドウを閉じずにお待ちください。書き出し中も操作に応答します。"}</p><div className="export-stats"><div><small>経過時間</small><b>{duration(progress.elapsedUs)}</b></div><div><small>残り時間</small><b>{finalizing ? "仕上げ中" : duration(progress.remainingUs)}</b></div></div><div className="path-box"><Icon name="folder" /><span>{outputPath}</span></div><button className="button subtle" onClick={() => void cancel()} disabled={canceling}>{canceling ? "キャンセル中…" : "書き出しをキャンセル"}</button></div></main>;
}
