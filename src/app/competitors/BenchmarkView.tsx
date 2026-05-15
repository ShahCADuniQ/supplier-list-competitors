"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import JSZip from "jszip";
import {
  listCollectionSpecsheets,
  type SpecsheetEntry,
} from "./ai-ideation-actions";
import {
  aiResearchTopBrands,
  aiPopulateResearchedBrand,
  aiFindProductImages,
  aiDeepExtractBrand,
  aiExtractBrandFiles,
  type ResearchedBrand,
} from "./research-actions";
import {
  aiGenerateCompetitor,
  aiPersistProducts,
  type AiSourceUpload,
} from "./ai-actions";
import {
  upsertCompetitor,
  addCompetitorAttachment,
  addProductImage,
  removeProductImage,
  replaceProductImage,
} from "./actions";
import AddProductForm from "./AddProductForm";
import ProductDetailDrawer from "./ProductDetailDrawer";
import { aiRefreshAllProductSpecs } from "./add-actions";
import { addIdeationItem } from "./ideation-actions";
import type {
  CompetitorCollection,
  Competitor,
  CompetitorAttachment,
  CompetitorProduct,
  CompetitorProductAttachment,
} from "@/db/schema";

type FullCompetitorProduct = CompetitorProduct & {
  attachments: CompetitorProductAttachment[];
};
type FullCompetitor = Competitor & {
  attachments: CompetitorAttachment[];
  products: FullCompetitorProduct[];
};

const TIER_LABELS: Record<string, string> = {
  mass: "Mass / Value",
  mid: "Mid / Commercial",
  spec: "Architectural Spec",
  premium: "Premium / Tape",
};

function fmtBytes(b: number) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}
function safeFileName(name: string) {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";
}

