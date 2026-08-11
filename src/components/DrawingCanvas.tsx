import { useCallback, useEffect, useRef } from "react";
import type { Stroke } from "../types";

interface Props {
  enabled: boolean;
  color: string;
  widthNormalized: number;
  strokes: Stroke[];
  sessionUs: number;
  onStrokeBegin: (id: string, x: number, y: number) => void;
  onStrokePoint: (id: string, x: number, y: number, pressure: number) => void;
  onStrokeEnd: (id: string, x: number, y: number) => void;
}

export function DrawingCanvas({ enabled, color, widthNormalized, strokes, sessionUs, onStrokeBegin, onStrokePoint, onStrokeEnd }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<string | null>(null);

  const redraw = useCallback(() => {
    const node = canvas.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (node.width !== Math.round(rect.width * ratio) || node.height !== Math.round(rect.height * ratio)) {
      node.width = Math.round(rect.width * ratio); node.height = Math.round(rect.height * ratio);
    }
    const ctx = node.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.startUs > sessionUs || (stroke.hiddenAtUs != null && sessionUs >= stroke.hiddenAtUs)) continue;
      const points = stroke.points.filter((point) => point.sessionUs <= sessionUs);
      if (!points.length) continue;
      ctx.beginPath(); ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.widthNormalized * rect.height;
      ctx.moveTo(points[0].x * rect.width, points[0].y * rect.height);
      for (const point of points.slice(1)) ctx.lineTo(point.x * rect.width, point.y * rect.height);
      if (points.length === 1) ctx.lineTo(points[0].x * rect.width + 0.01, points[0].y * rect.height);
      ctx.stroke();
    }
  }, [sessionUs, strokes]);

  useEffect(() => { redraw(); const observer = new ResizeObserver(redraw); if (canvas.current) observer.observe(canvas.current); return () => observer.disconnect(); }, [redraw]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled || event.button !== 0) return;
    const id = crypto.randomUUID(); const p = point(event);
    active.current = id; event.currentTarget.setPointerCapture(event.pointerId); onStrokeBegin(id, p.x, p.y);
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active.current) return; const p = point(event); onStrokePoint(active.current, p.x, p.y, event.pressure || 1);
  };
  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active.current) return; const p = point(event); onStrokeEnd(active.current, p.x, p.y); active.current = null;
  };

  return <canvas ref={canvas} className={`drawing-canvas ${enabled ? "enabled" : ""}`} aria-label="動画へのフリーハンド描画" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
}
