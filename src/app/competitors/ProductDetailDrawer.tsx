"use client";

// Right-side slide-out drawer for a single product. Replaces the inline
// expand-row pattern so users don't have to scroll the whole brand section
// to read details. The drawer holds the hero photo, an inline thumbnail
// rail to flip through every image, the spec table, and the attached files
// (each previewable inline via FilePreviewModal).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProductFilesResult } from "./research-actions";
import { refreshProductSpecsFromFiles } from "./add-actions";
import { ProgressPanel, consumeSseStream, formatDuration } from "./_progress";
import {
  deleteProductAttachment,
  deleteAllProductAttachments,
  deleteProduct,
  upsertProduct,
} from "./actions";
import {
  CANONICAL_KIND_LABELS,
  CANONICAL_KIND_ORDER,
  normalizeKind,
  type CanonicalKind,
} from "./_kinds";
import FilePreviewModal, { type PreviewItem } from "./FilePreviewModal";
import type {
  CompetitorProduct,
  CompetitorProductAttachment,
} from "@/db/schema";

type FullProduct = CompetitorProduct & {
  attachments: CompetitorProductAttachment[];
};

type Props = {
  product: FullProduct;
  brandName: string;
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
  onClose: () => void;
};

function fmtBytes(b: number) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}

// Machine-readable step → user-friendly label for the extract progress UI.
// Concrete text per master guide §5.1 ("Extracting page 3 of 12" beats
// "Working…"). Anything not in this map falls through to the raw key, which
// the server already logs.
const EXTRACT_STEP_LABELS: Record<string, string> = {
  starting: "Starting up",
  fetching: "Fetching the product page",
  "embedded-docs": "Reading embedded document list",
  "static-resilience": "Scanning JSON-LD + inline scripts for doc URLs",
  perplexity: "Asking Perplexity for downloadable docs",
  "anchor-scrape": "Scraping document links from HTML",
  rendering: "Headless render — clicking Downloads tabs + scrolling",
  "tab-variants": "Trying alternate tab URLs (#downloads, ?tab=…)",
  "ai-classify": "Claude classifying every URL on the page",
  "ai-classified": "Claude finished URL classification",
  "downloading-docs": "Downloading documents to our storage",
  "reading-specs": "Reading PDFs with Claude to fill specs",
  loading: "Loading product + attachments",
  "hash-check": "Cache check — inputs changed, re-running",
  "skipped-cache": "Skipped (inputs unchanged — cached result reused)",
  "fetching-pdfs": "Fetching PDF bytes for Claude",
  analyzing: "Claude reading every PDF",
  analyzed: "Claude returned extracted specs",
  merging: "Merging specs & writing to DB",
  done: "Done",
};

// Spec sections — every field that the Summary view tracks is rendered
// in the drawer too, organised by topic. Empty values show "—" so the user
// can see at a glance what hasn't been pulled from the PDFs yet.
const SPEC_SECTIONS: Array<{
  title: string;
  keys: Array<{ key: string; label: string }>;
}> = [
  {
    title: "Geometry",
    keys: [
      { key: "profileFaceSize", label: "Profile face" },
      { key: "length", label: "Length" },
      { key: "maxLength", label: "Max length" },
      { key: "cutout", label: "Cut-out" },
      { key: "dimensions", label: "Dimensions" },
      { key: "weight", label: "Weight" },
    ],
  },
  {
    title: "Photometry",
    keys: [
      { key: "lumens", label: "Lumens" },
      { key: "wattage", label: "Wattage" },
      { key: "efficacy", label: "Efficacy" },
      { key: "cct", label: "CCT" },
      { key: "cri", label: "CRI" },
      { key: "r9", label: "R9" },
      { key: "sdcm", label: "SDCM" },
      { key: "beamAngle", label: "Beam angle" },
      { key: "opticType", label: "Optic type" },
      { key: "ugr", label: "UGR (glare)" },
    ],
  },
  {
    title: "Electrical",
    keys: [
      { key: "voltage", label: "Voltage" },
      { key: "powerFactor", label: "Power factor" },
      { key: "inrushCurrent", label: "Inrush" },
      { key: "driverLocation", label: "Driver location" },
      { key: "driverType", label: "Driver type" },
      { key: "dimming", label: "Dimming" },
    ],
  },
  {
    title: "Form & mounting",
    keys: [
      { key: "mounting", label: "Mounting" },
      { key: "orientation", label: "Orientation" },
      { key: "lensType", label: "Lens type" },
      { key: "housingMaterial", label: "Housing material" },
      { key: "finishes", label: "Finishes" },
      { key: "colors", label: "Colors" },
    ],
  },
  {
    title: "Environment & safety",
    keys: [
      { key: "ipRating", label: "IP rating" },
      { key: "ikRating", label: "IK rating" },
      { key: "operatingTemp", label: "Operating temp" },
    ],
  },
  {
    title: "Lifecycle & standards",
    keys: [
      { key: "lifespan", label: "Lifespan" },
      { key: "warranty", label: "Warranty" },
      { key: "countryOfOrigin", label: "Country of origin" },
      { key: "certifications", label: "Certifications" },
    ],
  },
  {
    title: "Customisation",
    keys: [
      { key: "customization", label: "Customization" },
      { key: "accessories", label: "Accessories" },
      { key: "notes", label: "Notes" },
    ],
  },
];

