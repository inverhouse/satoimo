import { describe, expect, it } from "vitest";
import { clampUs, formatTime } from "./time";

describe("time helpers", () => {
  it("clamps source endpoints", () => {
    expect(clampUs(-1, 10_000)).toBe(0);
    expect(clampUs(20_000, 10_000)).toBe(10_000);
  });
  it("formats frame time", () => expect(formatTime(3_500_000, 60)).toBe("00:00:03.30"));
});
