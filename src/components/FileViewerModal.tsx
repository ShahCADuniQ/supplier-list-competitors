"use client";

// Cross-cutting file viewer used everywhere files are listed:
//   • Supplier portal — About us attachments
//   • Supplier portal — Catalogue → product drawer → category attachments
//   • Step-2 onboarding attachments
//   • Engineering admin — Suppliers → Attachments tab + product drawers
//
// Renders an in-page preview when the file type supports it (PDFs and
// images natively; xlsx / docx / pptx via Microsoft's Office Online
// embed viewer) and always exposes a "Download" button that forces a
// save even though the file lives on a different origin (Vercel Blob).
//
// The download path is what makes this component worth sharing — the
// browser's native <a download> attribute is ignored cross-origin, so
// we fetch the file as a blob and trigger the save via a blob: URL.

import { useEffect, useState } from "react";

type PreviewKind = "pdf" | "image" | "office" | "text" | "unsupported";

function previewKindFor(name: string, mime?: string | null): PreviewKind {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime?.startsWith("image/")) return "image";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["xls", "xlsx", "csv", "doc", "docx", "ppt", "pptx", "ods", "odt", "odp"].includes(ext)) return "office";
  if (["txt", "md", "log", "json", "yaml", "yml"].includes(ext)) return "text";
  return "unsupported";
}

// Force a save even though the blob lives on a different origin. The
// browser ignores the <a download> attribute when href is cross-origin
// (security feature), so we re-host the bytes in a same-origin blob:
// URL right before triggering the click.
export async function forceDownloadFile(url: string, name: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Safari has time to actually start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}

export default function FileViewerModal({
  url,
  name,
  mimeType,
  onClose,
}: {
  url: string;
  name: string;
  mimeType?: string | null;
  onClose: () => void;
}) {
  const kind = previewKindFor(name, mimeType);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Plain-text preview: fetch the body so we can render it inline. Cap
  // the size so a giant log doesn't lock the tab.
  useEffect(() => {
    if (kind !== "text") return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
        setTextBody(t.length > 500_000 ? t.slice(0, 500_000) + "\n\n…(truncated)" : t);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Couldn't load text");
      });
    return () => { cancelled = true; };
  }, [kind, url]);

  async function onDownload() {
    setDownloading(true);
    setErr(null);
    try {
      await forceDownloadFile(url, name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: "auto",
          width: "min(1200px, 96vw)",
          height: "min(90vh, 900px)",
          background: "var(--lb-bg-elev)",
          color: "var(--lb-text)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "var(--lb-shadow-lg)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            borderBottom: "1px solid var(--lb-border)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--lb-text-3)",
              }}
            >
              {kind === "pdf"
                ? "PDF preview"
                : kind === "image"
                  ? "Image preview"
                  : kind === "office"
                    ? "Office document preview"
                    : kind === "text"
                      ? "Text preview"
                      : "File"}
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={name}
            >
              {name}
            </div>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              fontSize: 12.5,
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            Open in new tab
          </a>
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              background: "var(--lb-accent)",
              border: "1px solid var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: downloading ? "wait" : "pointer",
              opacity: downloading ? 0.6 : 1,
            }}
          >
            {downloading ? "Downloading…" : "⬇ Download"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              fontSize: 16,
              borderRadius: 8,
              background: "transparent",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              cursor: "pointer",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {err && (
          <div
            style={{
              margin: 14,
              padding: 10,
              borderRadius: 8,
              background: "rgba(220,38,38,0.10)",
              border: "1px solid rgba(220,38,38,0.40)",
              color: "#dc2626",
              fontSize: 12.5,
            }}
          >
            {err}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, background: "var(--lb-bg-sunken)" }}>
          {kind === "pdf" && (
            <iframe
              src={url}
              title={name}
              style={{ width: "100%", height: "100%", border: "none", background: "white" }}
            />
          )}
          {kind === "image" && (
            <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", padding: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={name}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            </div>
          )}
          {kind === "office" && (
            <iframe
              src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`}
              title={name}
              style={{ width: "100%", height: "100%", border: "none", background: "white" }}
            />
          )}
          {kind === "text" && (
            <pre
              style={{
                width: "100%",
                height: "100%",
                margin: 0,
                padding: 16,
                overflow: "auto",
                background: "var(--lb-bg)",
                color: "var(--lb-text)",
                fontFamily: "var(--lb-font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {textBody ?? "Loading…"}
            </pre>
          )}
          {kind === "unsupported" && (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "grid",
                placeItems: "center",
                padding: 24,
                textAlign: "center",
              }}
            >
              <div style={{ maxWidth: 460 }}>
                <div style={{ fontSize: 42 }}>📄</div>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: "10px 0 6px" }}>
                  Preview not supported for this file type
                </h3>
                <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "0 0 16px" }}>
                  Use <strong>Download</strong> to save the file locally or
                  <strong> Open in new tab</strong> to let your browser try.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
