export function displayedExportPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent >= 100) return 100;
  return Math.min(99, Math.max(0, Math.floor(percent)));
}

export function isFinalizingExport(percent: number): boolean {
  return percent >= 99 && percent < 100;
}
