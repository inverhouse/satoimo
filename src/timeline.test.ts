// Run: npm test  (node --experimental-strip-types)
import assert from "node:assert/strict";
import { compile, segmentCount, defaultPieces, endState, overlayKey, parseEvents, sceneAt, type Ev } from "./timeline.ts";

const pieces = defaultPieces();
const ev: Ev[] = [
  { k: "init", t: 0, pos: 10, mode: "video", pieces, dir: 1 },
  { k: "v", t: 1, pos: 10, playing: true, rate: 1 },
  { k: "v", t: 3, pos: 12, playing: false, rate: 1 }, // pause at src 12
  { k: "s", t: 4, id: "a", layer: "video", color: "#f00", w: 6, pts: [[0.1, 0.1, 0], [0.2, 0.2, 0.5]] },
  { k: "v", t: 6, pos: 5, playing: true, rate: 2 }, // rewind + 2x
  { k: "rm", t: 6, ids: ["a"] },
  { k: "mode", t: 8, mode: "board" },
  { k: "p", t: 9, id: "o1", x: 0.5, y: 0.5 },
  { k: "dir", t: 9.5, dir: -1 },
];
const tl = compile(ev, 12, 100);

// video position follows play / pause / rewind / speed in completed time
assert.equal(sceneAt(tl, 0.5).pos, 10);
assert.equal(sceneAt(tl, 2).pos, 11);
assert.equal(sceneAt(tl, 5).pos, 12); // paused: still image while commentary continues
assert.equal(sceneAt(tl, 7).pos, 7); // 5 + (7-6)*2
// board switch freezes the source at the switch position
assert.equal(sceneAt(tl, 8).mode, "board");
assert.equal(sceneAt(tl, 10).pos, 9);
assert.equal(sceneAt(tl, 10).playing, false);

// play, pause, rewind+2x, board = 4 visible segments; a drift re-anchor adds none
assert.equal(segmentCount(tl), 5);
assert.equal(segmentCount(compile([...ev, { k: "v", t: 6.5, pos: 6.02, playing: true, rate: 2 }], 12, 100)), 5);

// stroke animates in, then is removed
assert.equal(sceneAt(tl, 4.1).strokes[0].pts.length, 1);
assert.equal(sceneAt(tl, 4.6).strokes[0].pts.length, 2);
assert.equal(sceneAt(tl, 6).strokes.length, 0);

// board pieces & direction
assert.deepEqual(sceneAt(tl, 8.5).pieces.o1, pieces.o1);
assert.deepEqual(sceneAt(tl, 9).pieces.o1, [0.5, 0.5]);
assert.equal(sceneAt(tl, 9.4).dir, 1);
assert.equal(sceneAt(tl, 9.6).dir, -1);

// overlay identity: empty for plain video, changes when the board changes
assert.equal(overlayKey(sceneAt(tl, 2)), "");
assert.notEqual(overlayKey(sceneAt(tl, 4.1)), overlayKey(sceneAt(tl, 4.6)));
assert.notEqual(overlayKey(sceneAt(tl, 8.5)), overlayKey(sceneAt(tl, 9)));
assert.equal(overlayKey(sceneAt(tl, 9.1)), overlayKey(sceneAt(tl, 9.2)));

// events past the confirmed audio length are dropped (crash recovery)
assert.equal(compile(ev, 7, 100).keys.length, 4);
const end = endState(compile(ev, 7, 100));
assert.equal(end.pos, 7);
assert.equal(end.mode, "video");

// half-written last line is ignored
assert.equal(parseEvents('{"k":"mode","t":1,"mode":"board"}\n{"k":"p","t":2,').length, 1);

// Figma default layout: 7 offense, 7 defense, disc, all inside the field
assert.equal(Object.keys(pieces).length, 15);
for (const [x, y] of Object.values(pieces)) assert.ok(x > 0.08 && x < 0.92 && y > 0.07 && y < 0.93);

console.log("timeline tests ok");
