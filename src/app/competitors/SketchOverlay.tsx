"use client";

import { useEffect, useRef, useState } from "react";

// A stroke is a series of normalized (0–1) points so it scales with any image
// size. Each stroke has its own color/width so we can mix annotations.
export type SketchPoint = { x: number; y: number };
export type SketchStroke = {
  color: string;
  width: number; // px at 1× canvas size
  points: SketchPoint[];
};
export type SketchAnnotations = { strokes: SketchStroke[] };

const DEFAULT_COLORS = ["#ef4444", "#0ea5e9", "#22c55e", "#f59e0b", "#111827"];

/**
 * SketchOverlay — overlays a transparent <canvas> on a wrapped child (typically
 * an <img>) and lets the user draw strokes on top. Stores strokes as
 * normalized 0..1 coords so the same annotation renders correctly at any size.
 *
 * Controlled component: pass `value` and get changes via `onChange`. The
 * external "edit mode" toggle is owned by the parent (so a toolbar can flip
 * sketching on/off cleanly).
 */
export default function SketchOverlay({
  value,
  onChange,
  editing,
  imageUrl,
  alt,
  className,
  height,
}: {
  value: SketchAnnotations;
  onChange: (a: SketchAnnotations) => void;
  editing: boolean;
  imageUrl: string;
  alt?: string;
  className?: string;
  height?: number; // px — if omitted, uses the natural aspect ratio of the image
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<SketchStroke | null>(null);
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [width, setWidth] = useState(3);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Repaint on size or strokes change.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(size.w * dpr));
    c.height = Math.max(1, Math.floor(size.h * dpr));
    c.style.width = size.w + "px";
    c.style.height = size.h + "px";
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const strokes = [...(value?.strokes ?? [])];
    if (drawingRef.current) strokes.push(drawingRef.current);
    for (const s of strokes) {
      if (s.points.length < 1) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const p0 = s.points[0];
      ctx.moveTo(p0.x * size.w, p0.y * size.h);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i];
        ctx.lineTo(p.x * size.w, p.y * size.h);
      }
      ctx.stroke();
    }
  }, [size, value]);

  function getXY(e: React.PointerEvent): SketchPoint {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }

  function onDown(e: React.PointerEvent) {
    if (!editing) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = { color, width, points: [getXY(e)] };
  }
  function onMove(e: React.PointerEvent) {
    if (!editing || !drawingRef.current) return;
    drawingRef.current.points.push(getXY(e));
    // Force repaint without changing `value` until we end the stroke
    const c = canvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      if (ctx) {
        const s = drawingRef.current;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const len = s.points.length;
        if (len >= 2) {
          const a = s.points[len - 2];
          const b = s.points[len - 1];
          ctx.beginPath();
          ctx.moveTo(a.x * size.w, a.y * size.h);
          ctx.lineTo(b.x * size.w, b.y * size.h);
          ctx.stroke();
        }
      }
    }
  }
  function onUp() {
    if (!drawingRef.current) return;
    const stroke = drawingRef.current;
    drawingRef.current = null;
    if (stroke.points.length < 2) return;
    onChange({ strokes: [...(value?.strokes ?? []), stroke] });
  }

  function clearAll() {
    if (!confirm("Clear all annotations?")) return;
    onChange({ strokes: [] });
  }
  function undoLast() {
    const list = value?.strokes ?? [];
    if (!list.length) return;
    onChange({ strokes: list.slice(0, -1) });
  }

  return (
    <div className={`sketch-wrap ${className ?? ""}`} style={{ height }}>
      <div className="sketch-img" ref={wrapRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={alt ?? ""} draggable={false} />
        <canvas
          ref={canvasRef}
          className={`sketch-canvas ${editing ? "editing" : ""}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
        />
      </div>
      {editing && (
        <div className="sketch-toolbar">
          <div className="sketch-colors">
            {DEFAULT_COLORS.map((c) => (
              <button
                key={c}
                className={`sketch-color ${color === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          <div className="sketch-width">
            <span>Size</span>
            <input
              type="range"
              min={1}
              max={12}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </div>
          <div className="sketch-actions">
            <button className="btn ghost sm" onClick={undoLast}>
              ↶ Undo
            </button>
            <button className="btn ghost sm" onClick={clearAll}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function isAnnotations(v: unknown): v is SketchAnnotations {
  if (!v || typeof v !== "object") return false;
  const a = v as { strokes?: unknown };
  return Array.isArray(a.strokes);
}
