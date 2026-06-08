"use client";

// Supplier Inventory tab — each supplier's product catalog (distinct from
// Lightbase's own inventory_items). Three views in one component:
//   1. List of suppliers that have at least one product in their catalog.
//   2. A picked supplier's catalog as list OR card grid.
//   3. A picked product's detail drawer with 6 categorised attachment tabs.
//
// Every attachment row shows submission date + time per the brief.

import { useEffect, useMemo, useState } from "react";
import { upload } from "@vercel/blob/client";
import FileViewerModal, { forceDownloadFile } from "@/components/FileViewerModal";
import {
  type SupplierProductWithAttachments,
  type SupplierWithProductCount,
  addSupplierProductAttachment,
  createSupplierProduct,
  deleteSupplierProduct,
  deleteSupplierProductAttachment,
  deleteSupplierProductCustomSection,
  linkAlternativeProduct,
  listAlternativeSuppliersForPart,
  listCataloguePartsForLinking,
  moveSupplierProductsToPart,
  promoteToPrimarySupplier,
  unlinkFromAlternativeCluster,
  unmarkPrimarySupplier,
  type AlternativeSupplierPart,
  type CataloguePickerPart,
  listSupplierProducts,
  listSuppliersWithCatalog,
  updateSupplierProduct,
  updateSupplierProductAttachment,
} from "./supplier-inventory-actions";
import {
  SUPPLIER_CATEGORIES,
  SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES,
  shortCategoryLabel,
  type SupplierProductAttachmentCategory,
} from "./supplier-inventory-constants";
import type { SupplierProductAttachment } from "@/db/schema";

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg-elev)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  cursor: "pointer",
  transition: "border-color 160ms ease, transform 160ms ease",
};
const INPUT_STYLE: React.CSSProperties = {
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 13,
  color: "var(--lb-text-1)",
  outline: "none",
  width: "100%",
};
const PILL_BTN = (active: boolean): React.CSSProperties => ({
  padding: "4px 12px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  border: "1px solid var(--lb-border)",
  background: active ? "var(--lb-accent)" : "var(--lb-bg-elev)",
  color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
  cursor: "pointer",
});
const MINI_BTN: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 6,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg-elev)",
  color: "var(--lb-text-1)",
  cursor: "pointer",
};
const PRIMARY_BTN: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  border: "1px solid var(--lb-accent)",
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  cursor: "pointer",
};

