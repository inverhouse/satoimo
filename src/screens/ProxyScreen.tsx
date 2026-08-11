import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { displayedExportPercent } from "../core/exportProgress";
import { native } from "../native";
import type { ExportProgress, Project } from "../types";

export function ProxyScreen({ project, onComplete, onCancel, onError }: { project: Project; onComplete: (project: Project) => void; onCancel: () => void; onError: (e: unknown) => void }) {
  const [started, setStarted] = useState(false); const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({ percent: 0, elapsedUs: 0, remainingUs: null, outputPath: "proxy/source-proxy.mp4" });
  useEffect(() => { let unlisten: (()=>void)|undefined; native.onProxyProgress(setProgress).then((fn)=>unlisten=fn); return()=>unlisten?.(); }, []);
  const create = async () => { setStarted(true); try { onComplete(await native.createProxy(project.projectPath)); } catch(error) { setStarted(false); onError(error); } };
  const cancel = async () => { setCanceling(true); try { await native.cancelProxy(); setCanceling(false); setStarted(false); } catch(error) { setCanceling(false); onError(error); } };
  const fps = project.source.fpsNumerator / project.source.fpsDenominator;
  const shownPercent = displayedExportPercent(progress.percent);
  return <main className="center-screen"><div className="export-card"><div className="export-art"><span>{started ? `${shownPercent}%` : <Icon name="play" />}</span><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" /><circle className="progress-ring" cx="60" cy="60" r="52" pathLength="100" strokeDasharray="100" strokeDashoffset={100-shownPercent} /></svg></div><span className="eyebrow">PLAYBACK PROXY</span><h1>再生用動画を準備します</h1><p>この素材は、そのままでは正確なシークが保証できません。元動画は変更せず、プロジェクト内に1080p・60fpsの再生用コピーを作成します。</p><div className="export-stats"><div><small>元の解像度</small><b>{project.source.width}×{project.source.height}</b></div><div><small>フレームレート</small><b>{fps.toFixed(2)} fps</b></div></div>{started ? <button className="button subtle" disabled={canceling} onClick={()=>void cancel()}>{canceling ? "キャンセル中…" : "作成をキャンセル"}</button> : <div className="stack-actions"><button className="button primary" onClick={()=>void create()}>プロキシを作成</button><button className="button subtle" onClick={onCancel}>ホームへ戻る</button></div>}<small className="hint">完了前のファイルは .part として保存され、キャンセル時に削除されます。</small></div></main>;
}
