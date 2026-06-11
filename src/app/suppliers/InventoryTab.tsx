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
import InventoryDrawer from "@/app/design-engineering/nomenclature/InventoryDrawer";

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

  // View toggle — "parts" or "assemblies". Parts excludes assemblies +
  // assemblies excludes parts. Both sections show standalone parts that
  // don't have a parent.
  const [view, setView] = useState<"assemblies" | "parts">("parts");
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
    const q = search.trim().toLowerCase();
    const list = items ?? [];
    const byStar = showAll ? list : list.filter((i) => i.starred);
    const byKind = byStar.filter(
      (i) => i.kind === (view === "assemblies" ? "assembly" : "part"),
    );
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
  // Counts respect the starred filter so the tab pills reflect what
  // the user will actually see when they click through. Toggling Show
  // all switches both pills to the full population.
  const visibleByStar = (items ?? []).filter((i) => showAll || i.starred);
  const partsCount = visibleByStar.filter((i) => i.kind !== "assembly").length;
  const assembliesCount = visibleByStar.filter((i) => i.kind === "assembly").length;
  const hiddenByStarCount = (items ?? []).filter((i) => !i.starred).length;

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
        <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 999, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)" }}>
          <button
            type="button"
            onClick={() => setView("parts")}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: view === "parts" ? "var(--lb-accent)" : "transparent",
              color: view === "parts" ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
              border: 0,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            🔧 Parts ({partsCount})
          </button>
          <button
            type="button"
            onClick={() => setView("assemblies")}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: view === "assemblies" ? "var(--lb-accent)" : "transparent",
              color: view === "assemblies" ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
              border: 0,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            🧩 Assemblies ({assembliesCount})
          </button>
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

