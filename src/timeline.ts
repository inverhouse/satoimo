// Recording model. Everything is keyed by "completed time" t (seconds of the finished video),
// which is the commentary audio clock. Coordinates are normalized to the 16:9 stage (0..1).

export type Mode = "video" | "board";
export type Dir = 1 | -1;
export type XY = [number, number];
export type Pieces = Record<string, XY>;
/** x, y, seconds since stroke start */
export type Pt = [number, number, number];

export type Ev =
  | { k: "init"; t: number; pos: number; mode: Mode; pieces: Pieces; dir: Dir }
  | { k: "v"; t: number; pos: number; playing: boolean; rate: number }
  | { k: "mode"; t: number; mode: Mode }
  | { k: "s"; t: number; id: string; layer: Mode; color: string; w: number; pts: Pt[] }
  | { k: "rm"; t: number; ids: string[] }
  | { k: "p"; t: number; id: string; x: number; y: number }
  | { k: "dir"; t: number; dir: Dir };

export interface Key {
  t: number;
  pos: number;
  playing: boolean;
  rate: number;
  mode: Mode;
}

export interface Stroke {
  id: string;
  layer: Mode;
  color: string;
  w: number;
  t0: number;
  t1: number; // removal time (Infinity = never)
  pts: Pt[];
}

export interface Timeline {
  duration: number;
  srcDuration: number;
  keys: Key[];
  strokes: Stroke[];
  pieces: Record<string, { t: number; x: number; y: number }[]>;
  dirs: { t: number; dir: Dir }[];
}

export interface Scene {
  mode: Mode;
  pos: number;
  playing: boolean;
  rate: number;
  pieces: Pieces;
  dir: Dir;
  strokes: { color: string; w: number; pts: Pt[]; layer: Mode }[];
}

// ---- Board defaults: taken from the Figma frame "収録画面 v2 / ボード" (node 7:3).
// Board stage is 920x518; the field frame sits at (80,40); piece centers below are in field coords.
export const BOARD_W = 920;
export const BOARD_H = 518;
export const FIELD = { x: 80, y: 40, w: 760, h: 438 };
const OFFENSE: XY[] = [[205, 231], [308, 138], [349, 137], [390, 138], [431, 138], [472, 138], [513, 138]];
const DEFENSE: XY[] = [[222, 205], [308, 172], [349, 172], [390, 171], [431, 172], [472, 172], [513, 172]];
const DISC: XY = [233, 248];
const norm = ([x, y]: XY): XY => [(FIELD.x + x) / BOARD_W, (FIELD.y + y) / BOARD_H];

export const PIECE_IDS = [...OFFENSE.map((_, i) => `o${i + 1}`), ...DEFENSE.map((_, i) => `d${i + 1}`), "disc"];

export function defaultPieces(): Pieces {
  const p: Pieces = {};
  OFFENSE.forEach((xy, i) => (p[`o${i + 1}`] = norm(xy)));
  DEFENSE.forEach((xy, i) => (p[`d${i + 1}`] = norm(xy)));
  p.disc = norm(DISC);
  return p;
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function parseEvents(text: string): Ev[] {
  const out: Ev[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line)); // a crash can leave the last line half-written
    } catch {}
  }
  return out;
}

export function compile(events: Ev[], duration: number, srcDuration: number): Timeline {
  const init = events.find((e) => e.k === "init") as Extract<Ev, { k: "init" }> | undefined;
  if (!init) throw new Error("収録の開始記録が見つかりません");
  const tl: Timeline = { duration, srcDuration, keys: [], strokes: [], pieces: {}, dirs: [{ t: 0, dir: init.dir }] };
  let cur: Key = { t: 0, pos: init.pos, playing: false, rate: 1, mode: init.mode };
  tl.keys.push(cur);
  for (const [id, [x, y]] of Object.entries(init.pieces)) tl.pieces[id] = [{ t: 0, x, y }];
  const byId = new Map<string, Stroke>();
  const evs = events.filter((e) => e.k !== "init" && e.t <= duration).sort((a, b) => a.t - b.t);
  for (const e of evs) {
    switch (e.k) {
      case "v":
      case "mode": {
        const next: Key = { ...cur, t: e.t, pos: posAt(cur, e.t, srcDuration) };
        if (e.k === "v") Object.assign(next, { pos: e.pos, playing: e.playing, rate: e.rate });
        else next.mode = e.mode;
        if (next.mode === "board") next.playing = false; // the source is frozen while the board shows
        // same-instant changes collapse into one key
        if (tl.keys.length && tl.keys[tl.keys.length - 1].t === e.t) tl.keys[tl.keys.length - 1] = next;
        else tl.keys.push(next);
        cur = next;
        break;
      }
      case "s": {
        const s: Stroke = { id: e.id, layer: e.layer, color: e.color, w: e.w, t0: e.t, t1: Infinity, pts: e.pts };
        byId.set(e.id, s);
        tl.strokes.push(s);
        break;
      }
      case "rm":
        for (const id of e.ids) {
          const s = byId.get(id);
          if (s && s.t1 === Infinity) s.t1 = e.t;
        }
        break;
      case "p":
        (tl.pieces[e.id] ??= []).push({ t: e.t, x: e.x, y: e.y });
        break;
      case "dir":
        tl.dirs.push({ t: e.t, dir: e.dir });
        break;
    }
  }
  return tl;
}

