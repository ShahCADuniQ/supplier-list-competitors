"use client";

// Brainstorming board. Primary input is a Pinterest URL — paste it, add a
// note about what you like, and we pull every image and create one card per
// pin. Cards are clickable; clicking opens IdeationDetailDrawer (right-side
// slide-out) where you can refine the note, add tags, or delete.
//
// Drag-and-drop image upload is kept as a secondary path for non-Pinterest
// references the user wants to add manually.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addIdeationItem,
  aiAddPinterestLink,
  deleteAllIdeationItems,
} from "./ideation-actions";
import {
  addIdeationProduct,
  deleteIdeationProduct,
  updateIdeationProduct,
} from "./ideation-product-actions";
import {
  replaceCollectionBrochure,
  deleteCollectionBrochure,
} from "./ideation-product-file-actions";
import IdeationDetailDrawer from "./IdeationDetailDrawer";
import IdeationProductDrawer, { ImageLightbox } from "./IdeationProductDrawer";
import type {
  CompetitorCollection,
  Competitor,
  CompetitorIdeationItem,
  IdeationProduct,
  IdeationItemProduct,
  IdeationProductFile,
} from "@/db/schema";

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

// Architectural-lighting brainstorm categories. Order = display order.
// Color is a tint used for the badge so each category is recognisable at a
// glance. "reference" is the catch-all for general inspiration.
export const IDEATION_CATEGORIES = [
  { key: "moodboard", label: "Moodboard", color: "#a855f7" },
  { key: "mounting", label: "Mounting", color: "#0ea5e9" },
  { key: "lens", label: "Lens", color: "#06b6d4" },
  { key: "optic", label: "Optic", color: "#0891b2" },
  { key: "decorative", label: "Decorative", color: "#ec4899" },
  { key: "profile", label: "Profile", color: "#f59e0b" },
  { key: "finish", label: "Finish", color: "#84cc16" },
  { key: "endcap", label: "End cap", color: "#14b8a6" },
  { key: "effect", label: "Light effect", color: "#ef4444" },
  { key: "control", label: "Control", color: "#6366f1" },
  { key: "reference", label: "Reference", color: "#94a3b8" },
  { key: "sketch", label: "Sketch", color: "#f97316" },
  { key: "ai-generated", label: "AI generated", color: "#8b5cf6" },
] as const;
export type IdeationCategoryKey = (typeof IDEATION_CATEGORIES)[number]["key"];

function categoryByKey(key: string) {
  return IDEATION_CATEGORIES.find((c) => c.key === key) ?? IDEATION_CATEGORIES[10];
}

