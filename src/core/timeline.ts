import type { OutputSegment, SessionEvent, Stroke } from "../types";

type State = { playing: boolean; sourceUs: number; rate: number; sessionUs: number };

export function buildTimeline(events: SessionEvent[]): OutputSegment[] {
  if (!events.length || events[0].type !== "session_start") return [];
  const start = events[0];
  const state: State = {
    playing: false,
    sourceUs: Number(start.payload.sourceUs ?? 0),
    rate: Number(start.payload.rate ?? 1),
    sessionUs: start.sessionUs,
  };
  const result: OutputSegment[] = [];

  for (const event of events.slice(1)) {
    const elapsed = Math.max(0, event.sessionUs - state.sessionUs);
    if (elapsed > 0) {
      if (state.playing) {
        const sourceEndUs = state.sourceUs + elapsed * state.rate;
        result.push({ kind: "play", outputStartUs: state.sessionUs, outputDurationUs: elapsed, sourceStartUs: state.sourceUs, sourceEndUs, rate: state.rate });
        state.sourceUs = sourceEndUs;
      } else {
        result.push({ kind: "freeze", outputStartUs: state.sessionUs, outputDurationUs: elapsed, sourceFrameUs: state.sourceUs });
      }
    }
    if (event.type === "play") {
      state.sourceUs = Number(event.payload.sourceUs ?? state.sourceUs);
      state.rate = Number(event.payload.rate ?? state.rate);
      state.playing = true;
    } else if (event.type === "pause") {
      state.sourceUs = Number(event.payload.sourceUs ?? state.sourceUs);
      state.playing = false;
    } else if (event.type === "seek") {
      state.sourceUs = Number(event.payload.toSourceUs ?? state.sourceUs);
      state.playing = Boolean(event.payload.continuesPlaying);
    } else if (event.type === "rate_change") {
      state.sourceUs = Number(event.payload.sourceUs ?? state.sourceUs);
      state.rate = Number(event.payload.toRate ?? state.rate);
      state.playing = Boolean(event.payload.playing);
    } else if (event.type === "session_stop" || event.type === "interruption") {
      state.playing = false;
    }
    state.sessionUs = event.sessionUs;
  }
  return mergeAdjacent(result);
}

function mergeAdjacent(segments: OutputSegment[]): OutputSegment[] {
  const merged: OutputSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous?.kind === "play" && segment.kind === "play" && previous.rate === segment.rate && Math.abs(previous.sourceEndUs - segment.sourceStartUs) <= 2) {
      previous.outputDurationUs += segment.outputDurationUs;
      previous.sourceEndUs = segment.sourceEndUs;
    } else if (previous?.kind === "freeze" && segment.kind === "freeze" && previous.sourceFrameUs === segment.sourceFrameUs) {
      previous.outputDurationUs += segment.outputDurationUs;
    } else merged.push({ ...segment });
  }
  return merged;
}

export function sourceAtOutput(segments: OutputSegment[], outputUs: number): number {
  if (!segments.length) return 0;
  const match = segmentAtOutput(segments, outputUs);
  if (match) return match.kind === "freeze" ? match.sourceFrameUs : match.sourceStartUs + (outputUs - match.outputStartUs) * match.rate;
  const last = segments.at(-1)!;
  return last.kind === "freeze" ? last.sourceFrameUs : last.sourceEndUs;
}

export function segmentAtOutput(segments: OutputSegment[], outputUs: number): OutputSegment | undefined {
  let low = 0, high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const current = segments[mid];
    if (outputUs < current.outputStartUs) high = mid - 1;
    else if (outputUs >= current.outputStartUs + current.outputDurationUs) low = mid + 1;
    else return current;
  }
  return undefined;
}

export function buildStrokes(events: SessionEvent[]): Stroke[] {
  const strokes = new Map<string, Stroke>();
  for (const event of events) {
    if (event.type === "stroke_begin") {
      const id = String(event.payload.strokeId);
      strokes.set(id, { id, color: String(event.payload.color), widthNormalized: Number(event.payload.widthNormalized), startUs: event.sessionUs, points: [{ x: Number(event.payload.x), y: Number(event.payload.y), sessionUs: event.sessionUs, pressure: 1 }] });
    } else if (event.type === "stroke_point" || event.type === "stroke_end") {
      const stroke = strokes.get(String(event.payload.strokeId));
      if (stroke) stroke.points.push({ x: Number(event.payload.x), y: Number(event.payload.y), sessionUs: event.sessionUs, pressure: Number(event.payload.pressure ?? 1) });
    } else if (event.type === "stroke_hide") {
      for (const id of event.payload.strokeIds as string[]) {
        const stroke = strokes.get(id);
        if (stroke && stroke.hiddenAtUs == null) stroke.hiddenAtUs = event.sessionUs;
      }
    }
  }
  return [...strokes.values()];
}
