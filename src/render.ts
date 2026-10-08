// One renderer for the recording screen, the preview and the MP4 overlays, so they always match.
import { BOARD_H, BOARD_W, FIELD, PIECE_IDS, type Dir, type Mode, type Pieces, type Pt } from "./timeline.ts";

export const PEN_COLORS = ["#f24d5d", "#ffd23f", "#4fc3f7", "#ffffff"];
export const PEN_WIDTHS = { 細: 3, 中: 6, 太: 10 } as const; // px at 1080p

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface DrawState {
  mode: Mode;
  pieces: Pieces;
  dir: Dir;
  strokes: { color: string; w: number; pts: Pt[]; layer: Mode }[];
}

const FONT = '"Noto Sans JP Variable", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif';
export const PIECE_R = 17; // in board units (920x518)

/** Board units -> stage pixels (board keeps its 920:518 aspect, centered). */
export function boardScale(W: number, H: number) {
  const k = Math.min(W / BOARD_W, H / BOARD_H);
  return { k, ox: (W - BOARD_W * k) / 2, oy: (H - BOARD_H * k) / 2 };
}

export function drawScene(ctx: Ctx, W: number, H: number, s: DrawState) {
  ctx.clearRect(0, 0, W, H);
  if (s.mode === "board") drawBoard(ctx, W, H, s.pieces, s.dir);
  for (const st of s.strokes) if (st.layer === s.mode) drawStroke(ctx, W, H, st);
}

export function drawStroke(ctx: Ctx, W: number, H: number, st: { color: string; w: number; pts: Pt[] }) {
  if (!st.pts.length) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = st.color;
  ctx.lineWidth = (st.w * H) / 1080;
  ctx.lineCap = ctx.lineJoin = "round";
  // dark halo keeps white/yellow lines readable on bright footage
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = (2 * H) / 1080;
  ctx.beginPath();
  ctx.moveTo(st.pts[0][0] * W, st.pts[0][1] * H);
  if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] * W + 0.01, st.pts[0][1] * H);
  for (const p of st.pts) ctx.lineTo(p[0] * W, p[1] * H);
  ctx.stroke();
  ctx.restore();
}

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawBoard(ctx: Ctx, W: number, H: number, pieces: Pieces, dir: Dir) {
  const { k, ox, oy } = boardScale(W, H);
  ctx.save();
  ctx.fillStyle = "#f7fbff";
  ctx.fillRect(0, 0, W, H);
  ctx.translate(ox, oy);
  ctx.scale(k, k);
  // field
  ctx.fillStyle = "#ddf3f1";
  ctx.fillRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h);
  ctx.strokeStyle = "#3f8bff";
  ctx.lineWidth = 2;
  ctx.strokeRect(FIELD.x + 1, FIELD.y + 1, FIELD.w - 2, FIELD.h - 2);
  const bx = FIELD.x + 25,
    by = FIELD.y + 25,
    bw = 710,
    bh = 388;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(bx + 100, by, 2, bh);
  ctx.fillRect(bx + bw - 102, by, 2, bh);
  ctx.fillStyle = "#247c86";
  ctx.font = `700 11px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [x, rot] of [[bx + 50, Math.PI / 2], [bx + bw - 50, -Math.PI / 2]] as const) {
    ctx.save();
    ctx.translate(x, by + bh / 2);
    ctx.rotate(rot);
    ctx.fillText("END ZONE", 0, 0);
    ctx.restore();
  }
  // pieces: offense, then defense on top, disc last (Figma layer order)
  ctx.font = `700 12px ${FONT}`;
  for (const id of PIECE_IDS) {
    const p = pieces[id];
    if (!p) continue;
    const x = p[0] * BOARD_W,
      y = p[1] * BOARD_H;
    ctx.beginPath();
    if (id === "disc") {
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#ffc93c";
      ctx.fill();
      ctx.strokeStyle = "#d99a00";
      ctx.lineWidth = 2;
      ctx.stroke();
      continue;
    }
    const off = id[0] === "o";
    ctx.arc(x, y, off ? PIECE_R : PIECE_R - 1.5, 0, Math.PI * 2);
    ctx.fillStyle = off ? "#3f8bff" : "#ffffff";
    ctx.fill();
    if (!off) {
      ctx.strokeStyle = "#f24d5d";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = off ? "#ffffff" : "#f24d5d";
    ctx.fillText(id.slice(1), x, y + 1);
  }
  // attack direction label (bottom-left, as in Figma)
  const label = dir === 1 ? "攻撃方向 →" : "← 攻撃方向";
  ctx.font = `700 11px ${FONT}`;
  const tw = ctx.measureText(label).width;
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = "#10233c";
  rr(ctx, 18, 472, tw + 20, 25, 8);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.fillText(label, 28, 485);
  ctx.restore();
}

/** Stage pixel -> board-normalized coords (pieces are stored in board units / 920x518). */
export function toBoard(px: number, py: number, W: number, H: number): [number, number] {
  const { k, ox, oy } = boardScale(W, H);
  return [(px - ox) / k / BOARD_W, (py - oy) / k / BOARD_H];
}

/** Topmost piece under a board-normalized point. */
export function hitPiece(pieces: Pieces, nx: number, ny: number): string | null {
  for (const id of [...PIECE_IDS].reverse()) {
    const p = pieces[id];
    if (!p) continue;
    const dx = (p[0] - nx) * BOARD_W,
      dy = (p[1] - ny) * BOARD_H,
      r = id === "disc" ? 12 : PIECE_R + 2;
    if (dx * dx + dy * dy <= r * r) return id;
  }
  return null;
}