// Format an absolute submission timestamp — e.g. "May 19, 2026 · 14:32".
// Used on every attachment row as the brief requires.
function fmtStamp(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtSize(bytes: number | null | undefined): string {
  if (!bytes || bytes < 1024) return `${bytes ?? 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function SupplierInventoryTab({ canEdit }: { canEdit: boolean }) {
  const [suppliers, setSuppliers] = useState<SupplierWithProductCount[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openSupplierId, setOpenSupplierId] = useState<number | null>(null);

  function reload() {
    listSuppliersWithCatalog()
      .then(setSuppliers)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  useEffect(() => {
    if (suppliers === null) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = suppliers ?? [];
    if (!q) return list;
    return list.filter((s) =>
      `${s.name} ${s.category ?? ""}`.toLowerCase().includes(q),
    );
  }, [suppliers, search]);

  if (openSupplierId != null) {
    return (
      <SupplierCatalogView
        supplierId={openSupplierId}
        canEdit={canEdit}
        onBack={() => { setOpenSupplierId(null); reload(); }}
      />
    );
  }

  return (
    <div style={{ padding: 24, background: "var(--lb-bg)", minHeight: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "clamp(22px, 2.6vw, 28px)", fontWeight: 800, letterSpacing: "-0.02em", margin: 0 }}>
            Supplier Inventory
          </h1>
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
            Each supplier&apos;s own product catalog. Click a supplier to manage their products, datasheets, quotes, contracts, certifications, QC reports, and media — every file timestamped at upload.
          </p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          style={{ ...INPUT_STYLE, width: 260 }}
        />
      </header>

      {err && (
        <div style={{ padding: 10, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 8, color: "#dc2626", fontSize: 13 }}>
          {err}
        </div>
      )}

      {suppliers === null ? (
        <div style={{ color: "var(--lb-text-3)", fontSize: 13 }}>Loading suppliers…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--lb-text-3)", fontSize: 13, border: "1px dashed var(--lb-border)", borderRadius: 10 }}>
          No suppliers have products in their catalog yet.
          {canEdit && " Open the Suppliers tab, pick a vendor, then come back here to add their first product."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {filtered.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setOpenSupplierId(s.id)}
              style={{ ...CARD_STYLE, textAlign: "left", border: "1px solid var(--lb-border)" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--lb-accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--lb-border)"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {s.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.logoUrl} alt={s.name} style={{ width: 36, height: 36, objectFit: "contain", borderRadius: 6, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }} />
                ) : (
                  <div style={{ width: 36, height: 36, borderRadius: 6, background: "var(--lb-bg)", border: "1px dashed var(--lb-border)", display: "grid", placeItems: "center", color: "var(--lb-text-3)", fontSize: 14 }}>
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--lb-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>{s.category ?? "—"}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--lb-text-2)" }}>
                <span>{s.productCount} product{s.productCount === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>{s.attachmentCount} file{s.attachmentCount === 1 ? "" : "s"}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                Last activity: {fmtStamp(s.lastUploadAt)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One supplier's catalog — list / card toggle + add-product flow.
// ─────────────────────────────────────────────────────────────────────────────

// Exported so the supplier-facing portal can drop the same catalog UI
// into PortalView with no duplication. `onBack` is optional — the portal
// has no "all suppliers" navigation, so the button hides when not passed.
export function SupplierCatalogView({
  supplierId,
  canEdit,
  onBack,
  showHeader = true,
}: {
  supplierId: number;
  canEdit: boolean;
  onBack?: () => void;
  // The Supplier Inventory tab renders its own page header; the portal
  // wraps the catalog in a Panel which already has its own. Set false to
  // hide the catalog's internal h1 + intro text.
  showHeader?: boolean;
}) {
  const [products, setProducts] = useState<SupplierProductWithAttachments[] | null>(null);
  const [supplierName, setSupplierName] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"card" | "list">("card");
  const [search, setSearch] = useState("");
  const [openProductId, setOpenProductId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  function reload() {
    listSupplierProducts({ supplierId })
      .then((rows) => {
        setProducts(rows);
        if (rows.length > 0) setSupplierName(rows[0].supplierName);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  useEffect(() => {
    if (products === null) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Top-level "parts" only — model rows (parentProductId != null) hang
  // inside their parent's drawer rather than appearing as standalone
  // cards. Search matches on a part OR any of its model children so the
  // user can type a model code and still find it.
  const modelsByParent = useMemo(() => {
    const map = new Map<number, SupplierProductWithAttachments[]>();
    for (const p of products ?? []) {
      if (p.parentProductId != null) {
        const list = map.get(p.parentProductId) ?? [];
        list.push(p);
        map.set(p.parentProductId, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [products]);

  const filtered = useMemo(() => {
    const list = (products ?? []).filter((p) => p.parentProductId == null);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => {
      const hay = [
        p.name,
        p.productCode ?? "",
        p.category ?? "",
        p.description ?? "",
        ...(modelsByParent.get(p.id) ?? []).flatMap((m) => [
          m.name,
          m.productCode ?? "",
          m.description ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [products, search, modelsByParent]);

  const openProduct = openProductId != null
    ? (products ?? []).find((p) => p.id === openProductId) ?? null
    : null;

  return (
    <div style={{
      padding: showHeader ? 24 : 0,
      background: showHeader ? "var(--lb-bg)" : "transparent",
      minHeight: showHeader ? "100%" : undefined,
      display: "flex",
      flexDirection: "column",
      gap: 14,
    }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          {onBack && (
            <button type="button" onClick={onBack} style={{ ...MINI_BTN, marginBottom: 8 }}>← All suppliers</button>
          )}
          {showHeader && (
            <>
              <h1 style={{ fontSize: "clamp(20px, 2.3vw, 26px)", fontWeight: 800, letterSpacing: "-0.02em", margin: 0 }}>
                {supplierName || "Supplier"} — Catalog
              </h1>
              <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
                Each card is a <strong>part</strong>. Open a part to drop part-level files,
                then add <strong>configurations</strong> inside it (e.g. AF Series-22mm → AF21D12H3060G, AF21D12H1060G…) — every configuration carries its own files.
              </p>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            style={{ ...INPUT_STYLE, width: 220 }}
          />
          <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)", borderRadius: 999 }}>
            <button type="button" onClick={() => setView("card")} style={PILL_BTN(view === "card")}>Cards</button>
            <button type="button" onClick={() => setView("list")} style={PILL_BTN(view === "list")}>List</button>
          </div>
          {canEdit && (
            <button type="button" onClick={() => setCreating(true)} style={PRIMARY_BTN}>+ New part</button>
          )}
        </div>
      </header>

      {err && (
        <div style={{ padding: 10, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 8, color: "#dc2626", fontSize: 13 }}>
          {err}
        </div>
      )}

      {products === null ? (
        <div style={{ color: "var(--lb-text-3)", fontSize: 13 }}>Loading catalog…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--lb-text-3)", fontSize: 13, border: "1px dashed var(--lb-border)", borderRadius: 10 }}>
          {search ? "No parts match your search." : "No parts in this catalog yet. Click \"+ New part\" to create one — you can add configurations under it after."}
        </div>
      ) : view === "card" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              modelCount={(modelsByParent.get(p.id) ?? []).length}
              onOpen={() => setOpenProductId(p.id)}
            />
          ))}
        </div>
      ) : (
        <ProductListTable products={filtered} onOpen={(id) => setOpenProductId(id)} />
      )}

      {creating && (
        <NewProductDialog
          supplierId={supplierId}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
        />
      )}
      {openProduct && (
        <ProductDrawer
          product={openProduct}
          // Configurations under this part. Empty array when none.
          models={modelsByParent.get(openProduct.id) ?? []}
          parentProduct={
            openProduct.parentProductId != null
              ? (products ?? []).find((p) => p.id === openProduct.parentProductId) ?? null
              : null
          }
          allProducts={products ?? []}
          canEdit={canEdit}
          onClose={() => setOpenProductId(null)}
          onChanged={reload}
          onOpenSibling={(id) => setOpenProductId(id)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card view of one product. Shows thumbnail + per-category attachment counts.
// ─────────────────────────────────────────────────────────────────────────────

function ProductCard({ product, onOpen, modelCount = 0 }: {
  product: SupplierProductWithAttachments;
  onOpen: () => void;
  modelCount?: number;
}) {
  // Card cover preference:
  //   1. Explicit cover the supplier picked (product.thumbnailUrl).
  //   2. First image-typed attachment from any category — usually a Photo
  //      but falls through to drawings/IES renderings/etc. so even before
  //      the supplier sets a cover the card has something to show.
  //   3. Generic 📦 placeholder.
  const coverFromAttachments = product.attachments.find((a) =>
    isImage(a.contentType, a.name),
  );
  const coverUrl = product.thumbnailUrl ?? coverFromAttachments?.url ?? null;
  const photoCount = product.attachmentCountByCategory.photo_media ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ ...CARD_STYLE, textAlign: "left" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--lb-accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--lb-border)"; }}
    >
      <div style={{ position: "relative", aspectRatio: "4/3", width: "100%", borderRadius: 6, overflow: "hidden", background: "var(--lb-bg)", border: "1px solid var(--lb-border)", display: "grid", placeItems: "center" }}>
        {coverUrl ? (
          // Fit the entire picture in frame (no cropping). The parent
          // tile background fills any letterbox space.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt={product.name} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <span style={{ color: "var(--lb-text-3)", fontSize: 24 }}>📦</span>
        )}
        {photoCount > 1 && (
          <span style={{
            position: "absolute",
            top: 6,
            right: 6,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            background: "rgba(0,0,0,0.6)",
            color: "white",
            backdropFilter: "blur(4px)",
          }}>
            {photoCount} photos
          </span>
        )}
      </div>
      {/* Card heading shows the PRODUCT CODE prominently on top, with the */}
      {/* product name in a smaller line underneath. Code-first matches */}
      {/* how engineers actually look up parts; the name supplies the */}
      {/* human-readable context. */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontWeight: 700,
          fontSize: 15,
          color: "var(--lb-text-1)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          letterSpacing: "-0.01em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {product.productCode || "—"}
        </div>
        {product.name && product.name !== product.productCode && (
          <div style={{
            fontSize: 12,
            color: "var(--lb-text-3)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {product.name}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => {
          const n = product.attachmentCountByCategory[c.key];
          return (
            <span key={c.key} style={{
              fontSize: 10.5,
              padding: "2px 7px",
              borderRadius: 999,
              background: n > 0 ? "rgba(8,145,178,0.15)" : "var(--lb-bg)",
              color: n > 0 ? "#0891b2" : "var(--lb-text-3)",
              border: `1px solid ${n > 0 ? "rgba(8,145,178,0.3)" : "var(--lb-border)"}`,
              fontWeight: 600,
            }}>
              {shortLabel(c.key)} · {n}
            </span>
          );
        })}
      </div>
      <div style={{
        fontSize: 10.5,
        color: "var(--lb-text-3)",
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "center",
      }}>
        <span>Added {fmtStamp(product.createdAt)}</span>
        {modelCount > 0 && (
          <span style={{
            padding: "2px 7px",
            borderRadius: 999,
            background: "rgba(124,58,237,0.15)",
            color: "#7c3aed",
            border: "1px solid rgba(124,58,237,0.3)",
            fontWeight: 700,
          }}>
            {modelCount} model{modelCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </button>
  );
}
const shortLabel = shortCategoryLabel;

// ─────────────────────────────────────────────────────────────────────────────
// List view of products — denser than cards, surfaces the same per-category
// counts as columns.
// ─────────────────────────────────────────────────────────────────────────────

function ProductListTable({ products, onOpen }: {
  products: SupplierProductWithAttachments[];
  onOpen: (id: number) => void;
}) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--lb-border)", borderRadius: 10, background: "var(--lb-bg-elev)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--lb-border)", background: "var(--lb-bg)" }}>
            <th style={th(60)}>Img</th>
            <th style={th()}>Product code</th>
            <th style={th(150)}>Category</th>
            {SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => (
              <th key={c.key} style={th(70, "center")} title={c.label}>{shortLabel(c.key)}</th>
            ))}
            <th style={th(150)}>Added</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr
              key={p.id}
              onClick={() => onOpen(p.id)}
              style={{ borderTop: "1px solid var(--lb-border)", cursor: "pointer" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "rgba(8,145,178,0.04)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
            >
              <td style={td()}>
                {(() => {
                  const fallback = p.attachments.find((a) => isImage(a.contentType, a.name));
                  const url = p.thumbnailUrl ?? fallback?.url ?? null;
                  return url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={p.name} style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, border: "1px solid var(--lb-border)" }} />
                  ) : (
                    <div style={{ width: 36, height: 36, borderRadius: 5, background: "var(--lb-bg)", border: "1px dashed var(--lb-border)", display: "grid", placeItems: "center", color: "var(--lb-text-3)" }}>📦</div>
                  );
                })()}
              </td>
              <td style={td()}>
                {/* Product code is the primary identifier in the list view */}
                {/* (matches the card heading). Internal name + description */}
                {/* live in the drawer — surfacing them here was noisy. */}
                <code style={{
                  fontWeight: 700,
                  fontSize: 13,
                  background: "rgba(8,145,178,0.12)",
                  color: "#0891b2",
                  padding: "2px 8px",
                  borderRadius: 5,
                }}>
                  {p.productCode || "—"}
                </code>
              </td>
              <td style={td()}>{p.category ?? "—"}</td>
              {SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => {
                const n = p.attachmentCountByCategory[c.key];
                return (
                  <td key={c.key} style={{ ...td(), textAlign: "center" }}>
                    <span style={{
                      display: "inline-block",
                      minWidth: 22,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: n > 0 ? "rgba(8,145,178,0.15)" : "var(--lb-bg)",
                      color: n > 0 ? "#0891b2" : "var(--lb-text-3)",
                      fontWeight: 600,
                      fontSize: 11.5,
                    }}>{n}</span>
                  </td>
                );
              })}
              <td style={td()}>{fmtStamp(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function th(width?: number, align: "left" | "center" | "right" = "left"): React.CSSProperties {
  return {
    padding: "8px 10px",
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--lb-text-3)",
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    textAlign: align,
    width,
  };
}
function td(): React.CSSProperties {
  return { padding: "8px 10px", color: "var(--lb-text-2)", verticalAlign: "middle" };
}

// ─────────────────────────────────────────────────────────────────────────────
// New product dialog
// ─────────────────────────────────────────────────────────────────────────────

function NewProductDialog({ supplierId, onClose, onCreated, parentProductId, parentName }: {
  supplierId: number;
  onClose: () => void;
  onCreated: () => void;
  // When set, the new row is created as a model under this part.
  parentProductId?: number;
  parentName?: string;
}) {
  const [name, setName] = useState("");
  const [productCode, setProductCode] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) { setErr("Name is required"); return; }
    setBusy(true); setErr(null);
    try {
      await createSupplierProduct({
        supplierId,
        name,
        productCode: productCode || undefined,
        category: category || undefined,
        description: description || undefined,
        parentProductId,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={
        parentProductId != null
          ? `New model under ${parentName ?? "part"}`
          : "New product"
      }
      onClose={onClose}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Field label="Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AF21D12H80G LED Module" style={INPUT_STYLE} autoFocus />
        </Field>
        <Field label="Product code">
          <input value={productCode} onChange={(e) => setProductCode(e.target.value)} placeholder="e.g. AF21-D12-H80G" style={INPUT_STYLE} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={INPUT_STYLE}>
            <option value="">— select a category —</option>
            {SUPPLIER_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short internal description (not shown on the card)." style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }} />
        </Field>
        {err && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={MINI_BTN}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy} style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Product drawer — 6 tabs, one per attachment category. Each tab lists the
// attachments with submission timestamp + size and an upload button.
// ─────────────────────────────────────────────────────────────────────────────

// Tab state for the drawer rail. "enum" → one of the fixed canonical
// sections; "custom" → a free-text section the supplier created. Custom
// sections persist via their attachments (category='other_file' rows
// carrying customCategoryLabel) plus a transient local list for
// freshly-created sections that have no files yet.
type ActiveTab =
  | { kind: "enum"; key: SupplierProductAttachmentCategory }
  | { kind: "custom"; label: string };

export function ProductDrawer({ product, models, parentProduct, allProducts, canEdit, onClose, onChanged, onOpenSibling }: {
  product: SupplierProductWithAttachments;
  // Sub-models nested under this part. Empty for parts with no
  // configurations, and ignored entirely when the drawer is showing a
  // model (models can't have models of their own).
  models: SupplierProductWithAttachments[];
  // When the drawer is showing a MODEL, this is the part it belongs to.
  // Null when the drawer is on a top-level part.
  parentProduct: SupplierProductWithAttachments | null;
  // Every product for this supplier (parts + models). Used by the
  // "Move existing parts in" picker so the admin can promote flat
  // products into the current part as configurations.
  allProducts: SupplierProductWithAttachments[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
  // Open another product (a sibling model, or the parent part). The
  // parent owns the open-product state so we route through it instead
  // of pushing local drawer stacks.
  onOpenSibling: (id: number) => void;
}) {
  const [tab, setTab] = useState<ActiveTab>({ kind: "enum", key: "spec_datasheet" });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creatingModel, setCreatingModel] = useState(false);
  const [movingExisting, setMovingExisting] = useState(false);

  const isPart = product.parentProductId == null;
  // Locally-created sections that have no files yet. They live here
  // until the supplier uploads the first file into them — after that the
  // section persists naturally as a group of "other_file" attachments.
  const [draftSections, setDraftSections] = useState<string[]>([]);

  const grouped = useMemo(() => {
    const out = Object.fromEntries(
      SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => [c.key, [] as SupplierProductAttachment[]]),
    ) as Record<SupplierProductAttachmentCategory, SupplierProductAttachment[]>;
    for (const a of product.attachments) {
      const key = a.category as SupplierProductAttachmentCategory;
      if (out[key]) out[key].push(a);
    }
    return out;
  }, [product.attachments]);

  // Custom sections derived from the attachments themselves — group
  // category='other_file' rows by their customCategoryLabel
  // (case-insensitive). Empty drafts the supplier just created are
  // unioned in so the rail entry shows up even before the first upload.
  const customSections = useMemo(() => {
    const byKey = new Map<string, { label: string; attachments: SupplierProductAttachment[] }>();
    for (const a of product.attachments) {
      if (a.category !== "other_file") continue;
      const label = (a.customCategoryLabel ?? "").trim();
      if (!label) continue;
      const k = label.toLowerCase();
      const existing = byKey.get(k);
      if (existing) existing.attachments.push(a);
      else byKey.set(k, { label, attachments: [a] });
    }
    for (const d of draftSections) {
      const k = d.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, { label: d, attachments: [] });
    }
    return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [product.attachments, draftSections]);

  function addCustomSection() {
    const raw = window.prompt("Name this section (e.g. Installation guides, Warranty docs):");
    const name = (raw ?? "").trim();
    if (!name) return;
    if (name.length > 80) {
      setErr("Section names must be 80 characters or fewer.");
      return;
    }
    const existingLabels = new Set([
      ...customSections.map((s) => s.label.toLowerCase()),
      ...draftSections.map((s) => s.toLowerCase()),
    ]);
    if (!existingLabels.has(name.toLowerCase())) {
      setDraftSections((prev) => [...prev, name]);
    }
    setTab({ kind: "custom", label: name });
  }

  // After a successful upload into a draft section, drop it from
  // draftSections (it's now persisted via its attachments). Triggered by
  // the parent reload via the existing onChanged callback.
  useEffect(() => {
    if (draftSections.length === 0) return;
    const persistedLabels = new Set(
      customSections
        .filter((s) => s.attachments.length > 0)
        .map((s) => s.label.toLowerCase()),
    );
    const stillDrafts = draftSections.filter((d) => !persistedLabels.has(d.toLowerCase()));
    if (stillDrafts.length !== draftSections.length) {
      setDraftSections(stillDrafts);
    }
  }, [customSections, draftSections]);

  async function onDelete() {
    if (!confirm(`Delete "${product.name}" and every attached file? This can't be undone.`)) return;
    setBusy(true); setErr(null);
    try {
      await deleteSupplierProduct({ id: product.id });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally { setBusy(false); }
  }

  return (
    <DrawerShell title={product.name} subtitle={product.supplierName} onClose={onClose}>
      {/* Breadcrumb back to parent — only on models. */}
      {parentProduct && (
        <div style={{
          padding: "10px 16px 0",
          fontSize: 12,
          color: "var(--lb-text-3)",
        }}>
          <button
            type="button"
            onClick={() => onOpenSibling(parentProduct.id)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--lb-accent)",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            ← Back to {parentProduct.name}
          </button>
          <span style={{ margin: "0 6px" }}>·</span>
          <span style={{ fontWeight: 700, color: "var(--lb-text-2)" }}>
            Model / configuration
          </span>
        </div>
      )}

      {/* product meta + edit/delete */}
      <ProductMetaBlock
        product={product}
        editing={editing && canEdit}
        onToggleEdit={() => setEditing((v) => !v)}
        onSaved={() => { setEditing(false); onChanged(); }}
        onDelete={onDelete}
        canEdit={canEdit}
        busy={busy}
      />
      {err && <div style={{ color: "#dc2626", fontSize: 12.5, padding: "4px 16px" }}>{err}</div>}

      {/* Alternative products — same component, different supplier.
          Rendered for BOTH parts and configurations so each level can
          have its own primary/backup cluster (configs are linked
          separately from their parent). */}
      <AlternativeSuppliersBlock
        partId={product.id}
        canEdit={canEdit}
        onChanged={onChanged}
        onOpenAlternative={(id) => onOpenSibling(id)}
        isConfig={!isPart}
      />

      {/* Configurations — only shown for parts (not models). */}
      {isPart && (
        <ModelsBlock
          parentProduct={product}
          models={models}
          canEdit={canEdit}
          onOpenModel={(id) => onOpenSibling(id)}
          onAddModel={() => setCreatingModel(true)}
          onMoveExisting={() => setMovingExisting(true)}
        />
      )}

      {creatingModel && (
        <NewProductDialog
          supplierId={product.supplierId}
          parentProductId={product.id}
          parentName={product.name}
          onClose={() => setCreatingModel(false)}
          onCreated={() => { setCreatingModel(false); onChanged(); }}
        />
      )}

      {movingExisting && (
        <MoveProductsToPartDialog
          parent={product}
          // Pickable rows = all OTHER top-level parts on the same
          // supplier (you can't pull a row into itself, and we don't
          // surface existing configurations because they're already
          // nested somewhere).
          candidates={allProducts.filter(
            (p) =>
              p.id !== product.id &&
              p.supplierId === product.supplierId &&
              p.parentProductId == null,
          )}
          onClose={() => setMovingExisting(false)}
          onMoved={() => { setMovingExisting(false); onChanged(); }}
        />
      )}

      {/* Vertical category rail on the left, panel on the right. Each */}
      {/* button stretches full-width so even long labels stay legible — no */}
      {/* horizontal scroll. The drawer itself scrolls vertically when */}
      {/* either column overflows. */}
      <div style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
        <nav
          role="tablist"
          aria-label="Attachment categories"
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: "1px solid var(--lb-border)",
            background: "var(--lb-bg-elev)",
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            position: "sticky",
            top: 64, // sit just below the sticky drawer header
            alignSelf: "flex-start",
          }}
        >
          {SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => {
            const n = grouped[c.key].length;
            const active = tab.kind === "enum" && tab.key === c.key;
            return (
              <RailButton
                key={c.key}
                label={c.label}
                count={n}
                active={active}
                onClick={() => setTab({ kind: "enum", key: c.key })}
              />
            );
          })}

          {/* Custom sections live below the canonical eight. */}
          {customSections.length > 0 && (
            <div style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--lb-border)",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              padding: "8px 10px 4px",
            }}>
              Your sections
            </div>
          )}
          {customSections.map((s) => {
            const active = tab.kind === "custom" && tab.label.toLowerCase() === s.label.toLowerCase();
            return (
              <RailButton
                key={`custom:${s.label.toLowerCase()}`}
                label={s.label}
                count={s.attachments.length}
                active={active}
                onClick={() => setTab({ kind: "custom", label: s.label })}
              />
            );
          })}

          {canEdit && (
            <button
              type="button"
              onClick={addCustomSection}
              style={{
                marginTop: 6,
                padding: "8px 10px",
                fontSize: 12.5,
                fontWeight: 600,
                borderRadius: 6,
                border: "1px dashed var(--lb-border)",
                background: "transparent",
                color: "var(--lb-text-2)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              + Add section
            </button>
          )}
        </nav>
        <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
          {tab.kind === "enum" ? (
            <CategoryPanel
              productId={product.id}
              productThumbnailUrl={product.thumbnailUrl}
              category={tab.key}
              customCategoryLabel={null}
              attachments={grouped[tab.key]}
              canEdit={canEdit}
              onChanged={onChanged}
            />
          ) : (
            <CategoryPanel
              productId={product.id}
              productThumbnailUrl={product.thumbnailUrl}
              category="other_file"
              customCategoryLabel={tab.label}
              attachments={
                customSections.find(
                  (s) => s.label.toLowerCase() === tab.label.toLowerCase(),
                )?.attachments ?? []
              }
              canEdit={canEdit}
              onChanged={onChanged}
              onDeleteCustomSection={async (label) => {
                const section = customSections.find(
                  (s) => s.label.toLowerCase() === label.toLowerCase(),
                );
                const fileCount = section?.attachments.length ?? 0;
                // Draft section (no files yet): just drop it locally
                // and pop the tab back to the first canonical entry.
                if (fileCount === 0) {
                  setDraftSections((prev) => prev.filter((d) => d.toLowerCase() !== label.toLowerCase()));
                  setTab({ kind: "enum", key: "spec_datasheet" });
                  return;
                }
                const ok = window.confirm(
                  `Delete the "${label}" section and the ${fileCount} file${fileCount === 1 ? "" : "s"} inside? This can't be undone.`,
                );
                if (!ok) return;
                setBusy(true);
                setErr(null);
                try {
                  await deleteSupplierProductCustomSection({
                    productId: product.id,
                    customCategoryLabel: label,
                  });
                  setTab({ kind: "enum", key: "spec_datasheet" });
                  onChanged();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : "Section delete failed");
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </div>
      </div>
    </DrawerShell>
  );
}

// Part-level "Models / Configurations" block. Rendered only when the
// drawer is showing a top-level part. Each model carries its own
// attachment categories; clicking a row swaps the drawer to that
// model's view (via onOpenModel). The "+ Add model" button kicks off
// the NewProductDialog with parentProductId pre-filled.
function ModelsBlock({
  parentProduct,
  models,
  canEdit,
  onOpenModel,
  onAddModel,
  onMoveExisting,
}: {
  parentProduct: SupplierProductWithAttachments;
  models: SupplierProductWithAttachments[];
  canEdit: boolean;
  onOpenModel: (id: number) => void;
  onAddModel: () => void;
  // Open the "move existing parts into this part as configurations"
  // picker. Lets the admin promote a flat catalog into a single part.
  onMoveExisting: () => void;
}) {
  return (
    <section
      style={{
        padding: 16,
        borderBottom: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
            }}
          >
            Configurations
          </div>
          <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>
            {models.length === 0
              ? `No configurations for ${parentProduct.name} yet. Files dropped below apply to the part itself.`
              : `${models.length} configuration${models.length === 1 ? "" : "s"} under ${parentProduct.name}. Each one carries its own files.`}
          </div>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onMoveExisting}
              style={{
                padding: "6px 14px",
                fontSize: 12.5,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text)",
                cursor: "pointer",
              }}
            >
              Move existing parts in…
            </button>
            <button
              type="button"
              onClick={onAddModel}
              style={{
                padding: "6px 14px",
                fontSize: 12.5,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-accent)",
                border: "1px solid var(--lb-accent)",
                color: "var(--lb-accent-fg)",
                cursor: "pointer",
              }}
            >
              + Add configuration
            </button>
          </div>
        )}
      </div>

      {models.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {models.map((m) => {
            const fileCount = m.attachments.length;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onOpenModel(m.id)}
                  title="Open this model's files"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 13,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontFamily: m.productCode
                          ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                          : undefined,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.productCode || m.name}
                    </div>
                    {m.productCode && m.name && m.name !== m.productCode && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--lb-text-3)",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.name}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--lb-text-3)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fileCount} file{fileCount === 1 ? "" : "s"}
                  </span>
                  {m.productUrl && (
                    // Per-configuration source link. Stop propagation so the
                    // click opens the URL instead of also opening the model
                    // drawer. Nested <a> inside <button> is invalid HTML, so
                    // we use a styled span + window.open.
                    <span
                      role="link"
                      tabIndex={0}
                      title={m.productUrl}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (m.productUrl) {
                          window.open(
                            m.productUrl,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      }}
                      onKeyDown={(e) => {
                        if (
                          (e.key === "Enter" || e.key === " ") &&
                          m.productUrl
                        ) {
                          e.preventDefault();
                          e.stopPropagation();
                          window.open(
                            m.productUrl,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      }}
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--lb-accent)",
                        padding: "2px 6px",
                        borderRadius: 6,
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                    >
                      ↗
                    </span>
                  )}
                  <span style={{ color: "var(--lb-text-3)", fontSize: 14 }}>→</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Picker dialog: pull existing top-level parts into the current part as
// configurations. Multi-select with a search filter; on save it calls
// moveSupplierProductsToPart which sets parent_product_id on every
// selected row in one shot.
function MoveProductsToPartDialog({
  parent,
  candidates,
  onClose,
  onMoved,
}: {
  parent: SupplierProductWithAttachments;
  candidates: SupplierProductWithAttachments[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((p) =>
      `${p.name} ${p.productCode ?? ""} ${p.category ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [candidates, search]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await moveSupplierProductsToPart({
        productIds: Array.from(selected),
        parentProductId: parent.id,
      });
      onMoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`Move parts into ${parent.name}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--lb-text-3)" }}>
          Pick the existing parts you want to nest as configurations under{" "}
          <strong>{parent.name}</strong>. Their files come with them — nothing is
          re-uploaded.
        </p>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, code, or category…"
          style={INPUT_STYLE}
          autoFocus
        />
        {candidates.length === 0 ? (
          <div
            style={{
              padding: 16,
              textAlign: "center",
              border: "1px dashed var(--lb-border)",
              borderRadius: 8,
              color: "var(--lb-text-3)",
              fontSize: 12.5,
            }}
          >
            No other top-level parts on this supplier yet.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 320,
              overflowY: "auto",
              border: "1px solid var(--lb-border)",
              borderRadius: 8,
              background: "var(--lb-bg)",
            }}
          >
            {filtered.length === 0 ? (
              <li style={{ padding: 12, color: "var(--lb-text-3)", fontSize: 12.5 }}>
                Nothing matches that filter.
              </li>
            ) : (
              filtered.map((p) => {
                const on = selected.has(p.id);
                return (
                  <li key={p.id}>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background: on
                          ? "color-mix(in srgb, var(--lb-accent) 12%, transparent)"
                          : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(p.id)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: "var(--lb-text)",
                            fontFamily: p.productCode
                              ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                              : undefined,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.productCode || p.name}
                        </div>
                        {p.productCode && p.name && p.name !== p.productCode && (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "var(--lb-text-3)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.name}
                          </div>
                        )}
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--lb-text-3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.attachments.length} file{p.attachments.length === 1 ? "" : "s"}
                      </span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        )}
        {err && (
          <div
            style={{
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
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
            {selected.size} selected
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={MINI_BTN} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || selected.size === 0}
              style={{
                ...PRIMARY_BTN,
                opacity: busy || selected.size === 0 ? 0.6 : 1,
              }}
            >
              {busy
                ? "Moving…"
                : selected.size > 0
                  ? `Move ${selected.size} into ${parent.name}`
                  : "Pick at least one"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// Alternative-product cluster for a part. Every product in the
// cluster is its own catalogue entry tied to its own supplier; here
// we list the cluster, let the admin link more EXISTING products
// in, mark one as primary, demote primaries, or unlink products
// that don't actually belong.
function AlternativeSuppliersBlock({
  partId,
  canEdit,
  onChanged,
  onOpenAlternative,
  isConfig,
}: {
  partId: number;
  canEdit: boolean;
  onChanged: () => void;
  onOpenAlternative: (id: number) => void;
  // Drives the labels/copy: same logic for parts vs. configurations,
  // just different language ("alternative product" vs. "alternative
  // configuration").
  isConfig: boolean;
}) {
  const [alts, setAlts] = useState<AlternativeSupplierPart[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);

  function reload() {
    listAlternativeSuppliersForPart({ partId })
      .then(setAlts)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId]);

  async function promote(id: number) {
    setBusyId(id);
    setErr(null);
    try {
      await promoteToPrimarySupplier({ partId: id });
      reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Promote failed");
    } finally {
      setBusyId(null);
    }
  }
  async function unmark(id: number) {
    setBusyId(id);
    setErr(null);
    try {
      await unmarkPrimarySupplier({ partId: id });
      reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unmark failed");
    } finally {
      setBusyId(null);
    }
  }
  async function unlink(id: number) {
    if (!confirm("Remove this product from the alternative cluster? Its files stay; only the cross-supplier link is broken.")) return;
    setBusyId(id);
    setErr(null);
    try {
      await unlinkFromAlternativeCluster({ partId: id });
      reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unlink failed");
    } finally {
      setBusyId(null);
    }
  }

  const primary = alts?.find((a) => a.isPrimarySupplier) ?? null;
  const backups = alts?.filter((a) => !a.isPrimarySupplier) ?? [];

  return (
    <section
      style={{
        padding: 16,
        borderBottom: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
            }}
          >
            {isConfig ? "Alternative configurations" : "Alternative products"}
          </div>
          <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>
            {alts === null
              ? "Loading…"
              : alts.length <= 1
                ? isConfig
                  ? "No alternative configurations linked. Pick another configuration from the catalogue and link it as a backup variant."
                  : "No alternatives linked. Pick another existing product from the catalogue and link it as a backup."
                : primary
                  ? `${backups.length} backup${backups.length === 1 ? "" : "s"} on file. Demote the primary, promote a backup, or link more.`
                  : `${alts.length} ${isConfig ? "configuration" : "product"}${alts.length === 1 ? "" : "s"} in this cluster — none marked primary yet. Pick one to set as primary.`}
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setLinking(true)}
            style={{
              padding: "6px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              background: "var(--lb-accent)",
              border: "1px solid var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              cursor: "pointer",
            }}
          >
            {isConfig ? "+ Link alternative configuration" : "+ Link alternative product"}
          </button>
        )}
      </div>

      {err && (
        <div
          style={{
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

      {alts && alts.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {[primary, ...backups].filter(Boolean).map((a) => {
            if (!a) return null;
            const here = a.id === partId;
            return (
              <li key={a.id}>
                <div
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: a.isPrimarySupplier
                      ? "color-mix(in srgb, #16a34a 10%, var(--lb-bg))"
                      : "var(--lb-bg)",
                    border: a.isPrimarySupplier
                      ? "1px solid #16a34a"
                      : "1px solid var(--lb-border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: 0.4,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: a.isPrimarySupplier ? "#16a34a" : "var(--lb-bg-elev)",
                      color: a.isPrimarySupplier ? "white" : "var(--lb-text-3)",
                      border: a.isPrimarySupplier
                        ? "1px solid #16a34a"
                        : "1px solid var(--lb-border)",
                      flexShrink: 0,
                    }}
                  >
                    {a.isPrimarySupplier ? "★ PRIMARY" : "ALTERNATIVE"}
                  </span>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "var(--lb-text)" }}>
                      {a.supplierName}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--lb-text-3)",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.productCode ? `${a.productCode} · ` : ""}
                      {a.name}
                      {a.modelCount > 0 && ` · ${a.modelCount} config${a.modelCount === 1 ? "" : "s"}`}
                      {a.attachmentCount > 0 && ` · ${a.attachmentCount} file${a.attachmentCount === 1 ? "" : "s"}`}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {!here && (
                      <button
                        type="button"
                        onClick={() => onOpenAlternative(a.id)}
                        title="Open this product"
                        style={{
                          padding: "5px 10px",
                          fontSize: 11.5,
                          fontWeight: 700,
                          borderRadius: 999,
                          background: "var(--lb-bg-elev)",
                          border: "1px solid var(--lb-border)",
                          color: "var(--lb-text-2)",
                          cursor: "pointer",
                        }}
                      >
                        Open →
                      </button>
                    )}
                    {canEdit && !a.isPrimarySupplier && (
                      <button
                        type="button"
                        onClick={() => promote(a.id)}
                        disabled={busyId === a.id}
                        style={{
                          padding: "5px 12px",
                          fontSize: 11.5,
                          fontWeight: 700,
                          borderRadius: 999,
                          background: "#16a34a",
                          border: "1px solid #16a34a",
                          color: "white",
                          cursor: busyId === a.id ? "wait" : "pointer",
                          opacity: busyId === a.id ? 0.6 : 1,
                        }}
                      >
                        Mark as primary
                      </button>
                    )}
                    {canEdit && a.isPrimarySupplier && (
                      <button
                        type="button"
                        onClick={() => unmark(a.id)}
                        disabled={busyId === a.id}
                        style={{
                          padding: "5px 12px",
                          fontSize: 11.5,
                          fontWeight: 700,
                          borderRadius: 999,
                          background: "transparent",
                          border: "1px solid var(--lb-border)",
                          color: "var(--lb-text-2)",
                          cursor: busyId === a.id ? "wait" : "pointer",
                          opacity: busyId === a.id ? 0.6 : 1,
                        }}
                      >
                        Unmark primary
                      </button>
                    )}
                    {canEdit && alts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => unlink(a.id)}
                        disabled={busyId === a.id}
                        title="Remove this product from the alternative cluster"
                        style={{
                          padding: "5px 10px",
                          fontSize: 11.5,
                          fontWeight: 700,
                          borderRadius: 999,
                          background: "transparent",
                          border: "1px solid rgba(220,38,38,0.45)",
                          color: "#dc2626",
                          cursor: busyId === a.id ? "wait" : "pointer",
                          opacity: busyId === a.id ? 0.6 : 1,
                        }}
                      >
                        Unlink
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {linking && (
        <LinkAlternativeProductDialog
          partId={partId}
          isConfig={isConfig}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

// Picker dialog — pick another EXISTING product from the catalogue to
// link as an alternative. Shows every other top-level part in the
// tenant; selecting one merges its cluster into the current part's.
function LinkAlternativeProductDialog({
  partId,
  isConfig,
  onClose,
  onLinked,
}: {
  partId: number;
  isConfig: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [parts, setParts] = useState<CataloguePickerPart[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"card" | "list">("card");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listCataloguePartsForLinking({ excludePartId: partId })
      .then(setParts)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, [partId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parts ?? [];
    return (parts ?? []).filter((p) =>
      `${p.name} ${p.productCode ?? ""} ${p.category ?? ""} ${p.supplierName}`
        .toLowerCase()
        .includes(q),
    );
  }, [parts, search]);

  async function submit() {
    if (selectedId == null || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await linkAlternativeProduct({
        existingPartId: partId,
        alternativePartId: selectedId,
      });
      onLinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Link failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={
        isConfig
          ? "Link an alternative configuration"
          : "Link an alternative product"
      }
      onClose={onClose}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--lb-text-3)" }}>
          {isConfig
            ? "Pick another configuration that already exists in the catalogue. The two configurations merge into one alternative cluster, independent of their parent parts' clusters."
            : "Pick a product that already exists in the catalogue. The two rows merge into one alternative cluster — files, history, and search stay linked across suppliers without re-uploading anything."}
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code, name, category, supplier…"
            style={{ ...INPUT_STYLE, flex: 1, minWidth: 200 }}
            autoFocus
          />
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: 3,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 999,
            }}
          >
            <button type="button" onClick={() => setView("card")} style={PILL_BTN(view === "card")}>
              Cards
            </button>
            <button type="button" onClick={() => setView("list")} style={PILL_BTN(view === "list")}>
              List
            </button>
          </div>
        </div>
        {parts === null ? (
          <div style={{ padding: 12, color: "var(--lb-text-3)", fontSize: 12.5 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              padding: 16,
              textAlign: "center",
              border: "1px dashed var(--lb-border)",
              borderRadius: 8,
              color: "var(--lb-text-3)",
              fontSize: 12.5,
            }}
          >
            {parts.length === 0
              ? "No other products in the catalogue yet."
              : "No products match that filter."}
          </div>
        ) : view === "card" ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 10,
              maxHeight: 460,
              overflowY: "auto",
              padding: 4,
            }}
          >
            {filtered.map((p) => {
              const on = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 10,
                    borderRadius: 10,
                    background: on
                      ? "color-mix(in srgb, var(--lb-accent) 14%, var(--lb-bg-elev))"
                      : "var(--lb-bg-elev)",
                    border: on
                      ? "2px solid var(--lb-accent)"
                      : "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "border-color 140ms ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!on) e.currentTarget.style.borderColor = "var(--lb-accent)";
                  }}
                  onMouseLeave={(e) => {
                    if (!on) e.currentTarget.style.borderColor = "var(--lb-border)";
                  }}
                >
                  <div
                    style={{
                      aspectRatio: "4/3",
                      width: "100%",
                      borderRadius: 6,
                      overflow: "hidden",
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {p.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.thumbnailUrl}
                        alt={p.name}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    ) : (
                      <span style={{ fontSize: 20, color: "var(--lb-text-3)" }}>📦</span>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        fontFamily: p.productCode
                          ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                          : undefined,
                        letterSpacing: "-0.01em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.productCode || p.name}
                    </div>
                    {p.productCode && p.name && p.name !== p.productCode && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--lb-text-3)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 2,
                        }}
                      >
                        {p.name}
                      </div>
                    )}
                    {p.parentName && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--lb-text-3)",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        under{" "}
                        <strong style={{ color: "var(--lb-text-2)" }}>
                          {p.parentProductCode || p.parentName}
                        </strong>
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      fontSize: 10.5,
                    }}
                  >
                    <span
                      style={{
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: "rgba(8,145,178,0.15)",
                        color: "#0891b2",
                        border: "1px solid rgba(8,145,178,0.3)",
                        fontWeight: 700,
                      }}
                    >
                      {p.supplierName}
                    </span>
                    {p.category && (
                      <span
                        style={{
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: "var(--lb-bg)",
                          border: "1px solid var(--lb-border)",
                          color: "var(--lb-text-3)",
                          fontWeight: 600,
                        }}
                      >
                        {p.category}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 460,
              overflowY: "auto",
              border: "1px solid var(--lb-border)",
              borderRadius: 8,
              background: "var(--lb-bg)",
            }}
          >
            {filtered.map((p) => {
              const on = p.id === selectedId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      alignItems: "stretch",
                      padding: "10px 12px",
                      borderRadius: 6,
                      background: on
                        ? "color-mix(in srgb, var(--lb-accent) 14%, transparent)"
                        : "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      color: on ? "var(--lb-accent)" : "var(--lb-text)",
                    }}
                  >
                    <div style={{
                      fontSize: 13,
                      fontWeight: 700,
                      fontFamily: p.productCode
                        ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                        : undefined,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {p.productCode || p.name}
                    </div>
                    <div style={{
                      fontSize: 11.5,
                      color: on ? "var(--lb-accent)" : "var(--lb-text-3)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {p.supplierName}
                      {p.category ? ` · ${p.category}` : ""}
                      {p.productCode && p.name && p.name !== p.productCode ? ` · ${p.name}` : ""}
                      {p.parentName ? ` · under ${p.parentProductCode || p.parentName}` : ""}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {err && (
          <div
            style={{
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
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={MINI_BTN} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || selectedId == null}
            style={{
              ...PRIMARY_BTN,
              opacity: busy || selectedId == null ? 0.6 : 1,
            }}
          >
            {busy ? "Linking…" : "Link as alternative"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function RailButton({ label, count, active, onClick }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 10px",
        fontSize: 12.5,
        fontWeight: active ? 700 : 500,
        borderRadius: 6,
        border: active ? "1px solid var(--lb-accent)" : "1px solid transparent",
        background: active ? "rgba(8,145,178,0.12)" : "transparent",
        color: active ? "var(--lb-accent)" : "var(--lb-text-2)",
        cursor: "pointer",
        textAlign: "left",
        transition: "background 140ms ease, color 140ms ease",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        minWidth: 22,
        padding: "1px 7px",
        borderRadius: 999,
        background: count > 0
          ? (active ? "var(--lb-accent)" : "rgba(8,145,178,0.18)")
          : "var(--lb-bg)",
        color: count > 0 ? (active ? "var(--lb-accent-fg)" : "#0891b2") : "var(--lb-text-3)",
        textAlign: "center",
      }}>
        {count}
      </span>
    </button>
  );
}

function ProductMetaBlock({ product, editing, onToggleEdit, onSaved, onDelete, canEdit, busy }: {
  product: SupplierProductWithAttachments;
  editing: boolean;
  onToggleEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
  canEdit: boolean;
  busy: boolean;
}) {
  const [name, setName] = useState(product.name);
  const [productCode, setProductCode] = useState(product.productCode ?? "");
  const [category, setCategory] = useState(product.category ?? "");
  const [description, setDescription] = useState(product.description ?? "");
  const [notes, setNotes] = useState(product.notes ?? "");
  const [productUrl, setProductUrl] = useState(product.productUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(product.name);
    setProductCode(product.productCode ?? "");
    setCategory(product.category ?? "");
    setDescription(product.description ?? "");
    setNotes(product.notes ?? "");
    setProductUrl(product.productUrl ?? "");
  }, [product.id, product.name, product.productCode, product.category, product.description, product.notes, product.productUrl]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await updateSupplierProduct({
        id: product.id,
        name, productCode: productCode || null, category: category || null,
        description: description || null, notes: notes || null,
        productUrl: productUrl.trim() || null,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  }

  if (!editing) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid var(--lb-border)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {product.productCode && (
                <code style={{ background: "rgba(8,145,178,0.15)", color: "#0891b2", padding: "2px 8px", borderRadius: 5, fontSize: 11.5, fontWeight: 700 }}>
                  {product.productCode}
                </code>
              )}
              {product.category && (
                <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>{product.category}</span>
              )}
            </div>
            {product.description && (
              <p style={{ fontSize: 13, color: "var(--lb-text-2)", margin: "6px 0 0", lineHeight: 1.5 }}>{product.description}</p>
            )}
            {product.productUrl && (
              <a
                href={product.productUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={product.productUrl}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  marginTop: 8,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--lb-accent) 12%, transparent)",
                  border: "1px solid var(--lb-accent)",
                  color: "var(--lb-accent)",
                  textDecoration: "none",
                  fontSize: 12,
                  fontWeight: 700,
                  maxWidth: "100%",
                }}
              >
                <span>↗ Source</span>
                <span
                  style={{
                    color: "var(--lb-text-3)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 320,
                  }}
                >
                  {product.productUrl.replace(/^https?:\/\//, "")}
                </span>
              </a>
            )}
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={onToggleEdit} style={MINI_BTN}>Edit</button>
              <button type="button" onClick={onDelete} disabled={busy} style={{ ...MINI_BTN, color: "#dc2626", borderColor: "rgba(220,38,38,0.4)" }}>Delete</button>
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
          Added {fmtStamp(product.createdAt)}
          {product.createdByRole === "supplier" && <span> by supplier</span>}
          {product.updatedAt && new Date(product.updatedAt).getTime() !== new Date(product.createdAt).getTime() && (
            <span> · last updated {fmtStamp(product.updatedAt)}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid var(--lb-border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} />
        </Field>
        <Field label="Product code">
          <input value={productCode} onChange={(e) => setProductCode(e.target.value)} style={INPUT_STYLE} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={INPUT_STYLE}>
            <option value="">— none —</option>
            {SUPPLIER_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...INPUT_STYLE, minHeight: 60, resize: "vertical" }} />
      </Field>
      <Field label="Product URL">
        <input
          value={productUrl}
          onChange={(e) => setProductUrl(e.target.value)}
          placeholder="https://www.brand.com/products/..."
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Notes (internal)">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...INPUT_STYLE, minHeight: 50, resize: "vertical" }} />
      </Field>
      {err && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onToggleEdit} style={MINI_BTN}>Cancel</button>
        <button type="button" onClick={save} disabled={saving} style={{ ...PRIMARY_BTN, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function CategoryPanel({ productId, productThumbnailUrl, category, customCategoryLabel, attachments, canEdit, onChanged, onDeleteCustomSection }: {
  productId: number;
  productThumbnailUrl: string | null;
  // Either one of the fixed enum sections OR "other_file" when uploading
  // into a supplier-defined custom section (in which case the label is
  // carried in customCategoryLabel).
  category: SupplierProductAttachmentCategory | "other_file";
  customCategoryLabel: string | null;
  attachments: SupplierProductAttachment[];
  canEdit: boolean;
  onChanged: () => void;
  // Custom-only delete affordance. Provided by ProductDrawer; absent for
  // canonical sections, which are never deletable.
  onDeleteCustomSection?: (label: string) => void;
}) {
  // Pending comment typed BEFORE the file is picked — applies to the next
  // batch of files dropped in. Cleared once uploads finish. Per the brief,
  // images and "other files" need comments; here we let any category carry
  // an optional comment so the field is consistent across the six tabs.
  const [comment, setComment] = useState("");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true); setErr(null);
    const noteForBatch = comment.trim() || undefined;
    try {
      for (const file of Array.from(files)) {
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
        const pathname = `suppliers/${productId}/${category}/${crypto.randomUUID()}-${safe}`;
        const up = await upload(pathname, file, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: file.type || undefined,
        });
        await addSupplierProductAttachment({
          productId,
          category,
          customCategoryLabel: customCategoryLabel ?? undefined,
          name: file.name,
          url: up.url,
          blobPathname: up.pathname,
          contentType: file.type || undefined,
          size: file.size,
          notes: noteForBatch,
        });
      }
      setComment("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally { setUploading(false); }
  }

  async function onDelete(id: number) {
    if (!confirm("Delete this file? This can't be undone.")) return;
    try {
      await deleteSupplierProductAttachment({ id });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const isCustomSection = category === "other_file" && !!customCategoryLabel;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header for custom sections only — surfaces the section name */}
      {/* and a Delete button. Default sections show no header here */}
      {/* because their identity is already obvious from the rail tab. */}
      {isCustomSection && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0 2px 4px",
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--lb-text)" }}>
            {customCategoryLabel}
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "var(--lb-text-3)" }}>
              custom section
            </span>
          </div>
          {canEdit && onDeleteCustomSection && (
            <button
              type="button"
              onClick={() => onDeleteCustomSection(customCategoryLabel!)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                background: "transparent",
                border: "1px solid rgba(220,38,38,0.4)",
                color: "#dc2626",
                cursor: "pointer",
              }}
            >
              🗑 Delete section
            </button>
          )}
        </div>
      )}

      {canEdit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment for the next upload — applies to every file in this batch (e.g. revision, project, notes)"
            disabled={uploading}
            style={{ ...INPUT_STYLE, minHeight: 50, resize: "vertical" }}
          />
          <label style={{
            padding: 16,
            border: "1.5px dashed var(--lb-border)",
            borderRadius: 8,
            background: "var(--lb-bg)",
            display: "flex",
            gap: 8,
            alignItems: "center",
            justifyContent: "center",
            cursor: uploading ? "wait" : "pointer",
            color: "var(--lb-text-2)",
            fontSize: 13,
          }}>
            <input
              type="file"
              multiple
              disabled={uploading}
              onChange={(e) => onPickFiles(e.currentTarget.files)}
              style={{ display: "none" }}
            />
            {uploading ? "Uploading…" : "📎 Drop files or click to upload"}
          </label>
        </div>
      )}
      {err && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{err}</div>}

      {attachments.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--lb-text-3)", fontSize: 13, border: "1px dashed var(--lb-border)", borderRadius: 8 }}>
          No files in this category yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              canEdit={canEdit}
              productId={productId}
              isCover={productThumbnailUrl != null && productThumbnailUrl === a.url}
              onChanged={onChanged}
              onDelete={() => onDelete(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Single attachment row — supports inline edit of the comment AND of the
// file name. Image attachments show a larger thumbnail and a "Set as
// cover" / "Cover" indicator that drives the product card's hero image.
function AttachmentRow({ attachment, canEdit, productId, isCover, onChanged, onDelete }: {
  attachment: SupplierProductAttachment;
  canEdit: boolean;
  productId: number;
  isCover: boolean;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const a = attachment;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [notes, setNotes] = useState(a.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [settingCover, setSettingCover] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const isImg = isImage(a.contentType, a.name);

  async function onDownloadClick() {
    setDownloading(true);
    setErr(null);
    try {
      await forceDownloadFile(a.url, a.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  async function setAsCover() {
    setSettingCover(true); setErr(null);
    try {
      await updateSupplierProduct({
        id: productId,
        thumbnailUrl: a.url,
        thumbnailPathname: a.blobPathname ?? null,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to set cover");
    } finally { setSettingCover(false); }
  }

  useEffect(() => {
    setName(a.name);
    setNotes(a.notes ?? "");
  }, [a.id, a.name, a.notes]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await updateSupplierProductAttachment({
        id: a.id,
        name: name !== a.name ? name : undefined,
        notes: (notes || null) !== (a.notes ?? null) ? notes : undefined,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  }

  return (
    <div style={{
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
      padding: 12,
      border: "1px solid var(--lb-border)",
      borderRadius: 8,
      background: "var(--lb-bg-elev)",
    }}>
      {isImg ? (
        // Larger preview for product photos — click opens the preview
        // modal so the user gets the same controls (full preview +
        // download) as the file row.
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          style={{
            flexShrink: 0,
            display: "block",
            position: "relative",
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={a.url}
            alt={a.name}
            style={{
              width: 96,
              height: 96,
              objectFit: "cover",
              borderRadius: 6,
              border: isCover ? "2px solid var(--lb-accent)" : "1px solid var(--lb-border)",
              display: "block",
            }}
          />
          {isCover && (
            <span style={{
              position: "absolute",
              top: 4,
              left: 4,
              padding: "2px 7px",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              borderRadius: 4,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              pointerEvents: "none",
            }}>
              Cover
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          title="Preview"
          style={{
            width: 48,
            height: 48,
            borderRadius: 5,
            background: "var(--lb-bg)",
            display: "grid",
            placeItems: "center",
            border: "1px solid var(--lb-border)",
            flexShrink: 0,
            fontSize: 18,
            cursor: "pointer",
          }}
        >
          {fileIcon(a.name)}
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {editing ? (
          <>
            <Field label="File name">
              <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} />
            </Field>
            <Field label="Comment">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes, revision, project, anything that helps the buyer understand this file."
                style={{ ...INPUT_STYLE, minHeight: 60, resize: "vertical" }}
              />
            </Field>
            {err && <div style={{ color: "#dc2626", fontSize: 12 }}>{err}</div>}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 2 }}>
              <button type="button" onClick={() => { setEditing(false); setName(a.name); setNotes(a.notes ?? ""); setErr(null); }} style={MINI_BTN}>Cancel</button>
              <button type="button" onClick={save} disabled={saving} style={{ ...PRIMARY_BTN, padding: "4px 12px", fontSize: 12, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPreviewing(true)}
              title="Preview"
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: "var(--lb-text-1)",
                textDecoration: "none",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
                width: "100%",
                textAlign: "left",
              }}
            >
              {a.name}
            </button>
            <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
              Uploaded {fmtStamp(a.uploadedAt)}
              {a.uploadedByRole === "supplier" && <span> by supplier</span>}
              <span> · {fmtSize(a.size)}</span>
            </div>
            {a.notes && (
              <div style={{
                fontSize: 12.5,
                color: "var(--lb-text-2)",
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                borderLeft: "3px solid var(--lb-accent)",
                borderRadius: 4,
                padding: "6px 10px",
                marginTop: 4,
                whiteSpace: "pre-wrap",
              }}>
                {a.notes}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setPreviewing(true)}
                style={{ ...MINI_BTN, fontSize: 11.5 }}
              >
                👁 Preview
              </button>
              <button
                type="button"
                onClick={onDownloadClick}
                disabled={downloading}
                style={{
                  ...MINI_BTN,
                  fontSize: 11.5,
                  opacity: downloading ? 0.6 : 1,
                  cursor: downloading ? "wait" : "pointer",
                }}
              >
                {downloading ? "Downloading…" : "⬇ Download"}
              </button>
            </div>
          </>
        )}
      </div>
      {canEdit && !editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {isImg && !isCover && (
            <button
              type="button"
              onClick={setAsCover}
              disabled={settingCover}
              title="Use this photo as the product card cover"
              style={{ ...MINI_BTN, color: "var(--lb-accent)", borderColor: "var(--lb-accent)", opacity: settingCover ? 0.6 : 1 }}
            >
              {settingCover ? "Setting…" : "Set as cover"}
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)} style={MINI_BTN}>Edit</button>
          <button type="button" onClick={onDelete} style={{ ...MINI_BTN, color: "#dc2626", borderColor: "rgba(220,38,38,0.4)" }}>Delete</button>
          {err && <div style={{ color: "#dc2626", fontSize: 11 }}>{err}</div>}
        </div>
      )}

      {previewing && (
        <FileViewerModal
          url={a.url}
          name={a.name}
          mimeType={a.contentType}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>
  );
}
function isImage(contentType: string | null, name: string): boolean {
  if (contentType?.startsWith("image/")) return true;
  return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name);
}
function fileIcon(name: string): string {
  if (/\.pdf$/i.test(name)) return "📄";
  if (/\.(xlsx?|csv|tsv)$/i.test(name)) return "📊";
  if (/\.(docx?|rtf)$/i.test(name)) return "📝";
  if (/\.(zip|rar|7z)$/i.test(name)) return "🗜️";
  return "📎";
}

// ─────────────────────────────────────────────────────────────────────────────
// Shells
// ─────────────────────────────────────────────────────────────────────────────

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100,
      display: "grid", placeItems: "center", padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderRadius: 12,
        width: "100%",
        maxWidth: 560,
        boxShadow: "0 12px 48px rgba(0,0,0,0.4)",
      }} onClick={(e) => e.stopPropagation()}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid var(--lb-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{title}</h3>
          <button type="button" onClick={onClose} style={{ ...MINI_BTN, padding: "2px 8px" }}>✕</button>
        </header>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

function DrawerShell({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100,
      display: "flex", justifyContent: "flex-end",
    }} onClick={onClose}>
      <div style={{
        background: "var(--lb-bg)",
        borderLeft: "1px solid var(--lb-border)",
        width: "100%",
        maxWidth: 720,
        boxShadow: "-12px 0 48px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }} onClick={(e) => e.stopPropagation()}>
        <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--lb-border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "sticky", top: 0, background: "var(--lb-bg)", zIndex: 1 }}>
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>{title}</h3>
            {subtitle && <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} style={{ ...MINI_BTN, padding: "4px 10px" }}>✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: "0.02em" }}>{label}</span>
      {children}
    </label>
  );
}
