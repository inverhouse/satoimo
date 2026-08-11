export class HoldController {
  private startedAt: number | null = null;
  private timer: number | null = null;
  private fired = false;
  constructor(private readonly durationMs: number, private readonly onProgress: (value: number) => void, private readonly onComplete: () => void) {}

  start(now = performance.now()): void {
    if (this.startedAt != null) return;
    this.startedAt = now;
    this.fired = false;
    const tick = () => {
      if (this.startedAt == null) return;
      const progress = Math.min(1, (performance.now() - this.startedAt) / this.durationMs);
      this.onProgress(progress);
      if (progress >= 1) {
        this.startedAt = null;
        if (!this.fired) { this.fired = true; this.onComplete(); }
      } else this.timer = window.requestAnimationFrame(tick);
    };
    this.timer = window.requestAnimationFrame(tick);
  }

  cancel(): void {
    if (this.timer != null) window.cancelAnimationFrame(this.timer);
    this.timer = null;
    this.startedAt = null;
    if (!this.fired) this.onProgress(0);
  }
}

export class FrameHoldController {
  private active: { direction: -1 | 1; timer: number; steps: number } | null = null;

  constructor(private readonly intervalMs: number, private readonly onStep: (direction: -1 | 1) => void) {}

  start(direction: -1 | 1): void {
    if (this.active) return;
    const active = { direction, timer: 0, steps: 0 };
    active.timer = window.setInterval(() => {
      active.steps += 1;
      this.onStep(direction);
    }, this.intervalMs);
    this.active = active;
  }

  stop(direction: -1 | 1): void {
    const active = this.active;
    if (!active || active.direction !== direction) return;
    window.clearInterval(active.timer);
    this.active = null;
    if (active.steps === 0) this.onStep(direction);
  }

  cancel(): void {
    if (this.active) window.clearInterval(this.active.timer);
    this.active = null;
  }
}
