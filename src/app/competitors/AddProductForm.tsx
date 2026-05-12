"use client";

// User-curated product entry. The user pastes a URL, drops PDFs or images,
// optionally adds a free-form hint, and the AI figures out the brand and
// extracts the product. New brands get auto-created in the active collection;
// existing brands accumulate the new product into their section.

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { aiAddProductFromInput, type AddedAttachment } from "./add-actions";

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function reset() {
    setUrl("");
    setHint("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFiles(picked: FileList | File[]) {
    const list = Array.from(picked);
    if (list.length === 0) return;
    setStatus(`Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`);
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
    setStatus(null);
  }

  async function handleSubmit() {
    if (busy) return;
    if (!url.trim() && files.length === 0 && !hint.trim()) {
      onToast("Add a URL, a file, or a hint first", true);
      return;
    }
    setBusy(true);
    setStatus("Reading inputs…");
    try {
      const trimmedUrl = url.trim();
      if (trimmedUrl) {
        // Static fetch + render + Perplexity fallback can take 30–90s end-to-end.
        // Keep the user looking at something useful while it runs.
        setStatus(
          `Fetching ${(() => {
            try {
              return new URL(trimmedUrl).host;
            } catch {
              return "page";
            }
          })()} (and falling back to Perplexity if blocked)…`,
        );
      } else {
        setStatus("Reading inputs…");
      }
      const r = await aiAddProductFromInput({
        collectionId,
        url: trimmedUrl || undefined,
        attachments: files,
        hint: hint.trim() || undefined,
        niche,
      });
      if (!r.ok) {
        if (r.stack) console.error("[aiAddProduct]", r.stack);
        onToast(r.error, true);
        return;
      }
      const parts: string[] = [];
      parts.push(r.brandCreated ? `New brand: ${r.brandName}` : r.brandName);
      parts.push(`+ ${r.productName}`);
      if (r.attachedFileCount > 0) {
        parts.push(
          `${r.attachedFileCount} file${r.attachedFileCount === 1 ? "" : "s"} attached`,
        );
      }
      if (r.imageUrls.length > 0) {
        parts.push(
          `${r.imageUrls.length} image${r.imageUrls.length === 1 ? "" : "s"}`,
        );
      }
      if (r.sourceMode !== "static") {
        parts.push(`source: ${r.sourceMode}`);
      }
      onToast(parts.join(" · "));
      onAdded?.({
        brandId: r.brandId,
        brandName: r.brandName,
        productId: r.productId,
        brandCreated: r.brandCreated,
      });
      reset();
      setOpen(false);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Could not add product", true);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

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
          onClick={() => {
            reset();
            setOpen(false);
          }}
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
            disabled={busy}
          />
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

      {status && (
        <div className="add-product-status">{status}</div>
      )}

      <div className="add-product-actions">
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy ? "Working…" : "Add product"}
        </button>
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
