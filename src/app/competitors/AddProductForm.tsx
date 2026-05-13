"use client";

// User-curated product entry. The user pastes a URL, drops PDFs or images,
// optionally adds a free-form hint, and the AI figures out the brand and
// extracts the product. New brands get auto-created in the active collection;
// existing brands accumulate the new product into their section.
//
// Posts to the SSE endpoint `/api/competitors/add-product` so the user sees
// the §5 progress UX: 0–100% bar tied to real work units, elapsed + ETA,
// current-step label, heartbeat (token stream from the server), cancel
// button. At the end we render a completeness summary that lists how many
// of the discovered images actually landed in our blob storage and which
// source URLs failed — per the master guide, never silently skip.

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import type {
  AddedAttachment,
  AddProductCompleteness,
  AddProductResult,
} from "./add-actions";
import { ProgressPanel, consumeSseStream, formatDuration } from "./_progress";

type Props = {
  collectionId: number;
  collectionName: string;
  /** Niche label (e.g. "Indoor Linear Light") sent to the AI as a hint. */
  niche: string;
  onToast: (msg: string, err?: boolean) => void;
  /** Called once the product is added so the parent view can refresh. */
  onAdded?: (result: {
    brandId: number;
    brandName: string;
    productId: number;
    brandCreated: boolean;
  }) => void;
};

function safeFileName(name: string) {
  return (
    (name || "file")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "file"
  );
}

// Map machine-readable step → short label shown next to the bar. Anything
// we don't have a label for falls through to the raw step key (which the
// server logs anyway).
const STEP_LABELS: Record<string, string> = {
  starting: "Starting up",
  fetching: "Fetching the page",
  rendering: "Headless render (page didn't have static text)",
  perplexity: "Asking Perplexity to read it",
  "perplexity-ok": "Perplexity returned content",
  "perplexity-empty": "Perplexity returned nothing — falling back",
  "reading-files": "Reading your uploaded files",
  "ai-extract": "Extracting structured product data",
  "ai-extracted": "AI returned an extraction",
  "images-discovered": "Found product images",
  "downloading-images": "Downloading product images to our storage",
  "downloading-images-retry": "Retrying failed images",
  "images-stored": "Images stored",
  saving: "Saving the product row",
  "attaching-files": "Attaching your uploaded files",
  "attaching-docs": "Attaching spec sheets & docs",
  "docs-attached": "Spec sheets attached",
  done: "Done",
};

type ProgressState = {
  startedAt: number;
  percent: number;
  step: string;
  detail: string | null;
};

