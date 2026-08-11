export function LevelMeter({ rms, peak }: { rms: number; peak: number }) {
  const label = peak < 0.08 ? "小さい" : peak < 0.82 ? "正常" : "大きい";
  return <div className="level-wrap" aria-label={`入力レベル: ${label}`}>
    <div className="level-track"><span style={{ width: `${Math.min(100, rms * 180)}%` }} /><i style={{ left: `${Math.min(99, peak * 100)}%` }} /></div>
    <small>{label}</small>
  </div>;
}
