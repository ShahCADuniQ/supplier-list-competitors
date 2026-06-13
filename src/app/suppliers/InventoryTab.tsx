"use client";

// Inventory tab — list every part keyed by its Lightbase Ref. Click into
// one to see the full order history (every RFQ, every quote received from
// every supplier, every PO ever issued) for THAT part.
//
// The list is loaded lazily on mount and refreshed after every mutation
// (edit / archive). The detail view is loaded on demand when the user
// clicks a row.

import { useEffect, useMemo, useState } from "react";
import {
  deleteInventoryItem,
  listInventoryItems,
  type InventoryItemWithStats,
} from "./inventory-actions";
import {
  getProductInventoryTreeAction,
  type InventoryItemClass,
  type ProductTreeNode,
} from "@/app/design-engineering/nomenclature/actions";
import InventoryDrawer from "@/app/design-engineering/nomenclature/InventoryDrawer";
import PanZoomViewport from "@/app/design-engineering/nomenclature/PanZoomViewport";

// V106 — five catalogue classes that drive the Inventory tab pills.
// Plus a Tree pseudo-tab that appears only when a specific product
// is selected (rendered as a starred-only graph on the far RHS).
type CatalogueTab =
  | "parts"
  | "assemblies"
  | "hardware"
  | "electronics"
  | "adhesive_sealant_filler"
  | "tree";

const TAB_LABEL: Record<Exclude<CatalogueTab, "tree">, { label: string; emoji: string; class: InventoryItemClass }> = {
  parts: { label: "Parts", emoji: "🔧", class: "part" },
  assemblies: { label: "Assemblies", emoji: "🧩", class: "assembly" },
  hardware: { label: "Hardware", emoji: "🔩", class: "hardware" },
  electronics: { label: "Electronics", emoji: "💡", class: "electronics" },
  adhesive_sealant_filler: {
    label: "Adhesive / Sealants / Fillers",
    emoji: "🧪",
    class: "adhesive_sealant_filler",
  },
};

// Resolve the effective class for a row — explicit itemClass wins,
// else fall back to the BOM kind so legacy rows still bucket.
function effectiveClass(i: InventoryItemWithStats): InventoryItemClass {
  const explicit = (i as { itemClass?: string | null }).itemClass;
  if (
    explicit === "part" ||
    explicit === "assembly" ||
    explicit === "hardware" ||
    explicit === "electronics" ||
    explicit === "adhesive_sealant_filler"
  ) {
    return explicit;
  }
  return i.kind === "assembly" ? "assembly" : "part";
}

