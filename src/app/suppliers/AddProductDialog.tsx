"use client";

// "+ Add product" dialog mounted on the Supplier Catalogue overview.
// Two tabs:
//   1) From URL — Perplexity + Claude auto-fill (uses /api/suppliers/add-product/extract).
//   2) Manual   — pure form entry.
// On final submit (either tab), POSTs to /api/suppliers/add-product/commit.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProgressPanel,
  consumeSseStream,
  formatDuration,
  type StreamProgressEvent,
} from "@/app/competitors/_progress";
import { SUPPLIER_CATEGORIES } from "./supplier-inventory-constants";
import { deriveBrandFromUrl, deriveWebsiteFromUrl } from "@/lib/ai/url-brand";
import type {
  AddSupplierProductExtractResult,
  CommitSupplierProductInput,
  CommitSupplierProductResult,
} from "./add-product-actions";

type SupplierOption = { id: number; name: string };

export default function AddProductDialog({
  open,
  onClose,
  onCreated,
  suppliers,
  preselectedSupplierId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
}) {
  const [tab, setTab] = useState<"url" | "manual">("url");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  return (
    <ModalShell title="+ Add product to the supplier catalogue" onClose={onClose}>
      <TabBar tab={tab} setTab={setTab} />
      {err && <ErrorBanner message={err} />}
      {tab === "url" ? (
        <UrlTab
          suppliers={suppliers}
          preselectedSupplierId={preselectedSupplierId}
          onError={setErr}
          onBusy={setBusy}
          busy={busy}
          onCreated={() => {
            onCreated();
            onClose();
          }}
        />
      ) : (
        <ManualTab
          suppliers={suppliers}
          preselectedSupplierId={preselectedSupplierId}
          onError={setErr}
          onBusy={setBusy}
          busy={busy}
          onCreated={() => {
            onCreated();
            onClose();
          }}
        />
      )}
    </ModalShell>
  );
}

// ── Tab bar ─────────────────────────────────────────────────────────────────
function TabBar({
  tab,
  setTab,
}: {
  tab: "url" | "manual";
  setTab: (t: "url" | "manual") => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 6,
        padding: 4,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderRadius: 999,
        marginBottom: 12,
        alignSelf: "flex-start",
      }}
    >
      {(["url", "manual"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          style={{
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: 700,
            borderRadius: 999,
            border: "1px solid transparent",
            background: tab === t ? "var(--lb-bg-elev)" : "transparent",
            color: tab === t ? "var(--lb-text)" : "var(--lb-text-3)",
            cursor: "pointer",
          }}
        >
          {t === "url" ? "From URL (AI)" : "Manual"}
        </button>
      ))}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 10,
        marginBottom: 12,
        borderRadius: 8,
        background: "rgba(220,38,38,0.10)",
        border: "1px solid rgba(220,38,38,0.40)",
        color: "#dc2626",
        fontSize: 12.5,
      }}
    >
      {message}
    </div>
  );
}

