import { Icon } from "../components/Icon";
import { native } from "../native";
import type { Project, RecoveryCandidate } from "../types";

export function RecoveryScreen({ candidate, onRecovered, onError }: { candidate: RecoveryCandidate; onRecovered: (project: Project) => void; onError: (error: unknown) => void }) {
  return <main className="center-screen"><div className="recovery-card"><div className="recovery-icon">!</div><span className="eyebrow">RECOVERY</span><h1>中断された収録があります</h1><p>保存済みの音声と操作イベントを検査しました。データを復旧して確認するか、安全な場所へ退避して準備画面へ戻れます。</p><dl><div><dt>プロジェクト</dt><dd>{candidate.projectName}</dd></div><div><dt>有効なイベント</dt><dd>{candidate.validEventCount} 件</dd></div><div><dt>音声データ</dt><dd>{(candidate.audioBytes / 1_048_576).toFixed(1)} MB</dd></div></dl><div className="stack-actions"><button className="button primary" onClick={() => native.recoverTake(candidate.projectPath).then(onRecovered).catch(onError)}><Icon name="check" />復旧して確認</button><button className="button subtle" onClick={() => native.discardRecovery(candidate.projectPath).then(onRecovered).catch(onError)}>破棄して準備画面へ戻る</button></div><small>破棄したデータも recovery フォルダへ7日間保持されます。</small></div></main>;
}
