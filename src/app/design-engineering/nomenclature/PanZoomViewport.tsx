"use client";

// V128 — drag-to-pan + scroll-to-zoom viewport for the tree diagrams.
// Used by both the nomenclature Database Tree sub-tab and the
// Lightbase Inventory Tree tab so wide BOMs stay legible regardless
// of screen size.
//
// Interactions:
//   • Mouse drag (anywhere except a button / link) → pan
//   • Mouse wheel → zoom around the cursor
//   • Pinch on a Mac trackpad → wheel event w/ ctrlKey → same zoom
//   • Initial fit → scale + translate so the whole content shows
//   • Toolbar: − · % · + · ⌖ Fit · ↺ Reset (top-right)
//
// Implementation notes:
//   • CSS transform on the inner div with `transform-origin: 0 0`.
//   • Zoom-to-cursor math: when scaling by `f`, the new translation
//     keeps the content point under the cursor stationary:
//       newTx = mx − (mx − tx) · f
//       newTy = my − (my − ty) · f
//   • Drag is suppressed when the original mousedown landed on an
//     interactive element (button / a / input) so clicks still work.

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  children: React.ReactNode;
  minScale?: number;
  maxScale?: number;
  initialMaxScale?: number;
  height?: string | number;
  // Optional label rendered in the toolbar (e.g. "Lightline-X tree").
  label?: string;
};