export default function InventoryTab({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<InventoryItemWithStats[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const reload = () => {
    setLoading(true);
    listInventoryItems()
      .then(setItems)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (items !== null) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-card navigation: when the user clicks a child-part card inside
  // the assembly detail drawer, we fire a window event so this top-level
  // component can pop open the new id. Avoids prop-drilling across the
  // drawer / table.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent<{ id: number }>).detail;
      if (detail?.id) setOpenId(detail.id);
    }
    window.addEventListener("lb:open-inventory", open);
    return () => window.removeEventListener("lb:open-inventory", open);
  }, []);

  // V106 — five catalogue tabs + a Tree pseudo-tab that appears only
  // when a specific product is selected. Each non-Tree tab filters
  // the table by effectiveClass(row).
  const [view, setView] = useState<CatalogueTab>("parts");
  // Product / line filter. "__all__" shows every product, "__none__"
  // shows only items with no product set, anything else filters to
  // exact-match. Product labels are extracted from the loaded items
  // and remembered automatically — once an item carries a label, it
  // appears in this dropdown for everyone.
  const [productFilter, setProductFilter] = useState<string>("__all__");
  // Starred filter. Defaults to on so the tab shows only the curated
  // "shows up in Lightbase Inventory" rows — that's parts/hardware by
  // default plus any assembly the user has explicitly opted in via the
  // star button on the Database tab card. Toggling Show all reveals
  // everything for diagnostic / cleanup tasks.
  const [showAll, setShowAll] = useState(false);

  // Normalise products field for each row. Handles both the legacy
  // scalar `product` column and the V92 `products` jsonb array.
  function rowProducts(i: InventoryItemWithStats): string[] {
    const arr = (i as { products?: unknown }).products;
    if (Array.isArray(arr) && arr.length > 0) {
      return (arr as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
    }
    const scalar = (i.product ?? "").trim();
    return scalar ? [scalar] : [];
  }

  const productOptions = useMemo(() => {
    const set = new Set<string>();
    let hasNone = false;
    for (const i of items ?? []) {
      const ps = rowProducts(i);
      if (ps.length === 0) hasNone = true;
      else for (const p of ps) set.add(p);
    }
    return {
      products: Array.from(set).sort((a, b) => a.localeCompare(b)),
      hasNone,
    };
  }, [items]);

  const filtered = useMemo(() => {
    if (view === "tree") return [];
    const q = search.trim().toLowerCase();
    const list = items ?? [];
    const byStar = showAll ? list : list.filter((i) => i.starred);
    const wantClass = TAB_LABEL[view].class;
    const byKind = byStar.filter((i) => effectiveClass(i) === wantClass);
    const byProduct = byKind.filter((i) => {
      if (productFilter === "__all__") return true;
      const ps = rowProducts(i);
      if (productFilter === "__none__") return ps.length === 0;
      return ps.includes(productFilter);
    });
    if (!q) return byProduct;
    return byProduct.filter((i) => {
      const ps = rowProducts(i).join(" ");
      return `${i.code} ${i.name ?? ""} ${i.description ?? ""} ${i.category ?? ""} ${i.material ?? ""} ${ps}`
        .toLowerCase()
        .includes(q);
    });
  }, [items, search, view, productFilter, showAll]);
  // V124 — tab counts respect BOTH the starred filter AND the active
  // product filter so the Parts/Assemblies/Hardware/… pills only
  // reflect the rows the user will actually see. Pre-V124 the counts
  // were across every starred row in the database, which made the
  // pills disagree with the Tree tab for a product-scoped view.
  const visibleByStar = (items ?? []).filter((i) => {
    if (!showAll && !i.starred) return false;
    if (productFilter === "__all__") return true;
    const ps = rowProducts(i);
    if (productFilter === "__none__") return ps.length === 0;
    return ps.includes(productFilter);
  });
  const classCounts: Record<Exclude<CatalogueTab, "tree">, number> = {
    parts: 0,
    assemblies: 0,
    hardware: 0,
    electronics: 0,
    adhesive_sealant_filler: 0,
  };
  for (const i of visibleByStar) {
    const c = effectiveClass(i);
    if (c === "part") classCounts.parts++;
    else if (c === "assembly") classCounts.assemblies++;
    else if (c === "hardware") classCounts.hardware++;
    else if (c === "electronics") classCounts.electronics++;
    else if (c === "adhesive_sealant_filler") classCounts.adhesive_sealant_filler++;
  }
  // Show-all hint also scoped to the current product so the "(+N
  // hidden)" tally reports unstarred rows for THIS product only.
  const hiddenByStarCount = (items ?? []).filter((i) => {
    if (i.starred) return false;
    if (productFilter === "__all__") return true;
    const ps = rowProducts(i);
    if (productFilter === "__none__") return ps.length === 0;
    return ps.includes(productFilter);
  }).length;
  // Tree tab is only meaningful when the user has narrowed to one
  // specific product. Hide the pill otherwise; if the user had it
  // selected and switches the filter back to __all__, snap them to
  // Parts so the table reappears.
  const treeAvailable =
    productFilter !== "__all__" && productFilter !== "__none__";
  useEffect(() => {
    if (!treeAvailable && view === "tree") setView("parts");
  }, [treeAvailable, view]);

  return (
    <div style={{ padding: 24, background: "var(--lb-bg)", minHeight: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "clamp(22px, 2.6vw, 28px)", fontWeight: 800, letterSpacing: "-0.02em", margin: 0 }}>
            Inventory
          </h1>
          <p style={{ fontSize: 13, color: "var(--lb-text-2)", margin: "6px 0 0", maxWidth: 720 }}>
            Every part keyed by its <strong>Lightbase Ref.</strong> Click a row to see every RFQ, quote, and PO ever issued for that part across every supplier. New parts are auto-created when a buyer leaves the Lightbase Ref. blank on an RFQ line.
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "↻ Refreshing…" : "↻ Refresh"}
        </button>
      </header>

      {err && (
        <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,0.12)", color: "#fca5a5", fontSize: 13 }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: 4,
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            flexWrap: "wrap",
          }}
        >
          {(Object.keys(TAB_LABEL) as Array<Exclude<CatalogueTab, "tree">>).map(
            (key) => {
              const meta = TAB_LABEL[key];
              const active = view === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    background: active ? "var(--lb-accent)" : "transparent",
                    color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                    border: 0,
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {meta.emoji} {meta.label} ({classCounts[key]})
                </button>
              );
            },
          )}
          {treeAvailable && (
            <button
              type="button"
              onClick={() => setView("tree")}
              title={`Starred-only tree of every Lightbase Inventory item in ${productFilter}`}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                background: view === "tree" ? "#7c3aed" : "transparent",
                color: view === "tree" ? "#fff" : "#7c3aed",
                border: view === "tree" ? 0 : "1px dashed #7c3aed",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              🌳 Tree
            </button>
          )}
        </div>
        <select
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
          aria-label="Product / line"
          style={{
            padding: "10px 14px",
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13,
            minWidth: 200,
            cursor: "pointer",
          }}
        >
          <option value="__all__">All products ({items?.length ?? 0})</option>
          {productOptions.hasNone && (
            <option value="__none__">No product set</option>
          )}
          {productOptions.products.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search by Lightbase Ref., name, material, category…`}
          style={{
            flex: 1,
            minWidth: 220,
            padding: "10px 14px",
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13,
          }}
        />
        <label
          title={
            showAll
              ? "Showing every inventory row, including assemblies that aren't starred"
              : "Only showing items starred for Lightbase Inventory. Hidden: " +
                hiddenByStarCount
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Show all{hiddenByStarCount > 0 && !showAll ? ` (+${hiddenByStarCount} hidden)` : ""}
        </label>
      </div>

      {view === "tree" ? (
        <ProductTreeView
          product={productFilter}
          onOpenItem={(id) => setOpenId(id)}
        />
      ) : (
      <section
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 12,
          padding: 12,
        }}
      >
        {!items ? (
          <Empty>Loading…</Empty>
        ) : items.length === 0 ? (
          <Empty>
            No parts yet. Create an RFQ — every line item auto-mints a Lightbase Ref.
            and a matching part here.
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty>No parts match the current search.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <Th />
                  <Th>Lightbase Ref.</Th>
                  <Th>Name</Th>
                  <Th>Material</Th>
                  <Th style={{ textAlign: "right" }}>Qty status</Th>
                  <Th style={{ textAlign: "right" }}>RFQs / POs</Th>
                  <Th>Last activity</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr
                    key={it.id}
                    style={{ borderTop: "1px solid var(--lb-border)", cursor: "pointer" }}
                    onClick={() => setOpenId(it.id)}
                  >
                    <Td style={{ padding: "8px 10px", width: 60 }}>
                      {it.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={it.thumbnailUrl}
                          alt={it.name ?? it.code}
                          style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid var(--lb-border)", display: "block" }}
                        />
                      ) : (
                        <div style={{ width: 44, height: 44, borderRadius: 6, background: "var(--lb-bg)", border: "1px dashed var(--lb-border)", display: "grid", placeItems: "center", color: "var(--lb-text-3)", fontSize: 16 }}>
                          {it.kind === "assembly" ? "🧩" : "🔧"}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <code
                        style={{
                          background: "rgba(8,145,178,0.15)",
                          color: "#0891b2",
                          padding: "2px 8px",
                          borderRadius: 5,
                          fontSize: 11.5,
                          fontWeight: 700,
                          letterSpacing: 0.4,
                        }}
                      >
                        {it.code}
                      </code>
                    </Td>
                    <Td>
                      <div style={{ fontWeight: 600 }}>{it.name ?? "—"}</div>
                      {it.description && (
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 2 }}>
                          {it.description.slice(0, 60)}
                          {it.description.length > 60 ? "…" : ""}
                        </div>
                      )}
                    </Td>
                    <Td style={{ color: "var(--lb-text-2)", fontSize: 12 }}>{it.material ?? "—"}</Td>
                    <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>
                      <div>
                        <span style={{ color: "#ca8a04", fontWeight: 700 }}>{it.pendingQty}</span>
                        <span style={{ color: "var(--lb-text-3)" }}> on standby</span>
                      </div>
                      <div>
                        <span style={{ color: "#16a34a", fontWeight: 700 }}>{it.confirmedQty}</span>
                        <span style={{ color: "var(--lb-text-3)" }}> confirmed</span>
                      </div>
                    </Td>
                    <Td style={{ textAlign: "right", color: "var(--lb-text-3)", fontVariantNumeric: "tabular-nums" }}>
                      {it.rfqCount} / {it.poCount}
                    </Td>
                    <Td style={{ color: "var(--lb-text-3)", fontSize: 11.5 }}>
                      {it.lastActivityAt ? new Date(it.lastActivityAt).toLocaleDateString() : "—"}
                    </Td>
                    <Td style={{ textAlign: "right" }}>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {canEdit && (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const isAssembly = it.kind === "assembly";
                              const noun = isAssembly ? "assembly" : "part";
                              if (
                                !window.confirm(
                                  `Delete ${noun} ${it.code}? This is permanent. ` +
                                    (isAssembly
                                      ? "Its child parts will be orphaned (kept in the list, no parent assembly)."
                                      : "Historical RFQ / PO rows that linked here will still exist but lose the inventory link."),
                                )
                              )
                                return;
                              let deleteChildren = false;
                              if (isAssembly) {
                                deleteChildren = window.confirm(
                                  "Also delete every child part of this assembly?\n\n" +
                                    "OK = delete children too\n" +
                                    "Cancel = orphan them (keep the children)",
                                );
                              }
                              try {
                                await deleteInventoryItem({
                                  itemId: it.id,
                                  deleteChildren,
                                });
                                reload();
                              } catch (err) {
                                window.alert(
                                  err instanceof Error
                                    ? err.message
                                    : "Delete failed",
                                );
                              }
                            }}
                            style={{
                              padding: "3px 9px",
                              fontSize: 11.5,
                              fontWeight: 700,
                              borderRadius: 999,
                              border: "1px solid rgba(220,38,38,0.4)",
                              background: "transparent",
                              color: "#dc2626",
                              cursor: "pointer",
                            }}
                            title={`Delete this ${
                              it.kind === "assembly" ? "assembly" : "part"
                            } permanently`}
                          >
                            🗑 Delete
                          </button>
                        )}
                        <span style={{ color: "var(--lb-text-3)" }}>›</span>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {openId != null && (
        <InventoryDrawer
          inventoryItemId={openId}
          onClose={() => {
            setOpenId(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

// V106 — Tree view that lives on the far RHS when a specific product
// is selected. Renders the starred-only assembly graph for that
// product so the team can see how every Lightbase Inventory item
// connects, at a glance. Each card is clickable to open the unified
// drawer for that item.
function ProductTreeView({
  product,
  onOpenItem,
}: {
  product: string;
  onOpenItem: (inventoryItemId: number) => void;
}) {
  const [tree, setTree] = useState<ProductTreeNode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setErr(null);
    getProductInventoryTreeAction({ product })
      .then((rows) => {
        if (!cancelled) setTree(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Tree load failed");
          setTree([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [product]);

  return (
    <section
      style={{
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      {/* Connector-line CSS, mirrors the .lb-tree pattern used on the
          Database tab so the Inventory tree looks visually identical
          to the nomenclature page tree. Scoped via .lb-inv-tree so
          it can't leak into other parts of /suppliers. */}
      <style>{`
        .lb-inv-tree { display: flex; flex-direction: column; align-items: center; }
        .lb-inv-tree-children {
          display: flex;
          flex-wrap: nowrap;
          justify-content: center;
          gap: 24px;
          position: relative;
          padding-top: 28px;
          margin-top: 0;
        }
        .lb-inv-tree-children::before {
          content: "";
          position: absolute;
          top: 0;
          left: 50%;
          width: 2px;
          height: 14px;
          background: var(--lb-border);
          transform: translateX(-50%);
        }
        .lb-inv-tree-children::after {
          content: "";
          position: absolute;
          top: 14px;
          left: 24px;
          right: 24px;
          height: 2px;
          background: var(--lb-border);
        }
        .lb-inv-tree-children.lb-inv-tree-single::after { display: none; }
        .lb-inv-tree-child {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .lb-inv-tree-child::before {
          content: "";
          position: absolute;
          top: -14px;
          left: 50%;
          width: 2px;
          height: 14px;
          background: var(--lb-border);
          transform: translateX(-50%);
        }
        /* Vertical line between sibling roots so the forest still
           reads as a connected whole when there are multiple roots. */
        .lb-inv-roots {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
        }
      `}</style>

      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
            🌳 {product} — starred inventory tree
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--lb-text-3)" }}>
            Filtered to starred Parts, Assemblies, Hardware, Electronics
            and Adhesive / Sealants / Fillers. Click any card to open
            it.
          </p>
        </header>
        {err && (
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              background: "rgba(220,38,38,0.12)",
              color: "#fca5a5",
              fontSize: 12.5,
            }}
          >
            {err}
          </div>
        )}
        {tree === null ? (
          <Empty>Loading tree…</Empty>
        ) : tree.length === 0 ? (
          <Empty>
            No starred items for <strong>{product}</strong> yet. Star a
            few Lightbase Inventory rows tagged with this product and
            they&apos;ll show up here.
          </Empty>
        ) : (
          <PanZoomViewport>
            <div
              style={{
                padding: "12px 16px 16px",
                display: "inline-block",
              }}
            >
              <div className="lb-inv-roots" style={{ minWidth: "fit-content" }}>
                {tree.map((root) => (
                  <div key={root.inventoryItemId} className="lb-inv-tree">
                    <ProductTreeNodeCard
                      node={root}
                      root
                      onOpenItem={onOpenItem}
                    />
                  </div>
                ))}
              </div>
            </div>
          </PanZoomViewport>
        )}
      </div>
    </section>
  );
}

const TREE_CLASS_LABEL: Record<ProductTreeNode["itemClass"], { label: string; tone: string }> = {
  part: { label: "Part", tone: "#0891b2" },
  assembly: { label: "Assembly", tone: "#7c3aed" },
  hardware: { label: "Hardware", tone: "#475569" },
  electronics: { label: "Electronics", tone: "#16a34a" },
  adhesive_sealant_filler: { label: "Adhesive/Sealant", tone: "#d97706" },
};

// Single tree node card + its descendants. Mirrors the nomenclature
// page's TreeNodeCard layout: vertical drop line, horizontal sibling
// bar, then each child below. Clicking the card body fires onOpenItem
// so the unified InventoryDrawer pops open for that row.
function ProductTreeNodeCard({
  node,
  root,
  onOpenItem,
}: {
  node: ProductTreeNode;
  root?: boolean;
  onOpenItem: (inventoryItemId: number) => void;
}) {
  const meta = TREE_CLASS_LABEL[node.itemClass] ?? TREE_CLASS_LABEL.part;
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenItem(node.inventoryItemId)}
        title="Click to open details"
        style={{
          width: 240,
          textAlign: "left",
          padding: 12,
          borderRadius: 12,
          border: root
            ? `2px solid ${meta.tone}`
            : `1px solid ${meta.tone}55`,
          background: root
            ? `color-mix(in srgb, ${meta.tone} 8%, var(--lb-bg))`
            : `color-mix(in srgb, ${meta.tone} 4%, var(--lb-bg))`,
          color: "var(--lb-text)",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          boxShadow: root
            ? `0 4px 14px -8px ${meta.tone}66`
            : "none",
          transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "translateY(-1px)";
          e.currentTarget.style.boxShadow = `0 8px 18px -10px ${meta.tone}80`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = root
            ? `0 4px 14px -8px ${meta.tone}66`
            : "none";
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 800,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                padding: "1px 7px",
                borderRadius: 999,
                background: `${meta.tone}22`,
                color: meta.tone,
                whiteSpace: "nowrap",
              }}
            >
              {meta.label}
            </span>
            <code style={{ fontSize: 11, fontWeight: 800, wordBreak: "break-all", minWidth: 0 }}>
              {node.code}
            </code>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {node.isConfiguration && (
              <span
                style={{
                  fontSize: 8.5,
                  fontWeight: 800,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--lb-accent) 16%, transparent)",
                  color: "var(--lb-accent)",
                }}
              >
                CFG
              </span>
            )}
            {!root && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "1px 7px",
                  borderRadius: 999,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text-2)",
                  whiteSpace: "nowrap",
                }}
              >
                × {node.quantity}
              </span>
            )}
          </div>
        </div>
        {node.name && (
          <div style={{ fontSize: 11, color: "var(--lb-text-2)" }}>
            {node.name}
          </div>
        )}
      </button>

      {node.children.length > 0 && (
        <div
          className={`lb-inv-tree-children${node.children.length === 1 ? " lb-inv-tree-single" : ""}`}
        >
          {node.children.map((c) => (
            <div className="lb-inv-tree-child" key={c.inventoryItemId}>
              <ProductTreeNodeCard
                node={c}
                onOpenItem={onOpenItem}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty / Th / Td shared by the table above. The detail panel itself
// is now the unified InventoryDrawer imported from the nomenclature
// page — Edit, Archive, Quote history, PO history, attachments, the
// BOM Tree tab, etc. all live there.

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, borderRadius: 10, border: "1px dashed var(--lb-border)", textAlign: "center", color: "var(--lb-text-3)", fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 10px",
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: "var(--lb-text-3)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{ padding: "10px 10px", verticalAlign: "top", color: "var(--lb-text)", ...style }}>
      {children}
    </td>
  );
}

