import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DrawingCanvas } from "../components/DrawingCanvas";
import { FrameHoldController, HoldController } from "../core/hold";
import { Icon } from "../components/Icon";
import { LevelMeter } from "../components/LevelMeter";
import { Transport } from "../components/Transport";
import { clampUs, formatTime } from "../core/time";
import { native } from "../native";
import { PLAYBACK_RATES, type InputDevice, type PlaybackRate, type Project, type RecordingState, type Stroke } from "../types";

export function RecordScreen({ project, onProject, onHome, onFinished, onProxyNeeded, onError }: { project: Project; onProject: (p: Project) => void; onHome: () => void; onFinished: (p: Project) => void; onProxyNeeded: (p: Project) => void; onError: (e: unknown) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<RecordingState>("PREPARING");
  const [sourceUs, setSourceUs] = useState(project.lastSourcePositionUs);
  const [rate, setRate] = useState<PlaybackRate>(1);
  const [seeking, setSeeking] = useState(false);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [level, setLevel] = useState({ rms: 0, peak: 0 });
  const [pen, setPen] = useState(true);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [sessionUs, setSessionUs] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [collapsed, setCollapsed] = useState(project.ui.rightPanelCollapsed);
  const [mix, setMix] = useState(project.mix);
  const [penStyle, setPenStyle] = useState(project.pen);
  const sessionStarted = useRef(0);
  const stopOnce = useRef(false);
  const interruptionOnce = useRef(false);
  const recording = state !== "PREPARING" && state !== "STARTING";
  const playing = state === "RECORDING_PLAYING";
  const fps = project.source.fpsNumerator / project.source.fpsDenominator || 30;
  const sourceUsRef = useRef(sourceUs); sourceUsRef.current = sourceUs;
  const playingRef = useRef(playing); playingRef.current = playing;
  const penWidths: ReadonlyArray<readonly [string, number]> = [["細", 4 / 1080], ["中", 8 / 1080], ["太", 12 / 1080]];

  useEffect(() => {
    native.inputDevices().then((items) => { setDevices(items); setDeviceId(items.find((d) => d.isDefault)?.id ?? items[0]?.id ?? ""); }).catch(onError);
    let unlisten: (() => void) | undefined;
    native.onMicLevel(setLevel).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => unlisten?.();
  }, [onError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    native.onRecordingError((message) => {
      if (interruptionOnce.current) return;
      interruptionOnce.current = true;
      video.current?.pause(); setState("FINALIZING"); onError(new Error(message));
      native.interruptSession(message.split(":")[0] || "device_error", sourceUsRef.current).then(onFinished).catch(onError);
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => unlisten?.();
  }, [onError, onFinished]);

  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(() => setSessionUs(Math.round((performance.now() - sessionStarted.current) * 1000)), 33);
    return () => window.clearInterval(interval);
  }, [recording]);

  useEffect(() => {
    const node = video.current; if (!node) return;
    node.currentTime = project.lastSourcePositionUs / 1_000_000;
    node.volume = mix.sourceGain;
  }, [project.lastSourcePositionUs, mix.sourceGain]);

  const append = useCallback(async (type: string, payload: Record<string, unknown>) => {
    try { return await native.appendEvent(type, payload, project.source.durationUs); } catch (error) { onError(error); throw error; }
  }, [onError, project.source.durationUs]);

  const start = async () => {
    if (!deviceId) { onError(new Error("利用できるマイクがありません。マイクを接続して再試行してください。")); return; }
    setState("STARTING");
    try {
      const updated = { ...project, mix, pen: penStyle, ui: { rightPanelCollapsed: collapsed }, lastSourcePositionUs: sourceUs };
      await native.saveProject(updated);
      await native.startSession(project.projectPath, deviceId, sourceUs, rate);
      sessionStarted.current = performance.now(); setSessionUs(0); setState("RECORDING_PAUSED"); onProject(updated);
    } catch (error) { setState("PREPARING"); onError(error); }
  };

  const toggle = useCallback(async () => {
    const node = video.current; if (!node) return;
    if (!recording) { node.paused ? await node.play() : node.pause(); return; }
    if (playing) {
      node.pause(); await append("pause", { sourceUs }); setState("RECORDING_PAUSED");
    } else {
      const visibleIds = strokes.filter((stroke) => stroke.hiddenAtUs == null).map((stroke) => stroke.id);
      if (visibleIds.length) {
        setStrokes((all) => all.map((stroke) => visibleIds.includes(stroke.id) ? { ...stroke, hiddenAtUs: sessionUs } : stroke));
        await append("stroke_hide", { strokeIds: visibleIds, reason: "play" });
      }
      await append("play", { sourceUs, rate }); node.playbackRate = rate; await node.play(); setState("RECORDING_PLAYING");
    }
  }, [append, playing, rate, recording, sessionUs, sourceUs, strokes]);

  const seek = useCallback(async (deltaUs: number, method: string) => {
    const node = video.current; if (!node) return;
    const from = Math.round(node.currentTime * 1_000_000); const to = clampUs(from + deltaUs, project.source.durationUs);
    setSeeking(true); node.currentTime = to / 1_000_000; setSourceUs(to);
    if (recording) await append("seek", { fromSourceUs: from, toSourceUs: to, continuesPlaying: playing, method });
  }, [append, playing, project.source.durationUs, recording]);

  const scrub = useCallback(async (to: number) => {
    const node = video.current; if (!node) return;
    const from = Math.round(node.currentTime * 1_000_000);
    if (!node.paused) node.pause();
    if (recording && playing) { await append("pause", { sourceUs: from }); setState("RECORDING_SCRUB"); }
    node.currentTime = to / 1_000_000; setSourceUs(to); setSeeking(true);
    if (recording) { await append("seek", { fromSourceUs: from, toSourceUs: to, continuesPlaying: false, method: "scrub" }); setState("RECORDING_PAUSED"); }
  }, [append, playing, recording]);

  const changeRate = useCallback(async (next: PlaybackRate) => {
    const previous = rate; setRate(next); if (video.current) video.current.playbackRate = next;
    if (recording) await append("rate_change", { sourceUs, fromRate: previous, toRate: next, playing });
  }, [append, playing, rate, recording, sourceUs]);

  const finish = useCallback(async () => {
    if (stopOnce.current) return; stopOnce.current = true; setState("FINALIZING"); video.current?.pause();
    try { onFinished(await native.stopSession(sourceUsRef.current, playingRef.current)); } catch (error) { stopOnce.current = false; setState("RECORDING_PAUSED"); onError(error); }
  }, [onError, onFinished]);

  const holder = useMemo(() => new HoldController(1000, setHoldProgress, finish), [finish]);
  useEffect(() => () => holder.cancel(), [holder]);

  const seekRef = useRef(seek); seekRef.current = seek;
  const frameHolder = useMemo(() => new FrameHoldController(1000 / 15, (direction) => {
    void seekRef.current(direction * (1_000_000 / 30), "frame");
  }), []);
  useEffect(() => () => frameHolder.cancel(), [frameHolder]);

  const addStroke = (id: string, x: number, y: number) => {
    const point = { x, y, sessionUs, pressure: 1 }; setStrokes((all) => [...all, { id, color: penStyle.color, widthNormalized: penStyle.widthNormalized, startUs: sessionUs, points: [point] }]);
    void append("stroke_begin", { strokeId: id, x, y, color: penStyle.color, widthNormalized: penStyle.widthNormalized });
  };
  const addPoint = (id: string, x: number, y: number, pressure: number) => {
    setStrokes((all) => all.map((stroke) => stroke.id === id ? { ...stroke, points: [...stroke.points, { x, y, sessionUs, pressure }] } : stroke));
    void append("stroke_point", { strokeId: id, x, y, pressure });
  };
  const endStroke = (id: string, x: number, y: number) => void append("stroke_end", { strokeId: id, x, y });
  const hide = (clear: boolean) => {
    const visible = strokes.filter((s) => s.hiddenAtUs == null); const targets = clear ? visible : visible.slice(-1); if (!targets.length) return;
    const ids = targets.map((s) => s.id); setStrokes((all) => all.map((s) => ids.includes(s.id) ? { ...s, hiddenAtUs: sessionUs } : s));
    if (recording) void append("stroke_hide", { strokeIds: ids, reason: clear ? "clear" : "undo" });
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement; if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.key === " ") { event.preventDefault(); void toggle(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); if (event.repeat) return; if (command || event.shiftKey) void seek(-(command ? 10 : 1) * 1_000_000, command ? "jump_10s" : "step_1s"); else frameHolder.start(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); if (event.repeat) return; if (command || event.shiftKey) void seek((command ? 10 : 1) * 1_000_000, command ? "jump_10s" : "step_1s"); else frameHolder.start(1); }
      else if (event.key === "," && !playing) void seek(-1_000_000 / fps, "frame");
      else if (event.key === "." && !playing) void seek(1_000_000 / fps, "frame");
      else if (event.key === "[") void changeRate(PLAYBACK_RATES[Math.max(0, PLAYBACK_RATES.indexOf(rate) - 1)]);
      else if (event.key === "]") void changeRate(PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, PLAYBACK_RATES.indexOf(rate) + 1)]);
      else if (event.key === "\\") void changeRate(1);
      else if (event.key.toLowerCase() === "z" && command) hide(false);
      else if (event.key.toLowerCase() === "c") hide(true);
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") frameHolder.stop(-1);
      else if (event.key === "ArrowRight") frameHolder.stop(1);
    };
    const cancel = () => frameHolder.cancel();
    window.addEventListener("keydown", handler); window.addEventListener("keyup", release); window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", handler); window.removeEventListener("keyup", release); window.removeEventListener("blur", cancel); };
  });

  const togglePanel = () => { const next = !collapsed; setCollapsed(next); onProject({ ...project, ui: { rightPanelCollapsed: next } }); };
  const stateLabel = state === "PREPARING" ? "収録準備" : playing ? "録音中・映像再生" : state === "FINALIZING" ? "収録を保存中" : "録音中・映像停止";
  const mediaFailed = () => {
    if (state !== "PREPARING" || project.proxy.status === "ready") { onError(new Error("MEDIA_UNSUPPORTED: 動画の再生に失敗しました。")); return; }
    const updated: Project = { ...project, proxy: { ...project.proxy, status: "needed" } };
    native.saveProject(updated).then(() => onProxyNeeded(updated)).catch(onError);
  };

  return <main className="studio-screen">
    <header className="studio-header"><div className="header-left"><button className="icon-button" aria-label="ホームへ戻る" onClick={onHome} disabled={recording}><Icon name="back" /></button><div><b>{project.name}</b><small><span className="saved-dot" /> 自動保存済み</small></div></div><div className={`session-state ${recording ? "live" : ""}`}><span>{stateLabel}</span><b className="mono">{formatTime(sessionUs, 100).slice(0, -3)}</b></div><div className="header-actions"><button className="icon-button" aria-label={collapsed ? "右パネルを開く" : "右パネルを閉じる"} onClick={togglePanel}><Icon name="panel" /></button>{!recording ? <button className="button record-start" onClick={start} disabled={state === "STARTING"}><Icon name="mic" />{state === "STARTING" ? "準備中…" : "実況を開始"}</button> : <button className="button stop-hold" style={{ "--hold": holdProgress } as React.CSSProperties} onPointerDown={() => holder.start()} onPointerUp={() => holder.cancel()} onPointerCancel={() => holder.cancel()} onPointerLeave={() => holder.cancel()} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && holder.start()} onKeyUp={() => holder.cancel()}><span>1秒長押しで終了</span></button>}</div></header>
    <div className={`studio-body ${collapsed ? "collapsed" : ""}`}>
      <section className="video-column"><div className="video-stage"><div className="video-shell"><video ref={video} src={project.mediaUrl} playsInline onError={mediaFailed} onTimeUpdate={(e) => setSourceUs(Math.round(e.currentTarget.currentTime * 1_000_000))} onSeeked={() => setSeeking(false)} onEnded={() => { if (recording) { void append("pause", { sourceUs: project.source.durationUs }); setState("RECORDING_PAUSED"); } }} /><DrawingCanvas enabled={recording && !playing && pen} color={penStyle.color} widthNormalized={penStyle.widthNormalized} strokes={strokes} sessionUs={sessionUs} onStrokeBegin={addStroke} onStrokePoint={addPoint} onStrokeEnd={endStroke} />{!playing && <div className="paused-pill">{pen && recording ? "停止中・描画できます" : "映像停止中"}</div>}</div></div><Transport currentUs={sourceUs} durationUs={project.source.durationUs} fps={fps} playing={playing} rate={rate} recording={recording} seeking={seeking} onToggle={() => void toggle()} onSeek={(d, m) => void seek(d, m)} onScrub={(v) => void scrub(v)} onRate={(r) => void changeRate(r)} /></section>
      {collapsed ? <aside className="tool-rail"><button aria-label="パネルを開く" onClick={togglePanel}><Icon name="panel" /></button><button aria-label="ペン切替" className={pen ? "active" : ""} onClick={() => setPen(!pen)}><Icon name="pen" /></button><button aria-label="1つ戻す" onClick={() => hide(false)}><Icon name="undo" /></button><button aria-label="すべて消す" onClick={() => hide(true)}><Icon name="clear" /></button><span className="mic-ok"><Icon name="mic" /></span></aside> : <aside className="control-panel"><div className="panel-heading"><span>{recording ? "収録ツール" : "収録設定"}</span><button className="icon-button" aria-label="右パネルを閉じる" onClick={togglePanel}>×</button></div><section><label>マイク</label><select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={recording}>{devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><LevelMeter {...level} /><small className="hint">🎧 ヘッドホンの使用をおすすめします</small></section><section><label>音量バランス</label><div className="slider-label"><span>実況</span><b>{Math.round(mix.microphoneGain * 100)}%</b></div><input type="range" aria-label="実況音量" min="0" max="100" value={mix.microphoneGain * 100} disabled={recording} onChange={(e) => setMix({ ...mix, microphoneGain: Number(e.target.value) / 100 })} /><div className="slider-label"><span>元動画</span><b>{Math.round(mix.sourceGain * 100)}%</b></div><input type="range" aria-label="元動画音量" min="0" max="100" value={mix.sourceGain * 100} disabled={recording} onChange={(e) => { const sourceGain = Number(e.target.value) / 100; setMix({ ...mix, sourceGain }); if (video.current) video.current.volume = sourceGain; }} /></section><section><label>描画</label><button className={`pen-toggle ${pen ? "active" : ""}`} onClick={() => setPen(!pen)} disabled={playing}><Icon name="pen" />ペン {pen ? "ON" : "OFF"}</button><div className="swatches">{["#FF3B30", "#FFD60A", "#64D2FF", "#FFFFFF"].map((color) => <button key={color} aria-label={`ペン色 ${color}`} className={penStyle.color === color ? "selected" : ""} style={{ background: color }} onClick={() => setPenStyle({ ...penStyle, color })} />)}<input aria-label="任意のペン色" type="color" value={penStyle.color} onChange={(e) => setPenStyle({ ...penStyle, color: e.target.value })} /></div><div className="widths">{penWidths.map(([label, width]) => <button key={label} className={Math.abs(penStyle.widthNormalized - width) < .0001 ? "active" : ""} onClick={() => setPenStyle({ ...penStyle, widthNormalized: width })}>{label}</button>)}</div><div className="draw-actions"><button onClick={() => hide(false)}><Icon name="undo" />1つ戻す</button><button onClick={() => hide(true)}><Icon name="clear" />すべて消す</button></div></section></aside>}
    </div>
  </main>;
}