// ── Manual tab ──────────────────────────────────────────────────────────────
function ManualTab({
  suppliers,
  preselectedSupplierId,
  onError,
  onBusy,
  busy,
  onCreated,
}: {
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
  onError: (msg: string | null) => void;
  onBusy: (b: boolean) => void;
  busy: boolean;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState<number | null>(
    preselectedSupplierId,
  );
  const [supplierQuery, setSupplierQuery] = useState("");
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [supplierList, setSupplierList] = useState<SupplierOption[]>(suppliers);
  const [name, setName] = useState("");
  const [productCode, setProductCode] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [productUrl, setProductUrl] = useState("");

  const filteredSuppliers = useMemo(() => {
    const q = supplierQuery.trim().toLowerCase();
    if (!q) return supplierList;
    return supplierList.filter((s) => s.name.toLowerCase().includes(q));
  }, [supplierList, supplierQuery]);

  async function submit() {
    onError(null);
    if (!supplierId) {
      onError("Pick a supplier (or create a new one) first.");
      return;
    }
    if (!name.trim()) {
      onError("Product name is required.");
      return;
    }
    onBusy(true);
    try {
      // Existing-code check — offer to link as alternative if a match exists.
      let linkTo: string | null = null;
      const code = productCode.trim();
      if (code) {
        const matchRes = await fetch(
          `/api/suppliers/find-by-code?code=${encodeURIComponent(code)}`,
        )
          .then((r) => (r.ok ? r.json() : { candidates: [] }))
          .catch(() => ({ candidates: [] }));
        const cands: Array<{ globalProductId: string; supplierName: string }> =
          matchRes.candidates ?? [];
        if (cands.length > 0) {
          const list = cands
            .map((c) => c.supplierName)
            .filter((s, i, arr) => arr.indexOf(s) === i)
            .join(", ");
          const ok = window.confirm(
            `Product code "${code}" already exists under ${list}.\n\nLink this new entry as an alternative supplier on that cluster?\n\nOK = Link as alternative\nCancel = Keep as a separate product`,
          );
          if (ok) linkTo = cands[0].globalProductId;
        }
      }
      const body: CommitSupplierProductInput = {
        supplier: { kind: "existing", supplierId },
        linkToGlobalProductId: linkTo,
        product: {
          name,
          productCode: productCode || null,
          category: category || null,
          description: description || null,
          productUrl: productUrl.trim() || null,
          thumbnailUrl: null,
          imageUrls: [],
        },
        configurations: [],
      };
      const res = await fetch("/api/suppliers/add-product/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Commit failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  }

  const selectedSupplierName =
    supplierList.find((s) => s.id === supplierId)?.name ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Supplier *">
        {selectedSupplierName && (
          <div
            style={{
              padding: "6px 10px",
              marginBottom: 6,
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              background: "color-mix(in srgb, var(--lb-accent) 15%, transparent)",
              border: "1px solid var(--lb-accent)",
              color: "var(--lb-text)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              alignSelf: "flex-start",
            }}
          >
            {selectedSupplierName}
            <button
              type="button"
              onClick={() => setSupplierId(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--lb-text-2)",
                cursor: "pointer",
                fontSize: 12,
                padding: 0,
              }}
              aria-label="Clear supplier"
            >
              ×
            </button>
          </div>
        )}
        <input
          type="search"
          value={supplierQuery}
          onChange={(e) => setSupplierQuery(e.target.value)}
          placeholder="Search suppliers…"
          style={INPUT_STYLE}
        />
        <div
          style={{
            marginTop: 6,
            maxHeight: 140,
            overflowY: "auto",
            border: "1px solid var(--lb-border)",
            borderRadius: 8,
          }}
        >
          {filteredSuppliers.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSupplierId(s.id);
                setSupplierQuery("");
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: s.id === supplierId ? "var(--lb-bg-elev)" : "transparent",
                color: "var(--lb-text)",
                border: "none",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {s.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowNewSupplier(true)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              background: "transparent",
              color: "var(--lb-accent)",
              border: "none",
              borderTop: "1px solid var(--lb-border)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            + Create new supplier
          </button>
        </div>
      </Field>

      <Field label="Name *">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Product code">
        <input
          value={productCode}
          onChange={(e) => setProductCode(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— select a category —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
        />
      </Field>
      <Field label="Product URL (optional)">
        <input
          value={productUrl}
          onChange={(e) => setProductUrl(e.target.value)}
          placeholder="https://www.brand.com/products/..."
          style={INPUT_STYLE}
        />
      </Field>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Creating…" : "Create product"}
        </button>
      </div>

      {showNewSupplier && (
        <NewSupplierSubDialog
          onClose={() => setShowNewSupplier(false)}
          onCreated={(s) => {
            setShowNewSupplier(false);
            setSupplierList((prev) => [...prev, s]);
            setSupplierId(s.id);
          }}
        />
      )}
    </div>
  );
}

// ── URL tab (extraction + commit) ───────────────────────────────────────────
function UrlTab({
  suppliers,
  preselectedSupplierId,
  onError,
  onBusy,
  busy,
  onCreated,
}: {
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
  onError: (msg: string | null) => void;
  onBusy: (b: boolean) => void;
  busy: boolean;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [supplierHint, setSupplierHint] = useState(
    preselectedSupplierId
      ? suppliers.find((s) => s.id === preselectedSupplierId)?.name ?? ""
      : "",
  );
  const [categoryHint, setCategoryHint] = useState("");
  const [progress, setProgress] = useState<StreamProgressEvent | null>(null);
  const [extracted, setExtracted] =
    useState<AddSupplierProductExtractResult | null>(null);
  const startedAtRef = useRef<number>(0);
  const [nowMs, setNowMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  async function startExtract() {
    onError(null);
    setExtracted(null);
    setProgress(null);
    const trimmed = url.trim();
    if (!trimmed) {
      onError("URL is required.");
      return;
    }
    onBusy(true);
    startedAtRef.current = Date.now();
    setNowMs(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/suppliers/add-product/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          supplierHint: supplierHint || undefined,
          categoryHint: categoryHint || undefined,
        }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Extract failed (${res.status})`);
      }
      await consumeSseStream<AddSupplierProductExtractResult>(res, {
        onProgress: (e) => setProgress(e),
        onDone: (result) => setExtracted(result),
        onError: (msg) => onError(msg),
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        onError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      onBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  if (extracted) {
    return (
      <ConfirmExtraction
        extracted={extracted}
        suppliers={suppliers}
        sourcePageUrl={url.trim()}
        onError={onError}
        onCancel={() => {
          setExtracted(null);
          setProgress(null);
        }}
        onCreated={onCreated}
      />
    );
  }

  const elapsedSec = busy ? (nowMs - startedAtRef.current) / 1000 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Product URL *">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.brand.com/products/..."
          style={INPUT_STYLE}
          autoFocus
        />
      </Field>
      <Field label="Supplier hint (optional)">
        <input
          value={supplierHint}
          onChange={(e) => setSupplierHint(e.target.value)}
          placeholder="e.g. Asahi"
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category hint (optional)">
        <select
          value={categoryHint}
          onChange={(e) => setCategoryHint(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— no hint —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      {progress && (
        <ProgressPanel
          percent={progress.percent}
          stepLabel={progress.step}
          detail={progress.detail ?? null}
          elapsedSec={elapsedSec}
          etaSec={null}
          busy={busy}
          onCancel={cancel}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={startExtract}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy
            ? `Extracting… (${formatDuration(elapsedSec)})`
            : "Extract from URL"}
        </button>
      </div>
    </div>
  );
}

// ── Confirm-extraction step (between extract & commit) ─────────────────────
function ConfirmExtraction({
  extracted,
  suppliers,
  sourcePageUrl,
  onError,
  onCancel,
  onCreated,
}: {
  extracted: AddSupplierProductExtractResult;
  suppliers: SupplierOption[];
  sourcePageUrl: string;
  onError: (msg: string | null) => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { extraction, supplierCandidates, productMatchCandidates } = extracted;
  const [chosenSupplierId, setChosenSupplierId] = useState<number | null>(
    supplierCandidates[0]?.id ?? null,
  );
  const [linkToCluster, setLinkToCluster] = useState<boolean>(
    productMatchCandidates.length > 0,
  );
  const [name, setName] = useState(extraction.name);
  const [productCode, setProductCode] = useState(extraction.productCode ?? "");
  const [description, setDescription] = useState(extraction.description ?? "");
  const [category, setCategory] = useState(extraction.category ?? "");
  const [productUrl, setProductUrl] = useState(
    extraction.productUrl ?? sourcePageUrl,
  );
  const [busy, setBusy] = useState(false);

  async function submit() {
    onError(null);
    // Last-resort supplier name derivation. The server-side extractor
    // already URL-fills this, but if state predates that fix, fall back
    // to the URL's domain so the user never gets stuck.
    const fallbackBrand =
      extraction.supplierName?.trim() ||
      deriveBrandFromUrl(sourcePageUrl) ||
      null;
    const fallbackWebsite =
      extraction.supplierWebsite ?? deriveWebsiteFromUrl(sourcePageUrl) ?? null;
    if (chosenSupplierId == null && !fallbackBrand) {
      onError(
        "Pick a supplier — could not derive a brand from the URL either.",
      );
      return;
    }
    setBusy(true);
    try {
      const linkTo =
        linkToCluster && productMatchCandidates.length > 0
          ? productMatchCandidates[0].globalProductId
          : null;
      const supplier =
        chosenSupplierId != null
          ? ({ kind: "existing", supplierId: chosenSupplierId } as const)
          : ({
              kind: "new",
              name: fallbackBrand!,
              website: fallbackWebsite,
              email: extraction.supplierEmail,
            } as const);
      const body: CommitSupplierProductInput = {
        supplier,
        linkToGlobalProductId: linkTo,
        sourcePageUrl,
        product: {
          name,
          productCode: productCode || null,
          category: category || null,
          description: description || null,
          productUrl: productUrl.trim() || null,
          thumbnailUrl: extraction.thumbnailUrl,
          imageUrls: extraction.imageUrls,
        },
        configurations: extraction.configurations,
      };
      const res = await fetch("/api/suppliers/add-product/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Commit failed (${res.status})`);
      }
      const result: CommitSupplierProductResult = await res.json();
      console.log("[add-product] created", result);
      // If we tried to download images and none landed, tell the user
      // explicitly — almost always the brand site blocks external fetches
      // even with browser headers, in which case they can drag-drop the
      // image directly inside the product drawer after the card opens.
      if (
        result.thumbnailAttempted &&
        !result.thumbnailLanded &&
        result.imagesLanded === 0
      ) {
        window.alert(
          `Product saved, but no images could be downloaded.\n\n` +
            `The brand site likely blocks external fetches.\n` +
            `Open the new card and drag-drop an image into the "Other files" tab to add one.`,
        );
      } else if (result.thumbnailAttempted && !result.thumbnailLanded) {
        console.warn(
          `[add-product] thumbnail extraction failed; backfilled from extra image`,
          result.failedImageUrls,
        );
      }
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionHeader title="Extracted product card" subtitle="Tweak any field before saving." />
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} />
      </Field>
      <Field label="Product code">
        <input
          value={productCode}
          onChange={(e) => setProductCode(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— select a category —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
        />
      </Field>
      <Field label="Product URL">
        <input
          value={productUrl}
          onChange={(e) => setProductUrl(e.target.value)}
          placeholder="https://www.brand.com/products/..."
          style={INPUT_STYLE}
        />
      </Field>

      <SectionHeader
        title="Supplier"
        subtitle={
          supplierCandidates.length > 0
            ? "Pick a matched supplier, or use the extracted one to create a new supplier row."
            : "No matching supplier found — saving will create a new supplier row from extracted data."
        }
      />
      <select
        value={chosenSupplierId == null ? "__new" : String(chosenSupplierId)}
        onChange={(e) =>
          setChosenSupplierId(
            e.target.value === "__new" ? null : Number(e.target.value),
          )
        }
        style={INPUT_STYLE}
      >
        {supplierCandidates.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name} ({c.matchKind} match)
          </option>
        ))}
        {/* Always offer the create-new option. The label uses the extracted
            supplier name when present; otherwise we fall back to the URL-
            derived brand so the option never disappears. */}
        <option value="__new">
          + Create new supplier:{" "}
          {extraction.supplierName ||
            deriveBrandFromUrl(sourcePageUrl) ||
            "from URL"}
        </option>
        {suppliers
          .filter((s) => !supplierCandidates.some((c) => c.id === s.id))
          .map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name} (manual pick)
            </option>
          ))}
      </select>

      {productMatchCandidates.length > 0 && (
        <>
          <SectionHeader
            title="Existing product match"
            subtitle={`Product code matches ${productMatchCandidates.length} existing row(s) under: ${productMatchCandidates
              .map((c) => c.supplierName)
              .filter((s, i, arr) => arr.indexOf(s) === i)
              .join(", ")}.`}
          />
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 13,
              color: "var(--lb-text-2)",
            }}
          >
            <input
              type="checkbox"
              checked={linkToCluster}
              onChange={(e) => setLinkToCluster(e.target.checked)}
            />
            Link as alternative supplier on the existing cluster
          </label>
        </>
      )}

      {extraction.configurations.length > 0 && (
        <>
          <SectionHeader
            title="Configurations"
            subtitle={`${extraction.configurations.length} variant(s) will be created as nested rows under this part.`}
          />
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              border: "1px solid var(--lb-border)",
              borderRadius: 8,
              background: "var(--lb-bg)",
            }}
          >
            {extraction.configurations.map((c, i) => (
              <div
                key={`${c.productCode ?? c.name}-${i}`}
                style={{
                  padding: "8px 10px",
                  borderBottom:
                    i < extraction.configurations.length - 1
                      ? "1px solid var(--lb-border)"
                      : "none",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: "var(--lb-text)", flex: 1 }}>
                  {c.name}
                </span>
                {c.productCode && (
                  <span
                    style={{
                      fontFamily: "monospace",
                      color: "var(--lb-text-3)",
                      fontSize: 11.5,
                    }}
                  >
                    {c.productCode}
                  </span>
                )}
                {c.productUrl && (
                  <a
                    href={c.productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={c.productUrl}
                    style={{
                      color: "var(--lb-accent)",
                      textDecoration: "none",
                      fontWeight: 700,
                      fontSize: 11.5,
                    }}
                  >
                    ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button type="button" onClick={onCancel} style={MINI_BTN}>
          ← Start over
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : "Save product"}
        </button>
      </div>
    </div>
  );
}

// ── New-supplier sub-dialog (used by Manual tab) ───────────────────────────
function NewSupplierSubDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: SupplierOption) => void;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/suppliers/create-for-extraction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          website: website || null,
          email: email || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Create failed (${res.status})`);
      }
      const data: { id: number } = await res.json();
      onCreated({ id: data.id, name: name.trim() });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="New supplier" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {err && <ErrorBanner message={err} />}
        <Field label="Name *">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={INPUT_STYLE}
            autoFocus
          />
        </Field>
        <Field label="Website">
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            style={INPUT_STYLE}
          />
        </Field>
        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={INPUT_STYLE}
          />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={MINI_BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Creating…" : "Create supplier"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── shared bits ────────────────────────────────────────────────────────────
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 60,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          color: "var(--lb-text)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 800,
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--lb-text-3)",
              fontSize: 20,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
};

const PRIMARY_BTN: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  border: "1px solid var(--lb-accent)",
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  cursor: "pointer",
};

const MINI_BTN: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12.5,
  fontWeight: 600,
  borderRadius: 999,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text-2)",
  cursor: "pointer",
};
