import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameHoldController, HoldController } from "./hold";

describe("HoldController", () => {
  afterEach(() => vi.restoreAllMocks());
  it("cancels below one second", () => {
    const complete = vi.fn(); const hold = new HoldController(1000, vi.fn(), complete);
    hold.start(); hold.cancel(); expect(complete).not.toHaveBeenCalled();
  });
});

describe("FrameHoldController", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("moves one 1/30-second frame on a short press", () => {
    vi.useFakeTimers(); const step = vi.fn(); const hold = new FrameHoldController(1000 / 15, step);
    hold.start(1); hold.stop(1); expect(step).toHaveBeenCalledTimes(1); expect(step).toHaveBeenCalledWith(1);
  });
  it("moves about one second of video during a two-second hold", () => {
    vi.useFakeTimers(); const step = vi.fn(); const hold = new FrameHoldController(1000 / 15, step);
    hold.start(-1); vi.advanceTimersByTime(2000); hold.stop(-1);
    expect(step).toHaveBeenCalledTimes(30);
  });
});
