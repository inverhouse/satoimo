import { Icon } from "../components/Icon";

export function CompleteScreen({ outputPath, onHome, onReveal }: { outputPath: string; onHome: () => void; onReveal: () => void }) {
  return <main className="center-screen"><div className="complete-card"><div className="complete-mark"><Icon name="check" /></div><span className="eyebrow">COMPLETE</span><h1>実況動画が完成しました</h1><p>MP4ファイルを書き出しました。Finder / Explorerで保存先を開いて確認できます。</p><div className="path-box"><Icon name="folder" /><span>{outputPath}</span></div><div className="stack-actions"><button className="button primary" onClick={onReveal}><Icon name="folder" />Finder / Explorerで表示</button><button className="button subtle" onClick={onHome}><Icon name="home" />ホームへ戻る</button></div></div></main>;
}
