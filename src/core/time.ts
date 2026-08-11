export function clampUs(value: number, durationUs: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(durationUs, 0));
}

export function formatTime(us: number, fps = 30): string {
  const safe = Math.max(0, Math.floor(us));
  const totalSeconds = Math.floor(safe / 1_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.min(fps - 1, Math.floor(((safe % 1_000_000) * fps) / 1_000_000));
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, "0")).join(":") + `.${String(frames).padStart(2, "0")}`;
}