export default function BenchmarkView({
  collection,
  brands,
  canEdit,
  onToast,
}: {
  collection: CompetitorCollection;
  brands: FullCompetitor[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function refresh(success?: string, err?: string) {
    if (err) onToast(err, true);
    else if (success) onToast(success);
    router.refresh();
  }

  const totalProducts = useMemo(
    () => brands.reduce((n, b) => n + b.products.length, 0),
    [brands],
  );

  // ── Bulk specsheet download ──
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(null);
  async function downloadAllSpecsheets() {
    setZipBusy(true);
    setZipProgress(null);
    try {
      const entries: SpecsheetEntry[] = await listCollectionSpecsheets(collection.id);
      if (!entries.length) {
        onToast("No specsheets attached to products in this collection", true);
        return;
      }
      const zip = new JSZip();
      const root = zip.folder(safeFileName(collection.name)) ?? zip;
      const seen = new Set<string>();
      let done = 0;
      setZipProgress({ done: 0, total: entries.length });
      for (const e of entries) {
        try {
          const res = await fetch(e.attachment.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          const brandFolder = root.folder(safeFileName(e.brand)) ?? root;
          const productFolder =
            brandFolder.folder(
              safeFileName(`${e.productName}${e.productCode ? ` [${e.productCode}]` : ""}`),
            ) ?? brandFolder;
          let fname = safeFileName(e.attachment.name);
          let n = 1;
          while (seen.has(`${e.brand}/${e.productName}/${fname}`)) {
            const dot = fname.lastIndexOf(".");
            fname =
              dot > 0
                ? `${fname.slice(0, dot)}-${++n}${fname.slice(dot)}`
                : `${fname}-${++n}`;
          }
          seen.add(`${e.brand}/${e.productName}/${fname}`);
          productFolder.file(fname, buf);
        } catch (err) {
          console.error("Failed to fetch", e.attachment.url, err);
        }
        done++;
        setZipProgress({ done, total: entries.length });
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFileName(collection.name)}-specsheets.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      onToast(`Downloaded ${done} of ${entries.length} specsheet${entries.length > 1 ? "s" : ""}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Download failed", true);
    } finally {
      setZipBusy(false);
      setZipProgress(null);
    }
  }

  // ── AI: re-analyze every product with Claude (reads attached PDFs) ──
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false);
  async function reanalyzeAllWithClaude() {
    if (!canEdit) return;
    if (
      !confirm(
        `Re-analyze every product in "${collection.name}" with Claude? This will read every attached PDF and refresh specs. Takes 10-60s per product.`,
      )
    )
      return;
    setReanalyzeBusy(true);
    try {
      onToast(`Reading PDFs for every product in ${collection.name}…`);
      const r = await aiRefreshAllProductSpecs({ collectionId: collection.id });
      router.refresh();
      const parts: string[] = [];
      parts.push(
        `Re-analyzed ${r.productsRefreshed}/${r.productsScanned} products`,
      );
      if (r.productsSkipped > 0) {
        parts.push(
          `${r.productsSkipped} skipped (unchanged — saved Claude call)`,
        );
      }
      parts.push(`${r.totalFilesRead} files read`);
      parts.push(
        `${r.totalFieldsUpdated} field${r.totalFieldsUpdated === 1 ? "" : "s"} updated`,
      );
      if (r.errors.length) parts.push(`${r.errors.length} errors`);
      if (r.errors.length) {
        console.warn("[reanalyze] errors:", r.errors);
      }
      onToast(parts.join(" · "));
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Re-analyze failed", true);
    } finally {
      setReanalyzeBusy(false);
    }
  }

  // ── AI research: find more brands ──
  const [findBusy, setFindBusy] = useState(false);
  const [findProgress, setFindProgress] = useState<{ done: number; total: number; current?: string } | null>(null);
  async function findMoreBrands(count = 6) {
    if (!canEdit) return;
    setFindBusy(true);
    setFindProgress(null);
    try {
      onToast("Searching the web for more brands…");
      const r = await aiResearchTopBrands({ collectionId: collection.id, count });
      const list = r.found;
      if (!list.length) {
        onToast("No new brands found — try a different prompt or run again", true);
        return;
      }
      // Filter out duplicates by name (case-insensitive).
      const have = new Set(brands.map((b) => b.name.toLowerCase().trim()));
      const fresh = list.filter((b) => !have.has(b.name.toLowerCase().trim()));
      if (!fresh.length) {
        onToast("All suggested brands are already on the board", true);
        return;
      }
      setFindProgress({ done: 0, total: fresh.length });
      let added = 0;
      let products = 0;
      for (let i = 0; i < fresh.length; i++) {
        setFindProgress({ done: i, total: fresh.length, current: fresh[i].name });
        try {
          const r = await aiPopulateResearchedBrand({
            collectionId: collection.id,
            brand: fresh[i],
          });
          added++;
          products += r.productsInserted;
        } catch (err) {
          console.error("Brand populate failed:", fresh[i].name, err);
        }
      }
      setFindProgress({ done: fresh.length, total: fresh.length });
      router.refresh();
      onToast(`Added ${added} brand${added === 1 ? "" : "s"} · ${products} product${products === 1 ? "" : "s"}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Research failed", true);
    } finally {
      setFindBusy(false);
      setTimeout(() => setFindProgress(null), 4000);
    }
  }

  // ── Add a single brand from URL (deep crawl) or PDF (single-source) ──
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [addBrandName, setAddBrandName] = useState("");
  const [addFiles, setAddFiles] = useState<AiSourceUpload[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [addStatus, setAddStatus] = useState<string | null>(null);
  async function handleAddByUrlOrFile() {
    if (!canEdit) return;
    const trimmedUrl = addUrl.trim();
    if (!trimmedUrl && !addFiles.length) {
      onToast("Add a URL or a PDF first", true);
      return;
    }
    setAddBusy(true);
    try {
      if (trimmedUrl && !addFiles.length) {
        // ── DEEP CRAWL: Perplexity discovers every in-niche product on the
        // brand's site, then we fetch + AI-extract each product page individually
        // and harvest every PDF/IES/DWG link from the raw HTML.
        const websiteUrl = /^https?:\/\//i.test(trimmedUrl)
          ? trimmedUrl
          : `https://${trimmedUrl}`;
        setAddStatus(
          `Discovering ${collection.name} products on ${new URL(websiteUrl).host} via Perplexity… (this can take 2–4 minutes for a large catalog)`,
        );
        const r = await aiDeepExtractBrand({
          collectionId: collection.id,
          website: websiteUrl,
          brandName: addBrandName.trim() || undefined,
          maxProducts: 250,
        });
        setAddOpen(false);
        setAddUrl("");
        setAddBrandName("");
        setAddFiles([]);
        router.refresh();
        const parts = [
          `${r.brandName} added`,
          `${r.productsInserted} product${r.productsInserted === 1 ? "" : "s"}`,
        ];
        const productDocs = r.specsheetsAttached + r.documentsAttached;
        if (productDocs)
          parts.push(`${productDocs} product file${productDocs === 1 ? "" : "s"}`);
        if (r.brandFilesAttached)
          parts.push(`${r.brandFilesAttached} brand file${r.brandFilesAttached === 1 ? "" : "s"}`);
        if (r.fetchErrors.length)
          parts.push(`${r.fetchErrors.length} fetch errors (see dev log)`);
        onToast(parts.join(" · "));
      } else {
        // ── SINGLE-SOURCE: PDF/file-driven extraction (no website crawl) ──
        setAddStatus("Reading attached file(s)…");
        const r = await aiGenerateCompetitor({
          uploads: addFiles,
          url: trimmedUrl || undefined,
        });
        const draft = r.extraction;
        const created = await upsertCompetitor({
          collectionId: collection.id,
          name: addBrandName.trim() || draft.name || "New brand",
          website: draft.website,
          parent: draft.parent,
          tierKey: (draft.tierKey || "mid") as "mass" | "mid" | "spec" | "premium",
          tier: draft.tier,
          segment: draft.segment,
          country: draft.country,
          productLines: draft.productLines,
          channel: draft.channel,
          notes: draft.notes,
          capabilities: draft.capabilities,
        });
        if (!created) throw new Error("Could not create brand");
        for (const u of addFiles) {
          try {
            await addCompetitorAttachment({
              competitorId: created.id,
              name: u.name, size: u.size, mimeType: u.mime,
              url: u.url, blobPathname: u.blobPathname,
            });
          } catch (err) {
            console.error("Failed to attach", u.name, err);
          }
        }
        setAddStatus(`Saving ${draft.products?.length ?? 0} products…`);
        const persisted = await aiPersistProducts({
          competitorId: created.id,
          products: draft.products ?? [],
        });
        setAddOpen(false);
        setAddUrl("");
        setAddBrandName("");
        setAddFiles([]);
        router.refresh();
        onToast(
          `Added ${created.name} · ${persisted.inserted} product${persisted.inserted === 1 ? "" : "s"}${persisted.specsheetsAttached ? ` · ${persisted.specsheetsAttached} PDF${persisted.specsheetsAttached === 1 ? "" : "s"} attached` : ""}`,
        );
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Failed to add brand", true);
    } finally {
      setAddBusy(false);
      setTimeout(() => setAddStatus(null), 3000);
    }
  }
  async function handleAddUploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      try {
        const pathname = `ai-temp/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        setAddFiles((s) => [
          ...s,
          { url: blob.url, name: f.name, mime: f.type, size: f.size, blobPathname: blob.pathname },
        ]);
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
  }

  // ── More photos via web search → adds to the photo board (ideation) ──
  const [photoBusy, setPhotoBusy] = useState(false);
  async function findMorePhotos(query?: string) {
    if (!canEdit) return;
    setPhotoBusy(true);
    try {
      onToast("Searching the web for product photos…");
      const r = await aiFindProductImages({ collectionId: collection.id, query, count: 10 });
      if (!r.images.length) {
        onToast("No product photos found — try a more specific search", true);
        return;
      }
      let saved = 0;
      for (const img of r.images) {
        try {
          await addIdeationItem({
            collectionId: collection.id,
            imageUrl: img.url,
            title: img.caption || "Web reference",
            kind: "reference",
          });
          saved++;
        } catch (err) {
          console.error("addIdeationItem failed:", img.url, err);
        }
      }
      router.refresh();
      onToast(`Saved ${saved} image${saved === 1 ? "" : "s"} to the Ideation board`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Photo search failed", true);
    } finally {
      setPhotoBusy(false);
    }
  }

  const brandsWithProducts = brands.filter((b) => b.products.length > 0);

  return (
    <div className="bm-wrap">
      {canEdit && (
        <AddProductForm
          collectionId={collection.id}
          collectionName={collection.name}
          niche={collection.name}
          onToast={onToast}
          onAdded={() => router.refresh()}
        />
      )}
      <div className="bm-head">
        <div>
          <div className="d-eyebrow">Benchmark</div>
          <h1 className="d-title">{collection.name}</h1>
          <p className="d-sub">
            Per-brand product catalogs · {brandsWithProducts.length} brand{brandsWithProducts.length === 1 ? "" : "s"} ·{" "}
            {totalProducts} product{totalProducts === 1 ? "" : "s"}. Updates as you add products — new brands appear automatically.
          </p>
        </div>
      </div>

      {brandsWithProducts.length === 0 ? (
        <div className="d-card" style={{ padding: 24, textAlign: "center" }}>
          <h4 style={{ marginTop: 0 }}>No brands yet in this collection</h4>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: "6px 0 16px" }}>
            {canEdit
              ? "Add a product above to get started. We'll auto-create brand sections for the manufacturers behind each product you add."
              : "An admin needs to populate this collection."}
          </p>
        </div>
      ) : (
        <div className="bm-brands">
          {brandsWithProducts.map((b) => (
            <BrandSection key={b.id} brand={b} canEdit={canEdit} onToast={onToast} />
          ))}
        </div>
      )}
    </div>
  );
}

function BrandSection({
  brand,
  canEdit,
  onToast,
}: {
  brand: FullCompetitor;
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const ws = (brand.website || "").trim();
  const wsHref = ws && !/^https?:\/\//i.test(ws) ? `https://${ws}` : ws;
  const wsHost = ws.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  // Brand-level attachments — broad files about the company, not tied to a
  // specific product (uploaded in the Brands tab via "+ Add file").
  const brandAttachments = [...brand.attachments].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const [extractBusy, setExtractBusy] = useState(false);
  async function handleExtractBrandFiles() {
    if (!canEdit) return;
    setExtractBusy(true);
    try {
      onToast(`Extracting brand files for ${brand.name}…`);
      const r = await aiExtractBrandFiles({ competitorId: brand.id });
      router.refresh();
      onToast(
        `${r.brandName}: ${r.filesAttached} brand file${r.filesAttached === 1 ? "" : "s"} attached${r.fetchErrors ? ` · ${r.fetchErrors} skipped` : ""}`,
      );
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Brand-file extraction failed", true);
    } finally {
      setExtractBusy(false);
    }
  }

  return (
    <section className="d-card brand-section">
      <header
        className="brand-section-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
      >
        <div className="brand-section-title">
          <span className="brand-section-chev">{open ? "▾" : "▸"}</span>
          <h3>{brand.name}</h3>
          <span className={`tier-pill tier-${brand.tierKey}`}>{TIER_LABELS[brand.tierKey] ?? brand.tierKey}</span>
          <span className="brand-section-meta">
            {brand.products.length} product{brand.products.length === 1 ? "" : "s"}
            {brand.country ? ` · ${brand.country}` : ""}
            {brandAttachments.length > 0
              ? ` · ${brandAttachments.length} brand file${brandAttachments.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <div
          className="brand-section-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {canEdit && (
            <button
              className="btn primary sm"
              onClick={handleExtractBrandFiles}
              disabled={extractBusy}
              title="Fetch every PDF / IES / DWG / BIM linked from this brand's about / downloads / resources pages"
            >
              {extractBusy
                ? "Extracting…"
                : `✨ Extract brand files${brandAttachments.length > 0 ? " (re-run)" : ""}`}
            </button>
          )}
          {ws && (
            <a
              className="brand-section-link"
              href={wsHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {wsHost} ↗
            </a>
          )}
        </div>
      </header>
      {brand.notes && open && (
        <p className="brand-section-notes">{brand.notes}</p>
      )}
      {open && brandAttachments.length > 0 && (
        <div className="bm-files" style={{ marginTop: 6 }}>
          <div className="bm-files-head">
            <strong>Brand files</strong>
            <span style={{ color: "var(--muted)", fontSize: 11, fontWeight: 500 }}>
              {brandAttachments.length} attached
            </span>
          </div>
          <div className="bm-files-list">
            {brandAttachments.map((a) => {
              const ext = (a.name.split(".").pop() ?? "").toUpperCase();
              return (
                <a
                  key={a.id}
                  className="bm-file"
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={a.name}
                >
                  <span className="bm-file-ext">{ext.slice(0, 4) || "FILE"}</span>
                  <span className="bm-file-info">
                    <span className="bm-file-name">{a.name}</span>
                    <span className="bm-file-meta">{fmtBytes(a.size)}</span>
                  </span>
                  <span className="bm-file-dl">⬇</span>
                </a>
              );
            })}
          </div>
        </div>
      )}
      {open && (
        brand.products.length === 0 ? (
          <div className="brand-section-empty">
            No products yet. Use the brand's edit panel to extract from the website,
            or refine with a PDF brochure.
          </div>
        ) : (
          <div className="bm-product-grid">
            {brand.products.map((p) => (
              <BenchmarkProductCard
                key={p.id}
                product={p}
                brandName={brand.name}
                canEdit={canEdit}
                onToast={onToast}
              />
            ))}
          </div>
        )
      )}
    </section>
  );
}

function BenchmarkProductCard({
  product,
  brandName,
  canEdit,
  onToast,
}: {
  product: FullCompetitorProduct;
  brandName: string;
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  // Drawer-driven UX: the card itself is a compact tile (photo + name +
  // headline specs). Clicking opens ProductDetailDrawer from the right with
  // the gallery, full specs, and files.
  const [drawerOpen, setDrawerOpen] = useState(false);

  const firstImage = product.imageUrls?.[0];
  const specs = product.specs ?? {};
  const previewKeys: Array<{ key: string; label: string }> = [
    { key: "profileFaceSize", label: "Face" },
    { key: "length", label: "Length" },
    { key: "mounting", label: "Mounting" },
    { key: "lensType", label: "Lens" },
    { key: "wattage", label: "W" },
    { key: "cct", label: "CCT" },
  ];
  const renderVal = (v: string | string[] | undefined): string => {
    if (Array.isArray(v)) return v.filter(Boolean).join(", ");
    return (v ?? "").toString().trim();
  };
  const fileCount = product.attachments.length;
  const photoCount = product.imageUrls?.length ?? 0;

  return (
    <div id={`product-${product.id}`} className="bm-product">
      <div
        className="bm-product-head card-clickable"
        role="button"
        tabIndex={0}
        onClick={() => setDrawerOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDrawerOpen(true);
          }
        }}
      >
        <ProductThumb
          productId={product.id}
          productName={product.name}
          firstImage={firstImage}
          canEdit={canEdit}
          onToast={onToast}
        />
        <div className="bm-product-info">
          <div className="bm-product-name">{product.name}</div>
          {product.productCode && (
            <div className="bm-product-code">{product.productCode}</div>
          )}
          {product.productCategory && (
            <div className="bm-product-cat">{product.productCategory}</div>
          )}
          <div className="bm-product-preview">
            {previewKeys.map(({ key, label }) => {
              const v = renderVal(specs[key]);
              if (!v) return null;
              return (
                <span key={key} className="bm-product-spec-mini">
                  <strong>{label}:</strong> {v.slice(0, 60)}
                </span>
              );
            })}
          </div>
          {(photoCount > 1 || fileCount > 0) && (
            <div className="bm-product-counts">
              {photoCount > 1 && (
                <span className="bm-product-count" title={`${photoCount} photos`}>
                  <span className="bm-count-icon">📷</span>
                  <span className="bm-count-num">{photoCount}</span>
                </span>
              )}
              {fileCount > 0 && (
                <span className="bm-product-count" title={`${fileCount} files`}>
                  <span className="bm-count-icon">📎</span>
                  <span className="bm-count-num">{fileCount}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <span className="bm-product-chev">→</span>
      </div>
      {drawerOpen && (
        <ProductDetailDrawer
          product={product}
          brandName={brandName}
          canEdit={canEdit}
          onToast={onToast}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProductThumb — the editable image tile inside each BenchmarkProductCard.
// When canEdit, hover surfaces three actions:
//   • Replace — upload a new file, swap it in as primary
//   • Add another — upload, append (and make primary on the next click)
//   • Remove — drop the current image (best-effort blob cleanup)
// All actions stopPropagation so the parent card doesn't open the drawer.
// ─────────────────────────────────────────────────────────────────────────────

function ProductThumb({
  productId,
  productName,
  firstImage,
  canEdit,
  onToast,
}: {
  productId: number;
  productName: string;
  firstImage: string | undefined;
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<"replace" | "add" | "remove" | null>(null);
  // We give the replace + add file inputs a unique id per card so clicking
  // a button activates only that card's picker.
  const replaceInputId = `bm-replace-${productId}`;
  const addInputId = `bm-add-${productId}`;

  async function uploadToBlob(file: File): Promise<string> {
    const pathname = `product-images/${productId}/${crypto.randomUUID()}/${safeFileName(file.name)}`;
    const blob = await upload(pathname, file, {
      access: "public",
      handleUploadUrl: "/api/blob/upload",
      contentType: file.type || undefined,
    });
    return blob.url;
  }

  function pickedReplace(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !firstImage) return;
    setBusy("replace");
    startTransition(async () => {
      try {
        const newUrl = await uploadToBlob(file);
        await replaceProductImage({
          productId,
          oldUrl: firstImage,
          newUrl,
        });
        router.refresh();
        onToast(`Replaced photo for ${productName}`);
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Replace failed", true);
      } finally {
        setBusy(null);
      }
    });
  }

  function pickedAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length === 0) return;
    setBusy("add");
    startTransition(async () => {
      try {
        let added = 0;
        for (const f of files) {
          const newUrl = await uploadToBlob(f);
          await addProductImage({
            productId,
            url: newUrl,
            // If the product had no image, the first upload becomes primary.
            makePrimary: !firstImage && added === 0,
          });
          added += 1;
        }
        router.refresh();
        onToast(
          `Added ${added} photo${added === 1 ? "" : "s"} to ${productName}`,
        );
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Add photo failed", true);
      } finally {
        setBusy(null);
      }
    });
  }

  function clickRemove() {
    if (!firstImage) return;
    if (!confirm(`Remove this photo from "${productName}"?`)) return;
    setBusy("remove");
    startTransition(async () => {
      try {
        await removeProductImage({ productId, url: firstImage });
        router.refresh();
        onToast(`Removed photo from ${productName}`);
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Remove failed", true);
      } finally {
        setBusy(null);
      }
    });
  }

  const overlayBtnStyle: React.CSSProperties = {
    padding: "4px 8px",
    borderRadius: 6,
    background: "rgba(15,23,42,0.92)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.18)",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.3,
    cursor: busy ? "wait" : "pointer",
    textTransform: "uppercase",
  };

  return (
    <div
      className="bm-product-thumb"
      style={{ position: "relative" }}
      onClick={canEdit ? (e) => e.stopPropagation() : undefined}
    >
      {firstImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={firstImage}
          alt={productName}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <div className="bm-product-thumb-empty">📷</div>
      )}
      {canEdit && (
        <>
          {/* Hidden file pickers — labels below trigger them. */}
          <input
            id={replaceInputId}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={pickedReplace}
            disabled={busy !== null}
          />
          <input
            id={addInputId}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={pickedAdd}
            disabled={busy !== null}
          />
          <div
            className="bm-thumb-overlay"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 6,
              padding: 6,
              background:
                "linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0) 55%)",
              opacity: busy ? 1 : 0,
              transition: "opacity 140ms ease",
              pointerEvents: busy ? "auto" : "auto",
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              if (!busy) e.currentTarget.style.opacity = "0";
            }}
          >
            {firstImage && (
              <label
                htmlFor={replaceInputId}
                style={overlayBtnStyle}
                title="Replace this photo with a new upload"
                onClick={(e) => e.stopPropagation()}
              >
                {busy === "replace" ? "…" : "↻ Replace"}
              </label>
            )}
            <label
              htmlFor={addInputId}
              style={overlayBtnStyle}
              title={
                firstImage
                  ? "Add another photo (gallery)"
                  : "Add the first photo"
              }
              onClick={(e) => e.stopPropagation()}
            >
              {busy === "add" ? "…" : firstImage ? "+ Add" : "+ Upload"}
            </label>
            {firstImage && (
              <button
                type="button"
                style={{
                  ...overlayBtnStyle,
                  background: "rgba(220,38,38,0.92)",
                  border: "1px solid rgba(255,255,255,0.18)",
                }}
                title="Remove this photo"
                onClick={(e) => {
                  e.stopPropagation();
                  clickRemove();
                }}
                disabled={busy !== null}
              >
                {busy === "remove" ? "…" : "✕ Remove"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