// Flat list used by the edit form (every field, in display order).
const ALL_SPEC_KEYS = SPEC_SECTIONS.flatMap((s) => s.keys);
// Maintained as aliases for the existing edit-form code (used to be a
// simple flat array). Both edit and stat-coverage iterate this.
const PREVIEW_SPEC_KEYS = ALL_SPEC_KEYS.slice(0, 6);
const DETAIL_SPEC_KEYS = ALL_SPEC_KEYS.slice(6);

function renderVal(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return (v ?? "").toString().trim();
}

// Spec keys that store arrays (comma-separated lists in the UI).
const ARRAY_SPEC_KEYS = new Set<string>([
  "colors",
  "finishes",
  "certifications",
  "customization",
  "accessories",
]);
// Spec keys whose value benefits from a multi-line textarea.
const TEXTAREA_SPEC_KEYS = new Set<string>(["notes"]);

export default function ProductDetailDrawer({
  product,
  brandName,
  canEdit,
  onToast,
  onClose,
}: Props) {
  const router = useRouter();
  const [extractBusy, setExtractBusy] = useState(false);
  const [refreshSpecsBusy, setRefreshSpecsBusy] = useState(false);

  // §5 progress UX for the Extract Documents flow. Same architecture as
  // AddProductForm: SSE-driven percent bar tied to real work units,
  // elapsed/ETA, current-step label, heartbeat, cancel button, and a
  // completeness summary surfaced at the end.
  const [extractProgress, setExtractProgress] = useState<{
    startedAt: number;
    percent: number;
    step: string;
    detail: string | null;
  } | null>(null);
  const [extractSummary, setExtractSummary] = useState<
    | null
    | {
        ok: true;
        result: Extract<ProductFilesResult, { ok: true }>;
        elapsedSec: number;
      }
    | { ok: false; error: string; elapsedSec: number }
  >(null);
  const extractAbortRef = useRef<AbortController | null>(null);
  const extractTickRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!extractBusy) {
      if (extractTickRef.current) {
        window.clearInterval(extractTickRef.current);
        extractTickRef.current = null;
      }
      return;
    }
    extractTickRef.current = window.setInterval(
      () => setNowMs(Date.now()),
      500,
    );
    return () => {
      if (extractTickRef.current) {
        window.clearInterval(extractTickRef.current);
        extractTickRef.current = null;
      }
    };
  }, [extractBusy]);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  // Edit-mode lets the user override AI-extracted fields. Form state mirrors
  // every editable column on the product row + every spec key we render.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [form, setForm] = useState({
    name: product.name,
    productCode: product.productCode ?? "",
    productCategory: product.productCategory ?? "",
    description: product.description ?? "",
    sourceUrl: product.sourceUrl ?? "",
    specs: { ...(product.specs ?? {}) } as Record<string, string | string[]>,
  });
  // Drives the slide-in animation — we mount with translate(100%) and flip
  // to translate(0) on the next paint so the transition fires.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const images = product.imageUrls ?? [];
  const safeHero = Math.max(0, Math.min(images.length - 1, heroIndex));

  const previewItems: PreviewItem[] = [
    ...images.map((url, i) => ({
      url,
      name: `${product.name} — image ${i + 1}`,
      mimeType: "image/*",
      kind: "image",
    })),
    ...product.attachments.map((a) => ({
      url: a.url,
      name: a.name,
      mimeType: a.mimeType ?? null,
      kind: a.kind ?? null,
    })),
  ];

  const allAttachments = [...product.attachments];
  const attachmentsByKind: Record<CanonicalKind, typeof allAttachments> = {
    "spec-sheet": [],
    "ies-photometric": [],
    "cad-drawing": [],
    "bim-revit": [],
    "brochure": [],
    "installation": [],
    "manual": [],
    "warranty": [],
    "certification": [],
    "image": [],
    "other": [],
  };
  for (const a of allAttachments) {
    attachmentsByKind[normalizeKind(a.kind)].push(a);
  }
  for (const k of Object.keys(attachmentsByKind) as CanonicalKind[]) {
    attachmentsByKind[k].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function handleExtractFiles() {
    if (!canEdit) return;
    setExtractBusy(true);
    setExtractSummary(null);
    const startedAt = Date.now();
    setExtractProgress({
      startedAt,
      percent: 0,
      step: "starting",
      detail: "Sending request…",
    });

    const controller = new AbortController();
    extractAbortRef.current = controller;

    // TS-friendly mutable holder so onDone / onError can assign without
    // confusing control-flow narrowing later.
    const state: {
      result: Extract<ProductFilesResult, { ok: true }> | null;
      failResult: Extract<ProductFilesResult, { ok: false }> | null;
      streamError: string | null;
    } = { result: null, failResult: null, streamError: null };

    try {
      const res = await fetch("/api/competitors/extract-product-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ productId: product.id }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Stream request failed (HTTP ${res.status})`);
      }

      await consumeSseStream<ProductFilesResult>(res, {
        onProgress: (evt) =>
          setExtractProgress((prev) => ({
            startedAt,
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
        setExtractSummary({ ok: false, error: state.streamError, elapsedSec });
        onToast(state.streamError, true);
        return;
      }
      if (state.failResult) {
        setExtractSummary({
          ok: false,
          error: state.failResult.error,
          elapsedSec,
        });
        if (state.failResult.stack) {
          console.error("[aiExtractProductFiles]", state.failResult.stack);
        }
        onToast(state.failResult.error, true);
        return;
      }
      const r = state.result;
      if (!r) {
        const msg = "Stream ended without a result";
        setExtractSummary({ ok: false, error: msg, elapsedSec });
        onToast(msg, true);
        return;
      }

      setExtractProgress({
        startedAt,
        percent: 100,
        step: "done",
        detail: "Complete",
      });
      setExtractSummary({ ok: true, result: r, elapsedSec });
      router.refresh();

      const total = r.pdfsAttached + r.otherDocsAttached;
      const parts: string[] = [r.productName];
      parts.push(`${r.pdfsAttached} PDFs · ${r.otherDocsAttached} other docs`);
      if (r.specFilesRead > 0) {
        parts.push(
          `auto-refreshed ${r.specFieldsUpdated} spec field${r.specFieldsUpdated === 1 ? "" : "s"}`,
        );
      }
      if (r.fetchErrors) parts.push(`${r.fetchErrors} fetch errors`);
      if (total === 0) parts.push("(no files found)");
      onToast(parts.join(" · "), total === 0 && r.fetchErrors > 0);
    } catch (e) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const aborted =
        e instanceof DOMException && e.name === "AbortError";
      const message = aborted
        ? "Cancelled"
        : e instanceof Error
          ? e.message
          : "Doc extraction failed";
      setExtractSummary({ ok: false, error: message, elapsedSec });
      if (!aborted) onToast(message, true);
    } finally {
      setExtractBusy(false);
      extractAbortRef.current = null;
    }
  }

  function handleCancelExtract() {
    extractAbortRef.current?.abort();
  }

  async function handleRefreshSpecs() {
    if (!canEdit) return;
    setRefreshSpecsBusy(true);
    try {
      onToast(`Reading specs from files for ${product.name}…`);
      const r = await refreshProductSpecsFromFiles({
        productId: product.id,
        // Manual click should always re-run, even if inputs haven't changed
        // (the cache lives at the input-hash level, not at the model output
        // level — user may want a fresh extraction with current Claude).
        force: true,
      });
      router.refresh();
      onToast(
        `${r.productName}: read ${r.filesRead} file${r.filesRead === 1 ? "" : "s"}, updated ${r.fieldsUpdated} field${r.fieldsUpdated === 1 ? "" : "s"}`,
      );
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Refresh failed", true);
    } finally {
      setRefreshSpecsBusy(false);
    }
  }

  async function handleDeleteFile(id: number, name: string) {
    if (!canEdit) return;
    if (!confirm(`Delete "${name}"?`)) return;
    setDeletingId(id);
    try {
      await deleteProductAttachment(id);
      router.refresh();
      onToast(`Deleted ${name}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDeleteAllFiles() {
    if (!canEdit) return;
    if (
      !confirm(
        `Delete all ${product.attachments.length} file(s) attached to "${product.name}"?`,
      )
    )
      return;
    setDeleteAllBusy(true);
    try {
      const r = await deleteAllProductAttachments(product.id);
      router.refresh();
      onToast(`Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setDeleteAllBusy(false);
    }
  }

  function requestClose() {
    setEntered(false);
    // Wait for the slide-out transition before unmounting.
    setTimeout(onClose, 220);
  }

  async function handleSaveEdits() {
    if (!canEdit || saving) return;
    if (!form.name.trim()) {
      onToast("Name can't be empty", true);
      return;
    }
    setSaving(true);
    try {
      await upsertProduct({
        id: product.id,
        competitorId: product.competitorId,
        name: form.name.trim(),
        productCode: form.productCode.trim() || null,
        productCategory: form.productCategory.trim() || null,
        description: form.description.trim() || null,
        sourceUrl: form.sourceUrl.trim() || null,
        imageUrls: product.imageUrls ?? [],
        specs: form.specs,
      });
      router.refresh();
      setEditing(false);
      onToast("Saved changes");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Save failed", true);
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdits() {
    if (saving) return;
    setForm({
      name: product.name,
      productCode: product.productCode ?? "",
      productCategory: product.productCategory ?? "",
      description: product.description ?? "",
      sourceUrl: product.sourceUrl ?? "",
      specs: { ...(product.specs ?? {}) } as Record<string, string | string[]>,
    });
    setEditing(false);
  }

  async function handleDeleteProduct() {
    if (!canEdit || deletingProduct) return;
    if (
      !confirm(
        `Delete "${product.name}"? This also removes its ${product.attachments.length} attached file(s) and ${(product.imageUrls ?? []).length} image(s) from storage.`,
      )
    ) {
      return;
    }
    setDeletingProduct(true);
    try {
      await deleteProduct(product.id);
      router.refresh();
      onToast(`Deleted ${product.name}`);
      requestClose();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
      setDeletingProduct(false);
    }
  }

  // Helpers to update form fields
  function setField<K extends "name" | "productCode" | "productCategory" | "description" | "sourceUrl">(
    key: K,
    value: string,
  ) {
    setForm((s) => ({ ...s, [key]: value }));
  }
  function setSpecField(key: string, value: string) {
    setForm((s) => ({ ...s, specs: { ...s.specs, [key]: value } }));
  }
  function setSpecArrayField(key: string, value: string) {
    // Comma-separated entry → store as array.
    const arr = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setForm((s) => ({ ...s, specs: { ...s.specs, [key]: arr } }));
  }

  return (
    <div
      className={`pd-overlay${entered ? " entered" : ""}`}
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <aside className={`pd-drawer${entered ? " entered" : ""}`}>
        <header className="pd-head">
          <button
            type="button"
            className="pd-close"
            onClick={requestClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
          <div className="pd-title">
            <div className="pd-brand">{brandName}</div>
            {editing ? (
              <input
                className="pd-name-input"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="Product name"
                disabled={saving}
              />
            ) : (
              <h2 className="pd-name">{product.name}</h2>
            )}
            {!editing && (
              <div className="pd-meta">
                {product.productCode && <span>{product.productCode}</span>}
                {product.productCategory && <span>{product.productCategory}</span>}
              </div>
            )}
          </div>
          {canEdit && (
            <div className="pd-head-actions">
              {editing ? (
                <>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={handleSaveEdits}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={handleCancelEdits}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setEditing(true)}
                    title="Edit product fields manually"
                  >
                    ✎ Edit
                  </button>
                  <button
                    type="button"
                    className="btn sm pd-danger"
                    onClick={handleDeleteProduct}
                    disabled={deletingProduct}
                    title="Delete this product"
                  >
                    {deletingProduct ? "Deleting…" : "🗑 Delete"}
                  </button>
                </>
              )}
            </div>
          )}
        </header>

        <div className="pd-body">
          {images.length > 0 && (
            <section className="pd-gallery">
              <div className="pd-hero">
                <button
                  type="button"
                  className="pd-hero-img"
                  onClick={() => setPreviewIndex(safeHero)}
                  aria-label="Open full-size preview"
                  title="Click to enlarge"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={images[safeHero]}
                    alt={`${product.name} — image ${safeHero + 1}`}
                    onError={(e) => {
                      (e.currentTarget.style.display = "none");
                    }}
                  />
                </button>
                {images.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="pd-hero-nav pd-prev"
                      onClick={() =>
                        setHeroIndex((i) => (i - 1 + images.length) % images.length)
                      }
                      aria-label="Previous photo"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="pd-hero-nav pd-next"
                      onClick={() => setHeroIndex((i) => (i + 1) % images.length)}
                      aria-label="Next photo"
                    >
                      ›
                    </button>
                    <div className="pd-hero-counter">
                      {safeHero + 1} / {images.length}
                    </div>
                  </>
                )}
              </div>
              {images.length > 1 && (
                <div className="pd-thumbs">
                  {images.map((src, i) => (
                    <button
                      key={`${i}-${src}`}
                      type="button"
                      className={`pd-thumb${i === safeHero ? " active" : ""}`}
                      onClick={() => setHeroIndex(i)}
                      aria-label={`Show photo ${i + 1}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt={`${product.name} ${i + 1}`}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {editing ? (
            <section className="pd-section">
              <h3 className="pd-section-h">Identity</h3>
              <div className="pd-edit-grid">
                <label className="pd-edit-row">
                  <span className="pd-edit-label">Product code</span>
                  <input
                    className="pd-edit-input"
                    value={form.productCode}
                    onChange={(e) => setField("productCode", e.target.value)}
                    placeholder="SKU / model code"
                    disabled={saving}
                  />
                </label>
                <label className="pd-edit-row">
                  <span className="pd-edit-label">Category</span>
                  <input
                    className="pd-edit-input"
                    value={form.productCategory}
                    onChange={(e) => setField("productCategory", e.target.value)}
                    placeholder="Linear pendant, Recessed slot, …"
                    disabled={saving}
                  />
                </label>
                <label className="pd-edit-row pd-edit-row-full">
                  <span className="pd-edit-label">Source URL</span>
                  <input
                    type="url"
                    className="pd-edit-input"
                    value={form.sourceUrl}
                    onChange={(e) => setField("sourceUrl", e.target.value)}
                    placeholder="https://brand.com/product/…"
                    disabled={saving}
                  />
                </label>
                <label className="pd-edit-row pd-edit-row-full">
                  <span className="pd-edit-label">Description</span>
                  <textarea
                    className="pd-edit-textarea"
                    rows={3}
                    value={form.description}
                    onChange={(e) => setField("description", e.target.value)}
                    placeholder="1-2 sentence summary"
                    disabled={saving}
                  />
                </label>
              </div>
            </section>
          ) : (
            product.description && (
              <section className="pd-section">
                <p className="pd-desc">{product.description}</p>
              </section>
            )
          )}

          {editing ? (
            <section className="pd-section">
              <h3 className="pd-section-h">Specs</h3>
              <div className="pd-edit-grid">
                {[...PREVIEW_SPEC_KEYS, ...DETAIL_SPEC_KEYS].map(({ key, label }) => {
                  const isArray = ARRAY_SPEC_KEYS.has(key);
                  const isTextarea = TEXTAREA_SPEC_KEYS.has(key);
                  const value = isArray
                    ? renderVal(form.specs[key])
                    : (typeof form.specs[key] === "string" ? (form.specs[key] as string) : "");
                  return (
                    <label
                      key={key}
                      className={`pd-edit-row${isTextarea ? " pd-edit-row-full" : ""}`}
                    >
                      <span className="pd-edit-label">
                        {label}
                        {isArray && (
                          <span className="pd-edit-hint"> · comma-separated</span>
                        )}
                      </span>
                      {isTextarea ? (
                        <textarea
                          className="pd-edit-textarea"
                          rows={3}
                          value={value}
                          onChange={(e) =>
                            isArray
                              ? setSpecArrayField(key, e.target.value)
                              : setSpecField(key, e.target.value)
                          }
                          disabled={saving}
                        />
                      ) : (
                        <input
                          className="pd-edit-input"
                          value={value}
                          onChange={(e) =>
                            isArray
                              ? setSpecArrayField(key, e.target.value)
                              : setSpecField(key, e.target.value)
                          }
                          disabled={saving}
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="pd-section">
              <div className="pd-files-head">
                <h3 className="pd-section-h">Specs</h3>
                {(() => {
                  const filled = ALL_SPEC_KEYS.filter(({ key }) =>
                    renderVal((product.specs ?? {})[key]),
                  ).length;
                  const total = ALL_SPEC_KEYS.length;
                  return (
                    <span className="pd-files-count">
                      {filled} / {total} filled
                    </span>
                  );
                })()}
                {canEdit && (
                  <button
                    type="button"
                    className="btn primary sm"
                    style={{ marginLeft: "auto" }}
                    onClick={handleRefreshSpecs}
                    disabled={refreshSpecsBusy}
                    title="Read every attached PDF and the source page, then refresh profile face size, length, lumens, etc."
                  >
                    {refreshSpecsBusy ? "Reading…" : "🔄 Refresh from files"}
                  </button>
                )}
              </div>
              {SPEC_SECTIONS.map(({ title, keys }) => {
                const filledInGroup = keys.filter(({ key }) =>
                  renderVal((product.specs ?? {})[key]),
                ).length;
                return (
                  <div key={title} className="pd-spec-group">
                    <div className="pd-spec-group-h">
                      <span className="pd-spec-group-title">{title}</span>
                      <span className="pd-spec-group-count">
                        {filledInGroup} / {keys.length}
                      </span>
                    </div>
                    <dl className="pd-specs">
                      {keys.map(({ key, label }) => {
                        const raw = (product.specs ?? {})[key];
                        const isArray = Array.isArray(raw);
                        const arr = isArray
                          ? (raw as string[]).map((s) => s.trim()).filter(Boolean)
                          : [];
                        const stringVal = !isArray
                          ? ((raw ?? "") as string).toString().trim()
                          : "";
                        const empty = isArray ? arr.length === 0 : !stringVal;
                        return (
                          <div
                            key={key}
                            className={`pd-spec-row${empty ? " pd-spec-row-empty" : ""}`}
                          >
                            <dt>{label}</dt>
                            <dd>
                              {empty ? (
                                <span className="pd-spec-empty">—</span>
                              ) : isArray ? (
                                <span className="pd-spec-chips">
                                  {arr.map((v, i) => (
                                    <span key={i} className="pd-spec-chip">
                                      {v}
                                    </span>
                                  ))}
                                </span>
                              ) : (
                                <span className="pd-spec-value">{stringVal}</span>
                              )}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                );
              })}
            </section>
          )}

          <section className="pd-section">
            <div className="pd-files-head">
              <h3 className="pd-section-h">Files</h3>
              <span className="pd-files-count">
                {allAttachments.length} attached
              </span>
              {canEdit && allAttachments.length > 0 && (
                <button
                  type="button"
                  className="btn ghost xs"
                  onClick={handleDeleteAllFiles}
                  disabled={deleteAllBusy}
                  style={{ marginLeft: "auto", color: "#b91c1c" }}
                >
                  {deleteAllBusy ? "Deleting…" : "🗑 Delete all"}
                </button>
              )}
            </div>
            {canEdit && (
              <div className="pd-extract-bar">
                <button
                  className="btn primary sm"
                  onClick={handleExtractFiles}
                  disabled={extractBusy}
                  title="Crawl this product page for spec PDFs / IES / drawings"
                >
                  {extractBusy
                    ? "Extracting…"
                    : `✨ Extract documents${allAttachments.length > 0 ? " (re-run)" : ""}`}
                </button>
              </div>
            )}
            {extractProgress && (
              <ProgressPanel
                percent={extractProgress.percent}
                stepLabel={
                  EXTRACT_STEP_LABELS[extractProgress.step] ??
                  extractProgress.step
                }
                detail={extractProgress.detail}
                elapsedSec={(nowMs - extractProgress.startedAt) / 1000}
                etaSec={
                  extractProgress.percent > 2 && extractProgress.percent < 100
                    ? ((nowMs - extractProgress.startedAt) / 1000) *
                      ((100 - extractProgress.percent) /
                        extractProgress.percent)
                    : null
                }
                busy={extractBusy}
                onCancel={handleCancelExtract}
              />
            )}
            {extractSummary && (
              <ExtractCompletenessPanel summary={extractSummary} />
            )}
            {allAttachments.length === 0 ? (
              <p className="pd-empty">
                No files yet. Use Extract to crawl this product&apos;s downloads.
              </p>
            ) : (
              <div className="pd-files">
                {CANONICAL_KIND_ORDER.map((kind) => {
                  const list = attachmentsByKind[kind];
                  if (!list || list.length === 0) return null;
                  return (
                    <div key={kind} className="pd-files-group">
                      <div className="pd-files-group-h">
                        {CANONICAL_KIND_LABELS[kind]} · {list.length}
                      </div>
                      <div className="pd-files-list">
                        {list.map((a) => {
                          const ext = (a.name.split(".").pop() ?? "").toUpperCase();
                          const isDeleting = deletingId === a.id;
                          const attIdx = product.attachments.findIndex(
                            (x) => x.id === a.id,
                          );
                          const previewIdx = images.length + attIdx;
                          return (
                            <div key={a.id} className="pd-file-row">
                              <button
                                type="button"
                                className="pd-file"
                                onClick={() => setPreviewIndex(previewIdx)}
                                title="Preview in dashboard"
                              >
                                <span className="pd-file-ext">
                                  {ext.slice(0, 4) || "FILE"}
                                </span>
                                <span className="pd-file-info">
                                  <span className="pd-file-name">{a.name}</span>
                                  <span className="pd-file-meta">
                                    {fmtBytes(a.size)}
                                  </span>
                                </span>
                                <span className="pd-file-eye">👁</span>
                              </button>
                              {canEdit && (
                                <button
                                  type="button"
                                  className="pd-file-del"
                                  onClick={() => handleDeleteFile(a.id, a.name)}
                                  disabled={isDeleting}
                                  aria-label={`Delete ${a.name}`}
                                  title="Delete this file"
                                >
                                  {isDeleting ? "…" : "✕"}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {product.sourceUrl && (
            <section className="pd-section">
              <a
                className="pd-source"
                href={product.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on competitor&apos;s site ↗
              </a>
            </section>
          )}
        </div>
      </aside>

      {previewIndex !== null && previewItems.length > 0 && (
        <FilePreviewModal
          items={previewItems}
          startIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}

// Completeness panel for the Extract Documents flow — §5.3 Layer 3. Shows
// PDFs attached, other docs attached, fetch errors, and the count of spec
// fields auto-refreshed so the user sees the full picture instead of just
// "done".
function ExtractCompletenessPanel(props: {
  summary:
    | {
        ok: true;
        result: Extract<ProductFilesResult, { ok: true }>;
        elapsedSec: number;
      }
    | { ok: false; error: string; elapsedSec: number };
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
  const total = result.pdfsAttached + result.otherDocsAttached;
  const allOk = result.fetchErrors === 0 && total > 0;
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
        <strong>{result.productName}</strong>{" "}
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
          Docs:{" "}
          <strong
            style={{
              color: allOk
                ? "rgb(74,222,128)"
                : total > 0
                  ? "rgb(250,204,21)"
                  : "rgb(239,68,68)",
            }}
          >
            {total}
          </strong>{" "}
          attached ({result.pdfsAttached} PDFs, {result.otherDocsAttached}{" "}
          other)
        </span>
        {result.fetchErrors > 0 && (
          <span style={{ color: "rgb(250,204,21)" }}>
            {result.fetchErrors} fetch error(s)
          </span>
        )}
        <span>
          Specs:{" "}
          <strong>
            {result.specFieldsUpdated} field
            {result.specFieldsUpdated === 1 ? "" : "s"} updated
          </strong>{" "}
          from {result.specFilesRead} file
          {result.specFilesRead === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