export default function AddProductForm({
  collectionId,
  collectionName,
  niche,
  onToast,
  onAdded,
}: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");
  const [files, setFiles] = useState<AddedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [summary, setSummary] = useState<
    | null
    | {
        ok: true;
        result: Extract<AddProductResult, { ok: true }>;
        elapsedSec: number;
      }
    | {
        ok: false;
        error: string;
        elapsedSec: number;
      }
  >(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tickRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Drive elapsed/ETA: tick once per second while busy. Keeps the time
  // indicator alive (§5.1 — update at least every 2s).
  useEffect(() => {
    if (!busy) {
      if (tickRef.current) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    tickRef.current = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [busy]);

  function reset() {
    setUrl("");
    setHint("");
    setFiles([]);
    setSummary(null);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFiles(picked: FileList | File[]) {
    const list = Array.from(picked);
    if (list.length === 0) return;
    setUploading(true);
    setUploadStatus(
      `Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`,
    );
    for (const f of list) {
      try {
        const pathname = `ai-temp/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        setFiles((s) => [
          ...s,
          {
            url: blob.url,
            name: f.name,
            mime: f.type,
            size: f.size,
            blobPathname: blob.pathname,
          },
        ]);
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
    setUploading(false);
    setUploadStatus(null);
  }

  async function handleSubmit() {
    if (busy) return;
    if (!url.trim() && files.length === 0 && !hint.trim()) {
      onToast("Add a URL, a file, or a hint first", true);
      return;
    }
    setBusy(true);
    setSummary(null);
    const startedAt = Date.now();
    setProgress({
      startedAt,
      percent: 0,
      step: "starting",
      detail: "Sending request…",
    });

    const controller = new AbortController();
    abortRef.current = controller;

    // Wrap mutable closure state in a ref-style holder so TS's
    // control-flow analysis still narrows when we inspect it later.
    const state: {
      result: Extract<AddProductResult, { ok: true }> | null;
      failResult: Extract<AddProductResult, { ok: false }> | null;
      streamError: string | null;
    } = { result: null, failResult: null, streamError: null };

    try {
      const res = await fetch("/api/competitors/add-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          collectionId,
          url: url.trim() || undefined,
          attachments: files,
          hint: hint.trim() || undefined,
          niche,
        }),
      });

      if (!res.ok || !res.body) {
        const msg = `Stream request failed (HTTP ${res.status})`;
        try {
          const text = await res.text();
          if (text) throw new Error(`${msg}: ${text.slice(0, 300)}`);
        } catch {
          /* fall through */
        }
        throw new Error(msg);
      }

      await consumeSseStream<AddProductResult>(res, {
        onProgress: (evt) =>
          setProgress((prev) => ({
            startedAt,
            // Clamp [0,100] and never animate backwards — even if the
            // server emits an out-of-order percent (e.g. retry path),
            // the bar should only ever move forward.
            percent: Math.max(
              prev?.percent ?? 0,
              Math.min(100, Math.max(0, evt.percent ?? 0)),
            ),
            step: evt.step,
            detail: evt.detail ?? null,
          })),
        onDone: (result) => {
          if (result.ok) state.result = result;
          else state.failResult = result;
        },
        onError: (message) => {
          state.streamError = message;
        },
      });

      const elapsedSec = (Date.now() - startedAt) / 1000;

      if (state.streamError) {
        setSummary({ ok: false, error: state.streamError, elapsedSec });
        onToast(state.streamError, true);
        return;
      }
      if (state.failResult) {
        setSummary({ ok: false, error: state.failResult.error, elapsedSec });
        onToast(state.failResult.error, true);
        return;
      }
      const finalResult = state.result;
      if (!finalResult) {
        const msg = "Stream ended without a result";
        setSummary({ ok: false, error: msg, elapsedSec });
        onToast(msg, true);
        return;
      }

      setProgress({
        startedAt,
        percent: 100,
        step: "done",
        detail: "Complete",
      });
      setSummary({ ok: true, result: finalResult, elapsedSec });

      const c = finalResult.completeness;
      const summaryParts: string[] = [];
      summaryParts.push(
        finalResult.brandCreated
          ? `New brand: ${finalResult.brandName}`
          : finalResult.brandName,
      );
      summaryParts.push(`+ ${finalResult.productName}`);
      summaryParts.push(
        `${c.imagesStored}/${c.imagesDiscovered} image${c.imagesDiscovered === 1 ? "" : "s"}`,
      );
      if (finalResult.attachedFileCount > 0) {
        summaryParts.push(
          `${finalResult.attachedFileCount} file${finalResult.attachedFileCount === 1 ? "" : "s"}`,
        );
      }
      onToast(summaryParts.join(" · "));
      onAdded?.({
        brandId: finalResult.brandId,
        brandName: finalResult.brandName,
        productId: finalResult.productId,
        brandCreated: finalResult.brandCreated,
      });
    } catch (e) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const aborted =
        e instanceof DOMException && e.name === "AbortError";
      const message = aborted
        ? "Cancelled"
        : e instanceof Error
          ? e.message
          : "Could not add product";
      setSummary({ ok: false, error: message, elapsedSec });
      if (!aborted) onToast(message, true);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function handleClose() {
    if (busy) return;
    reset();
    setOpen(false);
  }

  // ── Derived values for the progress bar ──
  const elapsedSec = progress ? (nowMs - progress.startedAt) / 1000 : 0;
  const etaSec =
    progress && progress.percent > 2 && progress.percent < 100
      ? (elapsedSec * (100 - progress.percent)) / progress.percent
      : null;
  const stepLabel = progress
    ? STEP_LABELS[progress.step] ?? progress.step
    : "";

  if (!open) {
    return (
      <div className="add-product-trigger">
        <button
          type="button"
          className="btn primary"
          onClick={() => setOpen(true)}
        >
          ✨ Add a product to <strong>{collectionName}</strong>
        </button>
        <span className="add-product-trigger-hint">
          Paste a URL, drop a PDF, or upload images — we figure out the brand.
        </span>
      </div>
    );
  }

  return (
    <div className="add-product-card">
      <div className="add-product-head">
        <strong>Add a product</strong>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          {collectionName}
          {niche ? ` · niche: ${niche}` : ""}
        </span>
        <button
          type="button"
          className="btn ghost xs"
          onClick={handleClose}
          style={{ marginLeft: "auto" }}
          disabled={busy}
        >
          ✕
        </button>
      </div>

      <label className="add-product-row">
        <span className="add-product-label">Product page URL</span>
        <input
          type="url"
          className="add-product-input"
          placeholder="https://www.lumenpulse.com/products/lumenline-cove"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
      </label>

      <div className="add-product-row">
        <span className="add-product-label">Spec sheet / images</span>
        <div className="add-product-files">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
            }}
            disabled={busy || uploading}
          />
          {uploadStatus && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              {uploadStatus}
            </div>
          )}
          {files.length > 0 && (
            <ul className="add-product-files-list">
              {files.map((f, i) => (
                <li key={i}>
                  <span>{f.name}</span>
                  <button
                    type="button"
                    className="add-product-file-rm"
                    onClick={() =>
                      setFiles((s) => s.filter((_, idx) => idx !== i))
                    }
                    disabled={busy}
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <label className="add-product-row">
        <span className="add-product-label">Hint (optional)</span>
        <input
          type="text"
          className="add-product-input"
          placeholder="e.g. 'XAL Slot 4 — found at Light + Building 2026'"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          disabled={busy}
        />
      </label>

      {progress && (
        <ProgressPanel
          percent={progress.percent}
          stepLabel={stepLabel}
          detail={progress.detail}
          elapsedSec={elapsedSec}
          etaSec={etaSec}
          busy={busy}
          onCancel={handleCancel}
        />
      )}

      {summary && <CompletenessPanel summary={summary} />}

      <div className="add-product-actions">
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={busy || uploading}
        >
          {busy ? "Working…" : summary?.ok ? "Add another" : "Add product"}
        </button>
        {summary && !summary.ok && (
          <button
            type="button"
            className="btn ghost"
            onClick={handleSubmit}
            disabled={busy}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={reset}
          disabled={busy}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// Completeness panel — §5.3 Layer 3: surface what got filled, what didn't,
// and exactly which image URLs failed so the user can see (rather than
// guess) whether the job actually finished.
function CompletenessPanel(props: {
  summary:
    | {
        ok: true;
        result: Extract<AddProductResult, { ok: true }>;
        elapsedSec: number;
      }
    | {
        ok: false;
        error: string;
        elapsedSec: number;
      };
}) {
  const { summary } = props;
  if (!summary.ok) {
    return (
      <div
        role="alert"
        style={{
          marginTop: 12,
          padding: "10px 14px",
          borderRadius: 10,
          background: "rgba(239, 68, 68, 0.12)",
          border: "1px solid rgba(239, 68, 68, 0.32)",
          fontSize: 13,
        }}
      >
        <strong>Failed</strong> after {formatDuration(summary.elapsedSec)} —{" "}
        {summary.error}
      </div>
    );
  }

  const { result, elapsedSec } = summary;
  const c: AddProductCompleteness = result.completeness;
  const allImagesIn = c.imagesDiscovered > 0 && c.imagesFailed.length === 0;

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background: "rgba(34, 197, 94, 0.10)",
        border: "1px solid rgba(34, 197, 94, 0.32)",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div>
        <strong>
          {result.brandCreated
            ? `New brand: ${result.brandName}`
            : result.brandName}
        </strong>{" "}
        — {result.productName}{" "}
        <span style={{ color: "var(--lb-text-2, rgba(255,255,255,0.66))" }}>
          ({formatDuration(elapsedSec)})
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--lb-text-2, rgba(255,255,255,0.66))",
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        <span>
          Images:{" "}
          <strong
            style={{
              color: allImagesIn
                ? "rgb(74,222,128)"
                : c.imagesStored > 0
                  ? "rgb(250,204,21)"
                  : "rgb(239,68,68)",
            }}
          >
            {c.imagesStored} / {c.imagesDiscovered}
          </strong>{" "}
          stored via {c.imageSource === "none" ? "no source" : c.imageSource}
        </span>
        <span>Files: {result.attachedFileCount}</span>
        <span>Source: {result.sourceMode}</span>
      </div>
      {c.imagesFailed.length > 0 && (
        <details style={{ fontSize: 12 }}>
          <summary
            style={{
              cursor: "pointer",
              color: "rgb(250,204,21)",
            }}
          >
            {c.imagesFailed.length} image
            {c.imagesFailed.length === 1 ? "" : "s"} couldn&apos;t be
            downloaded — show
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {c.imagesFailed.slice(0, 8).map((u) => (
              <li
                key={u}
                style={{
                  wordBreak: "break-all",
                  color: "var(--lb-text-2, rgba(255,255,255,0.66))",
                }}
              >
                {u}
              </li>
            ))}
            {c.imagesFailed.length > 8 && (
              <li style={{ color: "var(--lb-text-2, rgba(255,255,255,0.55))" }}>
                …and {c.imagesFailed.length - 8} more
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
