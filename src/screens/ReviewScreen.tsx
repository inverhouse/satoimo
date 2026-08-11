import { useEffect, useMemo, useRef, useState } from "react";
import { DrawingCanvas } from "../components/DrawingCanvas";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { buildStrokes, buildTimeline, segmentAtOutput, sourceAtOutput } from "../core/timeline";
import { formatTime } from "../core/time";
import { native } from "../native";
import type { Project, SessionEvent } from "../types";

export function ReviewScreen({ project, onRetry, onExport, onHome, onError }: { project: Project; onRetry: (p: Project) => void; onExport: () => void; onHome: () => void; onError: (e: unknown) => void }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [outputUs, setOutputUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const commentary = useRef<HTMLAudioElement>(null);
  const start = useRef({ at: 0, outputUs: 0 });
  const segments = useMemo(() => buildTimeline(events), [events]);
  const strokes = useMemo(() => buildStrokes(events), [events]);
  const durationUs = project.take?.durationUs ?? segments.reduce((m, s) => Math.max(m, s.outputStartUs + s.outputDurationUs), 0);

  useEffect(() => { native.loadEvents(project.projectPath).then(setEvents).catch(onError); }, [onError, project.projectPath]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min(durationUs, start.current.outputUs + (now - start.current.at) * 1000); setOutputUs(next);
      if (video.current) {
        const source = sourceAtOutput(segments, next) / 1_000_000;
        const segment = segmentAtOutput(segments, next);
        if (segment?.kind === "play") {
          video.current.playbackRate = segment.rate; video.current.volume = project.mix.sourceGain;
          if (Math.abs(video.current.currentTime - source) > .15) video.current.currentTime = source;
          if (video.current.paused) void video.current.play();
        } else {
          video.current.pause(); if (Math.abs(video.current.currentTime - source) > .045) video.current.currentTime = source;
        }
      }
      if (commentary.current && Math.abs(commentary.current.currentTime - next / 1_000_000) > .1) commentary.current.currentTime = next / 1_000_000;
      if (next >= durationUs) setPlaying(false); else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [durationUs, playing, project.mix.sourceGain, segments]);
  useEffect(() => { if (!playing) { video.current?.pause(); commentary.current?.pause(); } }, [playing]);
  const toggle = () => { const next = outputUs >= durationUs ? 0 : outputUs; if (!playing && outputUs >= durationUs) setOutputUs(0); start.current = { at: performance.now(), outputUs: next }; if (!playing && commentary.current) { commentary.current.currentTime = next / 1_000_000; commentary.current.volume = project.mix.microphoneGain; void commentary.current.play(); } setPlaying(!playing); };
  const scrub = (value: number) => { setPlaying(false); setOutputUs(value); if (video.current) video.current.currentTime = sourceAtOutput(segments, value) / 1_000_000; if (commentary.current) commentary.current.currentTime = value / 1_000_000; };
  const retry = async () => { setConfirm(false); try { onRetry(await native.abandonTake(project.projectPath)); } catch (error) { onError(error); } };

  return <main className="studio-screen review-screen"><audio ref={commentary} src={project.audioUrl} /><header className="studio-header"><div className="header-left"><button className="icon-button" aria-label="ホームへ戻る" onClick={onHome}><Icon name="home" /></button><div><b>{project.name}</b><small>収録確認</small></div></div><div className="review-title"><span className="check-dot"><Icon name="check" /></span><div><b>収録が完了しました</b><small>完成時間軸を確認してください</small></div></div><button className="button primary" onClick={onExport}><Icon name="export" />書き出す</button></header><section className="review-workspace"><div className="video-stage"><div className="video-shell"><video ref={video} src={project.mediaUrl} playsInline /><DrawingCanvas enabled={false} color="#fff" widthNormalized={0} strokes={strokes} sessionUs={outputUs} onStrokeBegin={() => undefined} onStrokePoint={() => undefined} onStrokeEnd={() => undefined} /></div></div><div className="review-controls"><div className="review-time"><b className="mono">{formatTime(outputUs)}</b><span>完成動画の時間</span><span className="mono muted">{formatTime(durationUs)}</span></div><input aria-label="完成動画タイムライン" className="wide-range" type="range" min={0} max={durationUs || 1} value={outputUs} step={1000} onChange={(e) => scrub(Number(e.target.value))} /><div className="review-buttons"><button className="play-button" aria-label={playing ? "停止" : "再生"} onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button><span>{segments.length} セグメント ・ 描画 {strokes.length} 本</span></div></div></section><footer className="review-footer"><div><b>このまま書き出せます</b><small>1920×1080 / 30fps / MP4</small></div><div><button className="button subtle" onClick={() => setConfirm(true)}>収録全体をやり直す</button><button className="button primary" onClick={onExport}><Icon name="export" />書き出す</button></div></footer>{confirm && <Modal title="収録全体をやり直しますか？" confirmLabel="やり直す" destructive onCancel={() => setConfirm(false)} onConfirm={() => void retry()}><p>現在の収録は、新しい収録が正常に完了するまで保持されます。</p></Modal>}</main>;
}
