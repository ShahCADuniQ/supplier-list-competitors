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
import IdeationDetailDrawer from "./IdeationDetailDrawer";
import type {
  CompetitorCollection,
  Competitor,
  CompetitorIdeationItem,
  IdeationProduct,
  IdeationItemProduct,
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
  canEdit,
  onToast,
}: {
  collection: CompetitorCollection;
  brands: Competitor[];
  items: CompetitorIdeationItem[];
  products: IdeationProduct[];
  linkages: IdeationItemProduct[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  void _brands;
  const router = useRouter();

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

  // ── Add product flow ──────────────────────────────────────────────────
  const [productBusy, setProductBusy] = useState(false);
  async function handleAddProduct() {
    if (!canEdit) return;
    const name = window.prompt(
      "Product name (e.g. Lightcove v2, Pendant Slim, Outdoor Bollard):",
    );
    if (!name || !name.trim()) return;
    setProductBusy(true);
    try {
      await addIdeationProduct({
        collectionId: collection.id,
        name: name.trim(),
      });
      router.refresh();
      onToast(`Added product "${name.trim()}"`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Add product failed", true);
    } finally {
      setProductBusy(false);
    }
  }

  async function handleRenameProduct(p: IdeationProduct) {
    if (!canEdit) return;
    const next = window.prompt("Rename product:", p.name);
    if (!next || !next.trim() || next.trim() === p.name) return;
    try {
      await updateIdeationProduct({ id: p.id, name: next.trim() });
      router.refresh();
      onToast("Renamed");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Rename failed", true);
    }
  }

  async function handleDeleteProduct(p: IdeationProduct) {
    if (!canEdit) return;
    if (
      !window.confirm(
        `Delete product "${p.name}"? Existing ideas linked to it will lose this specific link (they aren't deleted).`,
      )
    ) {
      return;
    }
    try {
      await deleteIdeationProduct(p.id);
      router.refresh();
      onToast(`Deleted "${p.name}"`);
      if (productFilter === p.id) setProductFilter(null);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    }
  }

  // ── Pinterest extractor ──
  const [pinterestUrl, setPinterestUrl] = useState("");
  const [pinterestComment, setPinterestComment] = useState("");
  const [pinterestKind, setPinterestKind] = useState<IdeationCategoryKey>("moodboard");
  const [pinterestBusy, setPinterestBusy] = useState(false);

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

  // ── Drawer ──
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const openItem = items.find((i) => i.id === openItemId) ?? null;

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
                onClick={() => setProductFilter(p.id)}
                className="id-product-pill"
                data-active={active}
                style={{ "--pill-color": p.color } as React.CSSProperties}
                title={p.description ?? p.name}
              >
                <span className="id-product-pill-dot" aria-hidden />
                {p.name}
                <span className="id-product-pill-ct">{total}</span>
              </button>
              {canEdit && (
                <span className="id-product-pill-acts">
                  <button
                    type="button"
                    title="Rename"
                    aria-label={`Rename ${p.name}`}
                    onClick={() => handleRenameProduct(p)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => handleDeleteProduct(p)}
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
            onClick={handleAddProduct}
            disabled={productBusy}
            title="Add a product you're developing"
          >
            {productBusy ? "Adding…" : "+ Add product"}
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
              onOpen={() => setOpenItemId(it.id)}
            />
          ))}
        </div>
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