export default function PanZoomViewport({
  children,
  minScale = 0.15,
  maxScale = 4,
  initialMaxScale = 1,
  height = "min(75vh, 760px)",
  label,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [panning, setPanning] = useState(false);
  // V129 — mirror state into a ref so synchronous handlers (wheel,
  // mousemove) read the freshest values without React's batched
  // setState window getting in the way. Without this the zoom-to-
  // cursor math drifted diagonally because the wheel handler read
  // stale tx/ty during back-to-back wheel events.
  const stateRef = useRef({ scale, tx, ty });
  useEffect(() => {
    stateRef.current = { scale, tx, ty };
  }, [scale, tx, ty]);
  // Track pan start in refs (not state) so the move handler reads
  // synchronously without stale closures.
  const panStartRef = useRef<{
    sx: number;
    sy: number;
    tx0: number;
    ty0: number;
  } | null>(null);

  const fitToScreen = useCallback(() => {
    const vp = viewportRef.current;
    const ct = contentRef.current;
    if (!vp || !ct) return;
    // Measure content unscaled by clearing the transform briefly.
    const inner = ct.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const prevTransform = ct.style.transform;
    ct.style.transform = "";
    // V129 — `scrollWidth` / `scrollHeight` include children that
    // overflow `overflow-x: auto` wrappers, so a wide BOM that would
    // be cut off in a getBoundingClientRect measurement is correctly
    // accounted for here.
    const w = Math.max(inner.scrollWidth, inner.offsetWidth);
    const h = Math.max(inner.scrollHeight, inner.offsetHeight);
    ct.style.transform = prevTransform;
    const vpRect = vp.getBoundingClientRect();
    if (w === 0 || h === 0) return;
    const margin = 32;
    const sx = (vpRect.width - margin) / w;
    const sy = (vpRect.height - margin) / h;
    const next = Math.min(initialMaxScale, Math.min(sx, sy));
    const clamped = Math.max(minScale, Math.min(maxScale, next));
    const cx = (vpRect.width - w * clamped) / 2;
    const cy = (vpRect.height - h * clamped) / 2;
    stateRef.current = { scale: clamped, tx: cx, ty: cy };
    ct.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${clamped})`;
    setScale(clamped);
    setTx(cx);
    setTy(cy);
  }, [initialMaxScale, minScale, maxScale]);

  // Run an initial fit after the first paint when content has a
  // measurable size. Use a small timeout so any async children
  // (e.g. <pre> of spec text) settle first.
  useEffect(() => {
    const id = window.setTimeout(() => fitToScreen(), 60);
    return () => window.clearTimeout(id);
  }, [fitToScreen]);

  // Re-fit when the viewport resizes so the tree always stays visible.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // Only auto-fit if the user hasn't panned much (avoid yanking
      // their view around on resize). Heuristic: if the current
      // translation already keeps content roughly centered, refit.
      // Otherwise leave them alone.
      fitToScreen();
    });
    ro.observe(vp);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V130 — apply the transform to the content DOM directly inside
  // the wheel handler, then queue a React state update via rAF for
  // the toolbar percentage. Going through React state alone created
  // a tiny lag where the cursor's content-anchor could drift on
  // rapid wheel events; writing `style.transform` synchronously
  // pins the cursor to its content point on every wheel tick.
  const rafRef = useRef<number | null>(null);
  function commitToReact() {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      setScale(stateRef.current.scale);
      setTx(stateRef.current.tx);
      setTy(stateRef.current.ty);
    });
  }

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    function handle(e: WheelEvent) {
      // Native listener so preventDefault actually works — React's
      // synthetic onWheel is passive by default.
      e.preventDefault();
      const v = viewportRef.current;
      const ct = contentRef.current;
      if (!v || !ct) return;

      // 1. Cursor position in viewport-space (NOT page-space).
      const rect = v.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // 2. Wheel → multiplicative zoom factor. Same curve for
      //    mouse wheel (large deltaY) and trackpad pinch
      //    (ctrlKey + small deltaY).
      // Convert line / page deltas to pixel-equivalents.
      const deltaY =
        e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * 100
        : e.deltaY;
      const factor = Math.exp(-deltaY * 0.0025);

      // 3. Compute next scale, clamped.
      const { scale: ps, tx: ptx, ty: pty } = stateRef.current;
      const nextScale = Math.max(
        minScale,
        Math.min(maxScale, ps * factor),
      );
      if (nextScale === ps) return;

      // 4. Cursor's content-space point (the literal pixel of the
      //    rendered tree the cursor is over right now).
      const contentX = (mx - ptx) / ps;
      const contentY = (my - pty) / ps;

      // 5. New translation so that the same content point lands at
      //    the same viewport coords after the scale change.
      const ntx = mx - contentX * nextScale;
      const nty = my - contentY * nextScale;

      // 6. Commit to ref + DOM SYNCHRONOUSLY for sub-frame accuracy,
      //    then schedule a React state update so the toolbar % stays
      //    in sync.
      stateRef.current = { scale: nextScale, tx: ntx, ty: nty };
      ct.style.transform = `translate3d(${ntx}px, ${nty}px, 0) scale(${nextScale})`;
      commitToReact();
    }
    vp.addEventListener("wheel", handle, { passive: false });
    return () => vp.removeEventListener("wheel", handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minScale, maxScale]);

  function isInteractiveTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    return !!el.closest("button, a, input, textarea, select, label, [role='button']");
  }

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Don't hijack drags that land on a card button — those need
      // to fire onClick instead.
      if (isInteractiveTarget(e.target)) return;
      if (e.button !== 0) return;
      e.preventDefault();
      setPanning(true);
      panStartRef.current = { sx: e.clientX, sy: e.clientY, tx0: tx, ty0: ty };
    },
    [tx, ty],
  );

  // Mouse move + up live on window so the user can drag past the
  // viewport bounds without losing focus. Same direct-DOM pattern as
  // wheel zoom so panning feels instant even on slow frames.
  useEffect(() => {
    if (!panning) return;
    function onMove(e: MouseEvent) {
      const start = panStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.sx;
      const dy = e.clientY - start.sy;
      const ntx = start.tx0 + dx;
      const nty = start.ty0 + dy;
      stateRef.current = { ...stateRef.current, tx: ntx, ty: nty };
      const ct = contentRef.current;
      if (ct) {
        ct.style.transform = `translate3d(${ntx}px, ${nty}px, 0) scale(${stateRef.current.scale})`;
      }
      commitToReact();
    }
    function onUp() {
      setPanning(false);
      panStartRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panning]);

  function zoomBy(factor: number) {
    const vp = viewportRef.current;
    const ct = contentRef.current;
    if (!vp || !ct) return;
    const rect = vp.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const { scale: ps, tx: ptx, ty: pty } = stateRef.current;
    const nextScale = Math.max(
      minScale,
      Math.min(maxScale, ps * factor),
    );
    if (nextScale === ps) return;
    const contentX = (mx - ptx) / ps;
    const contentY = (my - pty) / ps;
    const ntx = mx - contentX * nextScale;
    const nty = my - contentY * nextScale;
    stateRef.current = { scale: nextScale, tx: ntx, ty: nty };
    ct.style.transform = `translate3d(${ntx}px, ${nty}px, 0) scale(${nextScale})`;
    setScale(nextScale);
    setTx(ntx);
    setTy(nty);
  }

  return (
    <div
      style={{
        position: "relative",
        height,
        width: "100%",
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        ref={viewportRef}
        onMouseDown={onMouseDown}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          cursor: panning ? "grabbing" : "grab",
          touchAction: "none",
        }}
      >
        <div
          ref={contentRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
            transformOrigin: "0 0",
            // V129 — no transform transition. The transition was making
            // wheel zoom feel laggy and was creating diagonal-looking
            // motion when zooming + translating at the same time.
            willChange: "transform",
          }}
        >
          {children}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px",
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 999,
          boxShadow: "0 4px 14px -8px rgba(0,0,0,0.25)",
          fontSize: 12,
          color: "var(--lb-text-2)",
          fontWeight: 700,
        }}
      >
        {label && (
          <span
            style={{
              padding: "0 8px",
              fontSize: 11,
              color: "var(--lb-text-3)",
              letterSpacing: 0.4,
              textTransform: "uppercase",
              borderRight: "1px solid var(--lb-border)",
            }}
          >
            {label}
          </span>
        )}
        <ToolbarBtn onClick={() => zoomBy(1 / 1.25)} label="−" title="Zoom out" />
        <span
          style={{
            minWidth: 44,
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(scale * 100)}%
        </span>
        <ToolbarBtn onClick={() => zoomBy(1.25)} label="+" title="Zoom in" />
        <ToolbarBtn
          onClick={fitToScreen}
          label="⌖"
          title="Fit tree to viewport"
        />
        <ToolbarBtn
          onClick={() => {
            setScale(1);
            setTx(0);
            setTy(0);
          }}
          label="↺"
          title="Reset zoom"
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 10,
          bottom: 8,
          fontSize: 10.5,
          color: "var(--lb-text-3)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          pointerEvents: "none",
        }}
      >
        Drag to pan · scroll / pinch to zoom · ⌖ to refit
      </div>
    </div>
  );
}

function ToolbarBtn({
  onClick,
  label,
  title,
}: {
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        appearance: "none",
        border: "none",
        background: "transparent",
        color: "var(--lb-text)",
        cursor: "pointer",
        fontSize: 14,
        fontWeight: 800,
        width: 26,
        height: 26,
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--lb-bg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}
