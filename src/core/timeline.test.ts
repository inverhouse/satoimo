import { describe, expect, it } from "vitest";
import { buildStrokes, buildTimeline, sourceAtOutput } from "./timeline";
import type { SessionEvent } from "../types";

const event = (seq: number, sessionUs: number, type: SessionEvent["type"], payload: Record<string, unknown> = {}): SessionEvent => ({ schemaVersion: 1, seq, sessionUs, type, payload });

describe("virtual timeline", () => {
  it("builds freeze, play, seek and rate segments", () => {
    const segments = buildTimeline([
      event(1, 0, "session_start", { sourceUs: 2_000_000, rate: 1 }),
      event(2, 3_000_000, "play", { sourceUs: 2_000_000, rate: 1 }),
      event(3, 5_000_000, "seek", { fromSourceUs: 4_000_000, toSourceUs: 0, continuesPlaying: true }),
      event(4, 7_000_000, "rate_change", { sourceUs: 2_000_000, fromRate: 1, toRate: .5, playing: true }),
      event(5, 9_000_000, "pause", { sourceUs: 3_000_000 }),
      event(6, 10_000_000, "session_stop", { sourceUs: 3_000_000, playing: false }),
    ]);
    expect(segments).toEqual([
      { kind: "freeze", outputStartUs: 0, outputDurationUs: 3_000_000, sourceFrameUs: 2_000_000 },
      { kind: "play", outputStartUs: 3_000_000, outputDurationUs: 2_000_000, sourceStartUs: 2_000_000, sourceEndUs: 4_000_000, rate: 1 },
      { kind: "play", outputStartUs: 5_000_000, outputDurationUs: 2_000_000, sourceStartUs: 0, sourceEndUs: 2_000_000, rate: 1 },
      { kind: "play", outputStartUs: 7_000_000, outputDurationUs: 2_000_000, sourceStartUs: 2_000_000, sourceEndUs: 3_000_000, rate: .5 },
      { kind: "freeze", outputStartUs: 9_000_000, outputDurationUs: 1_000_000, sourceFrameUs: 3_000_000 },
    ]);
    expect(sourceAtOutput(segments, 8_000_000)).toBe(2_500_000);
  });

  it.each([.25, .5, .75, 1, 1.25, 1.5, 2])("keeps output duration at rate %s", (rate) => {
    const segments = buildTimeline([event(1, 0, "session_start", { sourceUs: 0, rate }), event(2, 0, "play", { sourceUs: 0, rate }), event(3, 4_000_000, "session_stop")]);
    expect(segments[0]).toMatchObject({ outputDurationUs: 4_000_000, sourceEndUs: 4_000_000 * rate });
  });
});

describe("stroke visibility", () => {
  it("tracks drawing progress, undo and clear", () => {
    const strokes = buildStrokes([
      event(1, 10, "stroke_begin", { strokeId: "a", x: .1, y: .2, color: "#fff", widthNormalized: .01 }),
      event(2, 20, "stroke_point", { strokeId: "a", x: .2, y: .3, pressure: .5 }),
      event(3, 30, "stroke_begin", { strokeId: "b", x: .3, y: .4, color: "#fff", widthNormalized: .01 }),
      event(4, 40, "stroke_hide", { strokeIds: ["b"], reason: "undo" }),
      event(5, 50, "stroke_hide", { strokeIds: ["a"], reason: "clear" }),
    ]);
    expect(strokes[0]).toMatchObject({ hiddenAtUs: 50, points: [{ x: .1 }, { x: .2 }] });
    expect(strokes[1].hiddenAtUs).toBe(40);
  });
  it("hides every visible marker when playback starts", () => {
    const strokes = buildStrokes([
      event(1, 10, "stroke_begin", { strokeId: "a", x: .1, y: .2, color: "#fff", widthNormalized: .01 }),
      event(2, 20, "stroke_begin", { strokeId: "b", x: .3, y: .4, color: "#fff", widthNormalized: .01 }),
      event(3, 30, "stroke_hide", { strokeIds: ["a", "b"], reason: "play" }),
      event(4, 30, "play", { sourceUs: 0, rate: 1 }),
    ]);
    expect(strokes.map((stroke) => stroke.hiddenAtUs)).toEqual([30, 30]);
  });
});