export default function IdeationBoard({
  collection,
  // brands kept for API compatibility (Summary jump-to expects this shape)
  brands: _brands,
  items,
  products,
  linkages,
  files,
  canEdit,
  onToast,
}: {
  collection: CompetitorCollection;
  brands: Competitor[];
  items: CompetitorIdeationItem[];
  products: IdeationProduct[];
  linkages: IdeationItemProduct[];
  files: IdeationProductFile[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  void _brands;
  const router = useRouter();

  // ── Files split: collection brochure + per-product files ──────────────
  // ideation_product_files holds both. productId === null + kind ===
  // "collection_brochure" is the brochure row; everything else has a
  // productId pointing at an ideation product.
  const collectionBrochure =
    files.find(
      (f) => f.productId === null && f.fileKind === "collection_brochure",
    ) ?? null;
  const filesByProduct = useMemo(() => {
    const m = new Map<number, IdeationProductFile[]>();
    for (const f of files) {
      if (f.productId == null) continue;
      const list = m.get(f.productId) ?? [];
      list.push(f);
      m.set(f.productId, list);
    }
    return m;
  }, [files]);

  // ── Product detail drawer ────────────────────────────────────────────
  // Opening: clicking a product pill filters AND opens the drawer.
  // Closing: drawer's own close button. The filter stays selected until
  // the user picks another pill or clicks "All ideas".
  const [drawerProductId, setDrawerProductId] = useState<number | null>(null);
  const drawerProduct = drawerProductId
    ? products.find((p) => p.id === drawerProductId) ?? null
    : null;

  // ── Product filter ─────────────────────────────────────────────────────
  // null  = "All ideas" (no product filter)
  // -1    = "Global only" (ideas marked is_global)
  // <id>  = filter to ideas linked to that product (or marked global, since
  //         is_global means "applies to every product")
  const [productFilter, setProductFilter] = useState<number | null>(null);

  // Map item.id -> Set<productId>. Built once per linkage change so the
  // filter check below is O(1) per item.
  const linkageMap = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const l of linkages) {
      const set = m.get(l.ideationItemId) ?? new Set<number>();
      set.add(l.productId);
      m.set(l.ideationItemId, set);
    }
    return m;
  }, [linkages]);

  function itemMatchesProduct(item: CompetitorIdeationItem): boolean {
    if (productFilter === null) return true;
    if (productFilter === -1) return item.isGlobal === true;
    if (item.isGlobal) return true; // global ideas show under every product pill
    const set = linkageMap.get(item.id);
    return set ? set.has(productFilter) : false;
  }

  // Per-product idea count (for the pill counts).
  const productCounts = useMemo(() => {
    const counts = new Map<number, number>();
    let globalCount = 0;
    for (const i of items) {
      if (i.isGlobal) {
        globalCount++;
        continue;
      }
      const set = linkageMap.get(i.id);
      if (!set) continue;
      for (const pid of set) {
        counts.set(pid, (counts.get(pid) ?? 0) + 1);
      }
    }
    // Global ideas count under every product too.
    return { perProduct: counts, globalCount };
  }, [items, linkageMap]);

  // ── Product modals ──────────────────────────────────────────────────
  // Three modal states, mutually exclusive: add a new product, edit an
  // existing one (name + color), or confirm deletion. Replaces the old
  // window.prompt / window.confirm flows so input stays in the dashboard.
  type ProductModalState =
    | { kind: "closed" }
    | { kind: "add" }
    | { kind: "edit"; product: IdeationProduct }
    | { kind: "delete"; product: IdeationProduct };
  const [productModal, setProductModal] = useState<ProductModalState>({ kind: "closed" });
  const [productBusy, setProductBusy] = useState(false);

  async function submitAddProduct(name: string, color: string) {
    setProductBusy(true);
    try {
      await addIdeationProduct({
        collectionId: collection.id,
        name,
        color,
      });
      router.refresh();
      onToast(`Added product "${name}"`);
      setProductModal({ kind: "closed" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Add product failed";
      // Translate Postgres' "relation does not exist" into a path-forward.
      const hint = /ideation_products.*does not exist|relation .* does not exist/i.test(msg)
        ? "Database migration 0007 hasn't been applied. Run: npm run db:apply"
        : msg;
      onToast(hint, true);
    } finally {
      setProductBusy(false);
    }
  }

  async function submitEditProduct(
    product: IdeationProduct,
    name: string,
    color: string,
  ) {
    setProductBusy(true);
    try {
      await updateIdeationProduct({ id: product.id, name, color });
      router.refresh();
      onToast("Saved");
      setProductModal({ kind: "closed" });
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Save failed", true);
    } finally {
      setProductBusy(false);
    }
  }

  async function submitDeleteProduct(product: IdeationProduct) {
    setProductBusy(true);
    try {
      await deleteIdeationProduct(product.id);
      router.refresh();
      onToast(`Deleted "${product.name}"`);
      if (productFilter === product.id) setProductFilter(null);
      if (drawerProductId === product.id) setDrawerProductId(null);
      setProductModal({ kind: "closed" });
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setProductBusy(false);
    }
  }

  // ── Pinterest extractor ──
  const [pinterestUrl, setPinterestUrl] = useState("");
  const [pinterestComment, setPinterestComment] = useState("");
  const [pinterestKind, setPinterestKind] = useState<IdeationCategoryKey>("moodboard");
  // Pinterest-import linkage. "all" = each new card is global. <number> = each
  // new card is locked to that single product. Default "all" so importing
  // before products exist still works.
  const [pinterestProduct, setPinterestProduct] = useState<"all" | number>(
    "all",
  );
  const [pinterestBusy, setPinterestBusy] = useState(false);
  // Resolve the dropdown value to a guaranteed-valid option. If the user
  // picked a product and that product is later deleted, fall back to "all"
  // — the select renders as "All products" without losing user intent.
  const effectivePinterestProduct: "all" | number =
    pinterestProduct === "all"
      ? "all"
      : products.some((p) => p.id === pinterestProduct)
        ? pinterestProduct
        : "all";

  async function addPinterestBoard() {
    if (!canEdit) return;
    const u = pinterestUrl.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      onToast("URL must start with http(s)://", true);
      return;
    }
    setPinterestBusy(true);
    try {
      onToast("Reading Pinterest page…");
      const r = await aiAddPinterestLink({
        collectionId: collection.id,
        url: u,
        comment: pinterestComment.trim() || undefined,
        kind: pinterestKind,
        productLinkage:
          effectivePinterestProduct === "all"
            ? { kind: "all" }
            : { kind: "product", productId: effectivePinterestProduct },
      });
      setPinterestUrl("");
      setPinterestComment("");
      router.refresh();
      const parts: string[] = [];
      if (r.imageCount > 0) {
        parts.push(`Added ${r.imageCount} image${r.imageCount === 1 ? "" : "s"}`);
      } else {
        parts.push("No new images (everything already on the board)");
      }
      if (r.duplicateCount > 0) {
        parts.push(`${r.duplicateCount} skipped (already added)`);
      }
      onToast(parts.join(" · "));
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Pinterest extract failed", true);
    } finally {
      setPinterestBusy(false);
    }
  }

  // ── Manual image upload (drop or click) ──
  const [uploading, setUploading] = useState(0);
  async function uploadFiles(files: FileList | File[]) {
    if (!canEdit) return;
    let succeeded = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) {
        onToast(`${f.name} is not an image`, true);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const pathname = `competitors/ideation/${collection.id}/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addIdeationItem({
          collectionId: collection.id,
          imageUrl: blob.url,
          blobPathname: blob.pathname,
          mimeType: f.type,
          size: f.size,
          title: f.name.replace(/\.[^.]+$/, ""),
          kind: "reference",
        });
        succeeded++;
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Upload failed", true);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (succeeded > 0) {
      router.refresh();
      onToast(`Uploaded ${succeeded} image${succeeded === 1 ? "" : "s"}`);
    }
  }

  // ── Bulk delete ──
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  async function handleDeleteAll() {
    if (!canEdit || items.length === 0) return;
    if (
      !confirm(
        `Delete ALL ${items.length} image${items.length === 1 ? "" : "s"} from this ideation board? This can't be undone.`,
      )
    ) {
      return;
    }
    setDeleteAllBusy(true);
    try {
      const r = await deleteAllIdeationItems({ collectionId: collection.id });
      router.refresh();
      const blobNote = r.blobsRemoved > 0 ? ` · ${r.blobsRemoved} uploaded file${r.blobsRemoved === 1 ? "" : "s"} removed from storage` : "";
      onToast(`Deleted ${r.deletedCount} image${r.deletedCount === 1 ? "" : "s"}${blobNote}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setDeleteAllBusy(false);
    }
  }

  // ── Search + category filter ──
  const [search, setSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<Set<IdeationCategoryKey>>(new Set());
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (!itemMatchesProduct(i)) return false;
      if (activeCategories.size > 0 && !activeCategories.has(i.kind as IdeationCategoryKey)) {
        return false;
      }
      if (q) {
        const hay = [i.title, i.notes, ...(i.tags ?? [])].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, activeCategories, productFilter, linkageMap]);
  // Counts per category — used in the chip labels.
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) {
      m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // ── Drawer + lightbox ──
  // Click on a card opens the lightbox first (full-pic preview). The
  // lightbox has an "Edit details" button that swaps to the IdeationDetailDrawer
  // when the user wants to change the title/notes/tags/products.
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const openItem = items.find((i) => i.id === openItemId) ?? null;
  const [lightboxItemId, setLightboxItemId] = useState<number | null>(null);
  const lightboxItem = items.find((i) => i.id === lightboxItemId) ?? null;

  return (
    <div className="bm-wrap">
      {canEdit && (
        <div className="d-card id-pinterest">
          <h4 className="id-pinterest-h">
            📌 Paste a Pinterest link
            <span className="id-pinterest-h-hint">
              — board, pin, or profile. We pull every image and add them as cards.
            </span>
          </h4>
          <div className="id-pinterest-row">
            <input
              type="url"
              className="id-pinterest-url"
              placeholder="https://www.pinterest.com/yourname/board-name/"
              value={pinterestUrl}
              onChange={(e) => setPinterestUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addPinterestBoard();
                }
              }}
              disabled={pinterestBusy}
            />
            <button
              type="button"
              className="btn primary sm"
              onClick={addPinterestBoard}
              disabled={pinterestBusy || !pinterestUrl.trim()}
            >
              {pinterestBusy ? "Reading…" : "📥 Pull images"}
            </button>
          </div>
          <div className="id-pinterest-row" style={{ marginBottom: 8 }}>
            <label className="id-pinterest-cat-label">
              Category for these images:
              <select
                className="id-pinterest-cat"
                value={pinterestKind}
                onChange={(e) =>
                  setPinterestKind(e.target.value as IdeationCategoryKey)
                }
                disabled={pinterestBusy}
              >
                {IDEATION_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="id-pinterest-cat-label">
              Link these images to:
              <select
                className="id-pinterest-cat"
                value={
                  effectivePinterestProduct === "all"
                    ? "all"
                    : String(effectivePinterestProduct)
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setPinterestProduct(v === "all" ? "all" : Number(v));
                }}
                disabled={pinterestBusy}
                title={
                  products.length === 0
                    ? "No products yet — cards will be added under \"All products\". Add a product on the Ideation board to lock new imports to it."
                    : undefined
                }
              >
                <option value="all">All products (default)</option>
                {products.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            className="id-pinterest-comment"
            placeholder="What do you like about this? (optional — applied as the note on every image we pull in)"
            value={pinterestComment}
            onChange={(e) => setPinterestComment(e.target.value)}
            rows={2}
            disabled={pinterestBusy}
          />
        </div>
      )}

      <div className="bm-head">
        <div>
          <div className="d-eyebrow">Ideation</div>
          <h1 className="d-title">{collection.name}</h1>
          <p className="d-sub">
            Brainstorm board · {items.length} image{items.length === 1 ? "" : "s"}
            {uploading > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--accent)" }}>uploading {uploading}…</span>
              </>
            )}
          </p>
        </div>
      </div>

      <CollectionBrochureCard
        collection={collection}
        brochure={collectionBrochure}
        canEdit={canEdit}
        onToast={onToast}
        onChange={() => router.refresh()}
      />

      {/* Products row — pills to filter ideas by which product they apply to.
          "All ideas" (default) shows everything; clicking a product pill shows
          ideas linked to that product (plus any flagged is_global). */}
      <div
        className="id-products-row"
        role="tablist"
        aria-label="Ideation products"
      >
        <button
          type="button"
          role="tab"
          aria-selected={productFilter === null}
          onClick={() => setProductFilter(null)}
          className="id-product-pill"
          data-active={productFilter === null}
          style={{
            "--pill-color": "var(--accent)",
          } as React.CSSProperties}
        >
          <span className="id-product-pill-dot" aria-hidden />
          All ideas
          <span className="id-product-pill-ct">{items.length}</span>
        </button>
        {products.map((p) => {
          const active = productFilter === p.id;
          const localCount = productCounts.perProduct.get(p.id) ?? 0;
          const total = localCount + productCounts.globalCount;
          return (
            <span
              key={p.id}
              className="id-product-pill-wrap"
              data-active={active}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setProductFilter(p.id);
                  setDrawerProductId(p.id);
                }}
                className="id-product-pill"
                data-active={active}
                style={{ "--pill-color": p.color } as React.CSSProperties}
                title={`${p.name} — click to view details and files`}
              >
                <span className="id-product-pill-dot" aria-hidden />
                {p.name}
                <span className="id-product-pill-ct">{total}</span>
              </button>
              {canEdit && (
                <span className="id-product-pill-acts">
                  <button
                    type="button"
                    title="Edit"
                    aria-label={`Edit ${p.name}`}
                    onClick={() => setProductModal({ kind: "edit", product: p })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => setProductModal({ kind: "delete", product: p })}
                  >
                    ✕
                  </button>
                </span>
              )}
            </span>
          );
        })}
        {productCounts.globalCount > 0 && (
          <button
            type="button"
            role="tab"
            aria-selected={productFilter === -1}
            onClick={() => setProductFilter(-1)}
            className="id-product-pill"
            data-active={productFilter === -1}
            style={{ "--pill-color": "var(--lb-text-2)" } as React.CSSProperties}
            title="Ideas marked as applying to every product"
          >
            <span className="id-product-pill-dot" aria-hidden />
            Global only
            <span className="id-product-pill-ct">{productCounts.globalCount}</span>
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="id-product-add"
            onClick={() => setProductModal({ kind: "add" })}
            disabled={productBusy}
            title="Add a product you're developing"
          >
            + Add product
          </button>
        )}
      </div>

      {canEdit && (
        <label
          className="id-drop"
          onDragOver={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.add("drag");
          }}
          onDragLeave={(e) =>
            (e.currentTarget as HTMLElement).classList.remove("drag")
          }
          onDrop={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove("drag");
            if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
          }}
        >
          <span>
            Or <strong>drop images</strong> here / click to upload
          </span>
          <input
            type="file"
            multiple
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      )}

      {items.length > 0 && (
        <div className="id-categories">
          {IDEATION_CATEGORIES.map((c) => {
            const n = categoryCounts.get(c.key) ?? 0;
            if (n === 0) return null;
            const active = activeCategories.has(c.key);
            return (
              <button
                key={c.key}
                type="button"
                className={`id-cat-chip${active ? " active" : ""}`}
                style={
                  active
                    ? {
                        background: c.color,
                        borderColor: c.color,
                        color: "#fff",
                      }
                    : { borderLeft: `3px solid ${c.color}` }
                }
                onClick={() => {
                  setActiveCategories((s) => {
                    const next = new Set(s);
                    if (next.has(c.key)) next.delete(c.key);
                    else next.add(c.key);
                    return next;
                  });
                }}
              >
                {c.label}
                <span className="id-cat-chip-ct">{n}</span>
              </button>
            );
          })}
          {activeCategories.size > 0 && (
            <button
              type="button"
              className="id-cat-chip id-cat-clear"
              onClick={() => setActiveCategories(new Set())}
              title="Clear category filter"
            >
              ✕ clear
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="id-toolbar">
          <input
            type="text"
            className="id-search"
            placeholder="Search title / notes / tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="id-toolbar-count">
            {filtered.length}{filtered.length !== items.length ? ` / ${items.length}` : ""}
          </span>
          {canEdit && (
            <button
              type="button"
              className="btn ghost sm id-delete-all"
              onClick={handleDeleteAll}
              disabled={deleteAllBusy}
              title="Delete every image on this ideation board"
            >
              {deleteAllBusy ? "Deleting…" : "🗑 Delete all"}
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="d-card id-empty">
          <p>
            <strong>Empty board.</strong>{" "}
            {canEdit
              ? "Paste a Pinterest URL above to get started, or drop reference images."
              : "Nothing to see yet."}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="d-card id-empty">
          <p>No images match &ldquo;{search}&rdquo;.</p>
        </div>
      ) : (
        <div className="id-grid">
          {filtered.map((it) => (
            <IdeationCard
              key={it.id}
              item={it}
              products={products}
              linkedProductIds={linkageMap.get(it.id) ?? new Set()}
              onOpen={() => setLightboxItemId(it.id)}
            />
          ))}
        </div>
      )}

      {lightboxItem && (
        <ImageLightbox
          url={lightboxItem.imageUrl}
          alt={lightboxItem.title ?? ""}
          onClose={() => setLightboxItemId(null)}
          extraButton={
            canEdit
              ? {
                  label: "Edit details",
                  onClick: () => {
                    setLightboxItemId(null);
                    setOpenItemId(lightboxItem.id);
                  },
                }
              : undefined
          }
        />
      )}

      {openItem && (
        <IdeationDetailDrawer
          item={openItem}
          products={products}
          linkedProductIds={Array.from(linkageMap.get(openItem.id) ?? new Set())}
          canEdit={canEdit}
          onToast={onToast}
          onClose={() => setOpenItemId(null)}
        />
      )}

      {drawerProduct && (
        <IdeationProductDrawer
          product={drawerProduct}
          files={filesByProduct.get(drawerProduct.id) ?? []}
          linkedItems={items.filter((i) => {
            // Cards visible under this product pill: explicit junction OR
            // global. Mirror the same rule the pill filter uses so the
            // drawer view matches the board view.
            if (i.isGlobal) return true;
            const set = linkageMap.get(i.id);
            return set ? set.has(drawerProduct.id) : false;
          })}
          canEdit={canEdit}
          onEdit={() => setProductModal({ kind: "edit", product: drawerProduct })}
          onDelete={() =>
            setProductModal({ kind: "delete", product: drawerProduct })
          }
          onOpenItem={(itemId) => setLightboxItemId(itemId)}
          onToast={onToast}
          onClose={() => setDrawerProductId(null)}
        />
      )}

      {productModal.kind === "add" && (
        <ProductFormModal
          mode="add"
          existingColors={products.map((p) => p.color)}
          busy={productBusy}
          onCancel={() => setProductModal({ kind: "closed" })}
          onSubmit={(name, color) => submitAddProduct(name, color)}
        />
      )}
      {productModal.kind === "edit" && (
        <ProductFormModal
          mode="edit"
          initial={productModal.product}
          existingColors={products
            .filter((p) => p.id !== productModal.product.id)
            .map((p) => p.color)}
          busy={productBusy}
          onCancel={() => setProductModal({ kind: "closed" })}
          onSubmit={(name, color) =>
            submitEditProduct(productModal.product, name, color)
          }
        />
      )}
      {productModal.kind === "delete" && (
        <ConfirmModal
          title={`Delete "${productModal.product.name}"?`}
          body="Existing ideas linked to this product will lose this specific link, but the ideas themselves are not deleted. You can re-link them to other products at any time."
          confirmLabel="Delete product"
          danger
          busy={productBusy}
          onCancel={() => setProductModal({ kind: "closed" })}
          onConfirm={() => submitDeleteProduct(productModal.product)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Product modals — in-app form for add / edit and a confirm dialog for
// delete. All three replace the previous window.prompt / window.confirm
// flows so input stays inside the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_PRESET_COLORS = [
  "#2563ff",
  "#4ade80",
  "#ff4d2e",
  "#fbbf24",
  "#a78bfa",
  "#22d3ee",
  "#f472b6",
  "#34d399",
  "#60a5fa",
  "#f97316",
];

function ProductFormModal({
  mode,
  initial,
  existingColors,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: "add" | "edit";
  initial?: IdeationProduct;
  existingColors: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, color: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(
    initial?.color ??
      PRODUCT_PRESET_COLORS.find((c) => !existingColors.includes(c)) ??
      PRODUCT_PRESET_COLORS[0],
  );

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(trimmed, color);
  }

  return (
    <div
      className="modal-overlay show"
      role="dialog"
      aria-modal="true"
      // Inline styles so we don't depend on the .modal-overlay CSS class
      // that lives in SuppliersView's CSS string. This file is mounted
      // inside CompetitorsView's scope where that class isn't defined,
      // which previously caused the modal to render at the bottom of the
      // page rather than centered.
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="modal"
        style={{
          width: 480,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--lb-radius-lg)",
          boxShadow: "var(--lb-shadow-lg)",
          color: "var(--text)",
        }}
      >
        <div className="modal-head">
          <h2>{mode === "add" ? "Add product" : "Edit product"}</h2>
        </div>
        <div className="modal-body">
          <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
            <div className="form-group">
              <label>Product name</label>
              <input
                className="form-input"
                placeholder="e.g. Lightcove v2, Pendant Slim, Outdoor Bollard"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSubmit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel();
                  }
                }}
                autoFocus
                disabled={busy}
              />
            </div>
            <div className="form-group">
              <label>Color</label>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {PRODUCT_PRESET_COLORS.map((c) => {
                  const selected = c === color;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      aria-label={`Color ${c}`}
                      aria-pressed={selected}
                      disabled={busy}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 9999,
                        background: c,
                        border: selected
                          ? "3px solid var(--text)"
                          : "1px solid var(--border-strong)",
                        cursor: busy ? "not-allowed" : "pointer",
                        padding: 0,
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  disabled={busy}
                  style={{
                    width: 36,
                    height: 28,
                    padding: 0,
                    border: "1px solid var(--border-strong)",
                    borderRadius: 6,
                    background: "transparent",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                  title="Custom color"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {busy
              ? mode === "add"
                ? "Adding…"
                : "Saving…"
              : mode === "add"
                ? "Add product"
                : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-overlay show"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="modal"
        style={{
          width: 460,
          maxWidth: "100%",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--lb-radius-lg)",
          boxShadow: "var(--lb-shadow-lg)",
          color: "var(--text)",
        }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: "var(--text-2)", lineHeight: 1.55 }}>
            {body}
          </p>
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function IdeationCard({
  item,
  products,
  linkedProductIds,
  onOpen,
}: {
  item: CompetitorIdeationItem;
  products: IdeationProduct[];
  linkedProductIds: Set<number>;
  onOpen: () => void;
}) {
  const userTags = (item.tags ?? []).filter((t) => !t.startsWith("pinterest:"));
  const cat = categoryByKey(item.kind);
  // Resolve the product objects this card is linked to (in product display
  // order). When item.isGlobal is true, we render a single neutral "All"
  // pill instead of per-product dots.
  const linkedProducts = item.isGlobal
    ? []
    : products.filter((p) => linkedProductIds.has(p.id));
  return (
    <button
      type="button"
      className="id-card2"
      onClick={onOpen}
      title={item.title ?? "Open"}
    >
      <div className="id-card2-image">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.imageUrl}
          alt={item.title ?? ""}
          loading="lazy"
          onError={(e) => {
            (e.currentTarget.style.opacity = "0.2");
          }}
        />
        <span
          className="id-card2-cat-badge"
          style={{ background: cat.color }}
        >
          {cat.label}
        </span>
        {/* Product chips overlay — top-right of image. Up to 3 colored dots
            with the product name on hover; "All" pill when global. */}
        {(item.isGlobal || linkedProducts.length > 0) && (
          <span
            className="id-card2-prod-badge"
            title={
              item.isGlobal
                ? "Applies to all products"
                : linkedProducts.map((p) => p.name).join(" · ")
            }
          >
            {item.isGlobal ? (
              <span className="id-card2-prod-all">All</span>
            ) : (
              linkedProducts.slice(0, 3).map((p) => (
                <span
                  key={p.id}
                  className="id-card2-prod-dot"
                  style={{ background: p.color }}
                  aria-label={p.name}
                />
              ))
            )}
            {!item.isGlobal && linkedProducts.length > 3 && (
              <span className="id-card2-prod-more">+{linkedProducts.length - 3}</span>
            )}
          </span>
        )}
      </div>
      {(item.title || item.notes || userTags.length > 0) && (
        <div className="id-card2-info">
          {item.title && <div className="id-card2-title">{item.title}</div>}
          {item.notes && <p className="id-card2-notes">{item.notes}</p>}
          {userTags.length > 0 && (
            <div className="id-card2-tags">
              {userTags.slice(0, 4).map((t) => (
                <span key={t} className="id-card2-tag">
                  {t}
                </span>
              ))}
              {userTags.length > 4 && (
                <span className="id-card2-tag-more">+{userTags.length - 4}</span>
              )}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection brochure card — single-file slot (Product Collection Brochure)
// for the entire collection. Sits at the top of the Ideation board so it's
// always visible. Replaces the existing brochure on each upload (the action
// drops the old blob server-side).
// ─────────────────────────────────────────────────────────────────────────────

function CollectionBrochureCard({
  collection,
  brochure,
  canEdit,
  onToast,
  onChange,
}: {
  collection: CompetitorCollection;
  brochure: IdeationProductFile | null;
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleUpload(files: FileList | File[]) {
    if (!canEdit) return;
    const f = Array.from(files)[0];
    if (!f) return;
    setBusy(true);
    try {
      const safeName = f.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const pathname = `competitors/ideation-collections/${collection.id}/brochure/${crypto.randomUUID()}/${safeName}`;
      const blob = await upload(pathname, f, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: f.type || undefined,
      });
      await replaceCollectionBrochure({
        collectionId: collection.id,
        name: f.name,
        size: f.size,
        mimeType: f.type || null,
        url: blob.url,
        blobPathname: blob.pathname,
      });
      onChange();
      onToast(brochure ? "Brochure replaced" : "Brochure uploaded");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Upload failed", true);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!canEdit || !brochure) return;
    if (!confirm(`Delete "${brochure.name}"?`)) return;
    setBusy(true);
    try {
      await deleteCollectionBrochure(collection.id);
      onChange();
      onToast("Brochure deleted");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setBusy(false);
    }
  }

  function fmtBytes(n: number) {
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <section
      className="d-card"
      style={{
        marginBottom: 12,
        padding: 16,
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--text-2)",
          }}
        >
          {collection.name} Collection
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text)",
            marginTop: 2,
          }}
        >
          Product Collection Brochure
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {brochure ? (
          <a
            href={brochure.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--lb-radius-sm)",
              color: "var(--text)",
              textDecoration: "none",
              fontSize: 13,
            }}
            title={brochure.name}
          >
            <span aria-hidden style={{ fontSize: 16 }}>📄</span>
            <span
              style={{
                flex: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontWeight: 500,
              }}
            >
              {brochure.name}
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>
              {fmtBytes(brochure.size ?? 0)}
            </span>
          </a>
        ) : (
          <div
            style={{
              fontSize: 13,
              color: "var(--muted)",
              fontStyle: "italic",
            }}
          >
            No brochure uploaded yet.
          </div>
        )}
      </div>

      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <label
            className="btn primary sm"
            style={{
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Uploading…" : brochure ? "Replace" : "Upload brochure"}
            <input
              type="file"
              style={{ display: "none" }}
              disabled={busy}
              onChange={(e) => {
                if (e.target.files?.length) handleUpload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {brochure && (
            <button
              type="button"
              className="btn sm danger"
              onClick={handleDelete}
              disabled={busy}
              title="Delete brochure"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </section>
  );
}
