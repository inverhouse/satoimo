import { useCallback, useEffect, useState } from "react";
import { native } from "./native";
import { CompleteScreen } from "./screens/CompleteScreen";
import { ExportScreen } from "./screens/ExportScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { RecordScreen } from "./screens/RecordScreen";
import { RecoveryScreen } from "./screens/RecoveryScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { ProxyScreen } from "./screens/ProxyScreen";
import type { Project, RecoveryCandidate, Screen } from "./types";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [project, setProject] = useState<Project | null>(null);
  const [recent, setRecent] = useState<Project[]>([]);
  const [recovery, setRecovery] = useState<RecoveryCandidate | null>(null);
  const [outputPath, setOutputPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((value: unknown) => setError(value instanceof Error ? value.message : String(value)), []);

  useEffect(() => {
    if (!native.isDesktop) return;
    native.recoveryCandidates().then((items) => { if (items[0]) { setRecovery(items[0]); setScreen("recovery"); } }).catch(onError);
    native.recentProjects().then(setRecent).catch(() => undefined);
  }, [onError]);

  const open = (next: Project) => { setProject(next); setScreen(next.take ? "review" : next.proxy.status === "needed" ? "proxy" : "record"); };
  const home = () => { setScreen("home"); setProject(null); if (native.isDesktop) native.recentProjects().then(setRecent).catch(onError); };
  const exportStart = async () => {
    if (!project) return;
    const sourceName = project.source.absolutePath.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? project.name;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
    try { const path = await native.chooseExportPath(`${sourceName}_commentary_${stamp}.mp4`); if (path) { setOutputPath(path); setScreen("export"); } } catch (e) { onError(e); }
  };

  return <>{screen === "home" && <HomeScreen recent={recent} onOpen={open} onError={onError} />}{screen === "recovery" && recovery && <RecoveryScreen candidate={recovery} onRecovered={open} onError={onError} />}{screen === "proxy" && project && <ProxyScreen project={project} onComplete={(p)=>{setProject(p);setScreen("record");}} onCancel={home} onError={onError} />}{screen === "record" && project && <RecordScreen project={project} onProject={setProject} onHome={home} onFinished={(p) => { setProject(p); setScreen("review"); }} onProxyNeeded={(p) => { setProject(p); setScreen("proxy"); }} onError={onError} />}{screen === "review" && project && <ReviewScreen project={project} onRetry={(p) => { setProject(p); setScreen("record"); }} onExport={() => void exportStart()} onHome={home} onError={onError} />}{screen === "export" && project && <ExportScreen project={project} outputPath={outputPath} onComplete={() => setScreen("complete")} onCancel={() => setScreen("review")} onError={onError} />}{screen === "complete" && <CompleteScreen outputPath={outputPath} onHome={home} onReveal={() => native.reveal(outputPath).catch(onError)} />}{error && <div className="error-toast" role="alert"><div><b>操作を完了できませんでした</b><span>{error}</span><small>データは保持されています。内容を確認して、もう一度お試しください。</small></div><button aria-label="エラーを閉じる" onClick={() => setError(null)}>×</button></div>}</>;
}