export function posAt(k: Key, t: number, srcDuration: number): number {
  const p = k.playing ? k.pos + (t - k.t) * k.rate : k.pos;
  return Math.min(Math.max(p, 0), srcDuration);
}

/** index of the last item with item.t <= t (items sorted by t) */
function lastAt<T extends { t: number }>(arr: T[], t: number): number {
  let lo = 0,
    hi = arr.length - 1,
    ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t <= t) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

export function sceneAt(tl: Timeline, t: number): Scene {
  const k = tl.keys[lastAt(tl.keys, t)];
  const pieces: Pieces = {};
  for (const [id, list] of Object.entries(tl.pieces)) {
    const p = list[lastAt(list, t)];
    pieces[id] = [p.x, p.y];
  }
  const strokes: Scene["strokes"] = [];
  for (const s of tl.strokes) {
    if (s.t0 > t || s.t1 <= t || s.layer !== k.mode) continue;
    const dt = t - s.t0;
    let n = s.pts.length;
    while (n > 1 && s.pts[n - 1][2] > dt) n--;
    strokes.push({ color: s.color, w: s.w, layer: s.layer, pts: n === s.pts.length ? s.pts : s.pts.slice(0, n) });
  }
  return {
    mode: k.mode,
    pos: posAt(k, t, tl.srcDuration),
    playing: k.playing,
    rate: k.rate,
    pieces,
    dir: tl.dirs[lastAt(tl.dirs, t)].dir,
    strokes,
  };
}

/** User-visible segments: a new one starts on play/pause, a jump, a speed change or a view switch
 * (drift re-anchoring keys written during playback are not counted). */
export function segmentCount(tl: Timeline): number {
  let n = 1;
  for (let i = 1; i < tl.keys.length; i++) {
    const a = tl.keys[i - 1],
      b = tl.keys[i];
    const jump = Math.abs(b.pos - posAt(a, b.t, tl.srcDuration)) > 0.5;
    if (a.mode !== b.mode || a.playing !== b.playing || jump || (b.playing && a.rate !== b.rate)) n++;
  }
  return n;
}

/** Identity of what the overlay looks like at t; equal keys => identical overlay image. */
export function overlayKey(s: Scene): string {
  if (s.mode === "video" && !s.strokes.length) return "";
  let k = s.mode + s.dir;
  if (s.mode === "board") for (const id of PIECE_IDS) k += s.pieces[id]?.map((v) => v.toFixed(4)).join(",") + ";";
  for (const st of s.strokes) k += `|${st.color}${st.w}:${st.pts.length}:${st.pts[0]?.[0]},${st.pts[0]?.[1]}`;
  return k;
}

/** Live (end-of-recording) state, used to continue after a crash. */
export function endState(tl: Timeline) {
  const t = tl.duration;
  const k = tl.keys[tl.keys.length - 1];
  const s = sceneAt(tl, t);
  const strokes = tl.strokes.filter((x) => x.t0 <= t && x.t1 > t);
  return { pos: posAt(k, t, tl.srcDuration), mode: k.mode, rate: k.rate, pieces: s.pieces, dir: s.dir, strokes };
}

export function fmt(sec: number, frac: "none" | "cs" = "none"): string {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  const base = [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
  return frac === "cs" ? `${base}.${String(Math.floor((sec % 1) * 100)).padStart(2, "0")}` : base;
}
