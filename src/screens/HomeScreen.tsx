import { useState } from "react";
import { Icon } from "../components/Icon";
import { native } from "../native";
import type { Project } from "../types";

export function HomeScreen({ recent, onOpen, onError }: { recent: Project[]; onOpen: (project: Project) => void; onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    try {
      const source = await native.chooseSource(); if (!source) return;
      const parent = await native.chooseProjectDirectory(); if (!parent) return;
      setBusy(true);
      const base = source.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") || "新しい実況";
      onOpen(await native.createProject(source, parent, base));
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const open = async () => {
    try { const path = await native.chooseProject(); if (path) onOpen(await native.openProject(path)); } catch (error) { onError(error); }
  };
  return <main className="home-screen">
    <header className="home-header"><div className="brand"><div className="brand-mark">さ</div><div><h1>さといも</h1><p>動画に、伝わる実況を。</p></div></div><span className="local-badge">ローカル保存</span></header>
    <section className="hero">
      <div className="hero-copy"><span className="eyebrow">SPORTS COMMENTARY STUDIO</span><h2>プレーを止めて、<br /><em>考えを描く。</em></h2><p>練習動画を見ながら声と線を記録。再生、巻き戻し、静止した時間まで、そのまま一本の解説動画になります。</p></div>
      <div className="launch-card">
        {!native.isDesktop && <div className="notice">ブラウザ表示では画面を確認できます。動画・マイク操作はデスクトップ版で利用できます。</div>}
        <button className="button primary large" onClick={create} disabled={busy || !native.isDesktop}><Icon name="new" />{busy ? "動画を解析中…" : "新しい実況を作成"}</button>
        <button className="button secondary large" onClick={open} disabled={!native.isDesktop}><Icon name="folder" />プロジェクトを開く</button>
        <div className="feature-strip"><span><b>01</b> 動画を選ぶ</span><i /><span><b>02</b> 声と線を記録</span><i /><span><b>03</b> MP4へ書き出し</span></div>
      </div>
    </section>
    <section className="recent-section">
      <div className="section-heading"><h3>最近使ったプロジェクト</h3><span>{recent.length} 件</span></div>
      {recent.length ? <div className="recent-list">{recent.slice(0, 8).map((project) => <button key={project.projectId} className="project-row" onClick={() => native.openProject(project.projectPath).then(onOpen).catch(onError)}><div className="project-thumb"><Icon name="play" /></div><span><b>{project.name}</b><small>{new Date(project.updatedAt).toLocaleString("ja-JP")} ・ {project.take ? "収録済み" : "準備中"}</small></span><span className="arrow">›</span></button>)}</div> : <div className="empty-recent"><Icon name="folder" /><p>まだプロジェクトはありません</p><small>最初の実況を作成すると、ここからすぐに再開できます。</small></div>}
    </section>
    <footer><span>さといも 0.1.0</span><span>動画と音声は外部へ送信されません</span></footer>
  </main>;
}
