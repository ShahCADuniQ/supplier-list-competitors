"use client";

// In-app preview for product files. Handles:
//   - Images: rendered inline at full size with prev/next navigation
//   - PDFs:   browser-native viewer via <iframe> + download fallback
//   - Other:  download / open-in-new-tab fallback (we don't try to render
//             arbitrary file types like .ies / .dwg in the browser)
//
// Used by BenchmarkProductCard so PDFs and images stay in the dashboard
// instead of opening in a new tab or downloading on click.

import { useEffect, useState } from "react";

export type PreviewItem = {
  url: string;
  name: string;
  mimeType?: string | null;
  /** "image" | "spec-sheet" | "ies" | etc. — informs the renderer choice. */
  kind?: string | null;
};

function inferKind(item: PreviewItem): "image" | "pdf" | "other" {
  const m = (item.mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  // Fall back to URL extension (blob URLs sometimes lack mimeType).
  const path = item.url.split("?")[0].toLowerCase();
  if (/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  // Kind hint from server-side classifyDocument
  if (item.kind === "image") return "image";
  if (item.kind === "spec-sheet" || item.kind === "brochure" || item.kind === "installation" || item.kind === "manual" || item.kind === "warranty" || item.kind === "certification") {
    return "pdf";
  }
  return "other";
}

type Props = {
  items: PreviewItem[];
  startIndex: number;
  onClose: () => void;
};

export default function FilePreviewModal({ items, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setIndex((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [items.length, onClose]);

  if (items.length === 0) return null;
  const safeIndex = Math.max(0, Math.min(items.length - 1, index));
  const current = items[safeIndex];
  const kind = inferKind(current);

  return (
    <div
      className="fp-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fp-modal">
        <div className="fp-head">
          <div className="fp-title">
            <span className="fp-name" title={current.name}>{current.name}</span>
            <span className="fp-counter">
              {safeIndex + 1} / {items.length}
            </span>
          </div>
          <div className="fp-actions">
            <a
              className="fp-btn"
              href={current.url}
              download={current.name}
              title="Download"
            >
              ⬇
            </a>
            <a
              className="fp-btn"
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
            >
              ↗
            </a>
            <button
              type="button"
              className="fp-btn fp-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="fp-body">
          {kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={current.url}
              className="fp-image"
              src={current.url}
              alt={current.name}
            />
          )}
          {kind === "pdf" && (
            <iframe
              key={current.url}
              className="fp-pdf"
              src={current.url}
              title={current.name}
            />
          )}
          {kind === "other" && (
            <div className="fp-other">
              <p>
                <strong>{current.name}</strong>
              </p>
              <p>This file type can&apos;t be previewed in the browser.</p>
              <div className="fp-other-actions">
                <a className="btn primary" href={current.url} download={current.name}>
                  Download
                </a>
                <a className="btn" href={current.url} target="_blank" rel="noopener noreferrer">
                  Open in new tab
                </a>
              </div>
            </div>
          )}
        </div>

        {items.length > 1 && (
          <>
            <button
              type="button"
              className="fp-nav fp-prev"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={safeIndex === 0}
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              type="button"
              className="fp-nav fp-next"
              onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
              disabled={safeIndex === items.length - 1}
              aria-label="Next"
            >
              ›
            </button>
          </>
        )}

        {items.length > 1 && (
          <div className="fp-strip">
            {items.map((it, i) => {
              const k = inferKind(it);
              const active = i === safeIndex;
              return (
                <button
                  key={`${i}-${it.url}`}
                  type="button"
                  className={`fp-thumb${active ? " active" : ""}`}
                  onClick={() => setIndex(i)}
                  aria-label={`Show ${it.name}`}
                >
                  {k === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.url} alt={it.name} loading="lazy" />
                  ) : (
                    <span className="fp-thumb-ext">
                      {(it.name.split(".").pop() ?? "").toUpperCase().slice(0, 4) ||
                        (k === "pdf" ? "PDF" : "FILE")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
