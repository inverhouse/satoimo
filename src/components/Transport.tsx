import { Icon } from "./Icon";
import { formatTime } from "../core/time";
import { PLAYBACK_RATES, type PlaybackRate } from "../types";

export function Transport({ currentUs, durationUs, fps, playing, rate, recording, seeking, onToggle, onSeek, onScrub, onRate }: {
  currentUs: number; durationUs: number; fps: number; playing: boolean; rate: PlaybackRate; recording: boolean; seeking: boolean;
  onToggle: () => void; onSeek: (deltaUs: number, method: string) => void; onScrub: (valueUs: number) => void; onRate: (rate: PlaybackRate) => void;
}) {
  return <div className="transport">
    <div className="time-row"><span className="mono">{formatTime(currentUs, fps)}</span><input aria-label="元動画タイムライン" type="range" min={0} max={durationUs || 1} step={1000} value={Math.min(currentUs, durationUs)} onChange={(e) => onScrub(Number(e.target.value))} /><span className="mono muted">{formatTime(durationUs, fps)}</span></div>
    <div className="transport-row">
      <div className="transport-buttons">
        <button aria-label="10秒戻る" onClick={() => onSeek(-10_000_000, "jump_10s")}><Icon name="rewind" /><small>10</small></button>
        <button aria-label="5秒戻る" onClick={() => onSeek(-5_000_000, "jump_5s")}><Icon name="rewind" /><small>5</small></button>
        <button className="play-button" aria-label={playing ? "停止" : "再生"} onClick={onToggle}>{playing ? <Icon name="pause" /> : <Icon name="play" />}</button>
        <button aria-label="5秒進む" onClick={() => onSeek(5_000_000, "jump_5s")}><Icon name="forward" /><small>5</small></button>
        <button aria-label="10秒進む" onClick={() => onSeek(10_000_000, "jump_10s")}><Icon name="forward" /><small>10</small></button>
        <span className="divider" />
        <button aria-label="1フレーム戻る" disabled={playing || seeking} onClick={() => onSeek(-1_000_000 / fps, "frame")}>,</button>
        <button aria-label="1フレーム進む" disabled={playing || seeking} onClick={() => onSeek(1_000_000 / fps, "frame")}>.</button>
      </div>
      <div className="rates" aria-label="再生速度">{PLAYBACK_RATES.map((value) => <button key={value} className={value === rate ? "active" : ""} aria-pressed={value === rate} onClick={() => onRate(value)}>{value.toFixed(value === 1 ? 1 : value % 1 ? 2 : 1).replace(/0$/, "")}×</button>)}</div>
    </div>
    {recording && <span className="recording-dot" aria-hidden="true" />}
  </div>;
}
