"use client";

// Inventory tab — list every part keyed by its Lightbase Ref. Click into
// one to see the full order history (every RFQ, every quote received from
// every supplier, every PO ever issued) for THAT part.
//
// The list is loaded lazily on mount and refreshed after every mutation
// (edit / archive). The detail view is loaded on demand when the user
// clicks a row.

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  archiveInventoryItem,
  deleteInventoryItem,
  getInventoryItemHistory,
  listInventoryItems,
  updateInventoryItem,
  type InventoryItemHistory,
  type InventoryItemWithStats,
} from "./inventory-actions";

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
    const byKind = list.filter(
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
  }, [items, search, view, productFilter]);
  const partsCount = (items ?? []).filter((i) => i.kind !== "assembly").length;
  const assembliesCount = (items ?? []).filter((i) => i.kind === "assembly").length;

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
        <InventoryDetailDrawer
          itemId={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function InventoryDetailDrawer({
  itemId,
  canEdit,
  onClose,
  onChanged,
}: {
  itemId: number;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<InventoryItemHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [catDraft, setCatDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getInventoryItemHistory(itemId)
      .then((d) => {
        setData(d);
        if (d) {
          setNameDraft(d.item.name ?? "");
          setDescDraft(d.item.description ?? "");
          setCatDraft(d.item.category ?? "");
          setNotesDraft(d.item.notes ?? "");
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [itemId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function save() {
    startTransition(async () => {
      try {
        await updateInventoryItem({
          itemId,
          name: nameDraft,
          description: descDraft,
          category: catDraft,
          notes: notesDraft,
        });
        setEditing(false);
        onChanged();
        // Re-pull the detail so the displayed fields update.
        const d = await getInventoryItemHistory(itemId);
        setData(d);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function archive() {
    if (!confirm("Archive this part? The Lightbase Ref. stays bound to existing RFQs / POs, but it stops showing in the inventory list.")) return;
    startTransition(async () => {
      try {
        await archiveInventoryItem({ itemId, archived: true });
        onChanged();
        onClose();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Archive failed");
      }
    });
  }

  return (
    <>
      <div className="panel-overlay show" onClick={onClose} />
      <div
        className="panel show"
        style={{ width: 760, maxWidth: "97vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          {data?.item.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.item.thumbnailUrl}
              alt={data.item.name ?? data.item.code}
              style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--lb-border)" }}
            />
          )}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            {data && (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <code
                    style={{
                      background: "rgba(8,145,178,0.15)",
                      color: "#0891b2",
                      padding: "3px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {data.item.code}
                  </code>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: data.item.kind === "assembly" ? "rgba(124,58,237,0.18)" : "rgba(8,145,178,0.18)",
                      color: data.item.kind === "assembly" ? "#a78bfa" : "#0891b2",
                    }}
                  >
                    {data.item.kind === "assembly" ? "🧩 Assembly" : "🔧 Part"}
                  </span>
                </div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                  {data.item.name ?? data.item.code}
                </h2>
              </>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 22 }} aria-label="Close">×</button>
        </div>
        <div className="panel-body" style={{ padding: "16px 22px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          {err && (
            <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,0.12)", color: "#fca5a5", fontSize: 13 }}>
              {err}
            </div>
          )}
          {loading || !data ? (
            <Empty>{loading ? "Loading…" : "Part not found"}</Empty>
          ) : (
            <>
              {/* Editable fields */}
              <section style={panelStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <h3 style={panelH3}>Part details</h3>
                  {canEdit && (
                    <div style={{ display: "flex", gap: 6 }}>
                      {editing ? (
                        <>
                          <button type="button" onClick={save} style={miniBtn("#16a34a")}>✓ Save</button>
                          <button type="button" onClick={() => setEditing(false)} style={miniBtn("#475569")}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => setEditing(true)} style={miniBtn("#7c3aed")}>✎ Edit</button>
                          <button type="button" onClick={archive} style={miniBtn("#dc2626")}>Archive</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {editing ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                    <FieldRow label="Name">
                      <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} style={inputStyle} />
                    </FieldRow>
                    <FieldRow label="Category">
                      <input value={catDraft} onChange={(e) => setCatDraft(e.target.value)} style={inputStyle} />
                    </FieldRow>
                    <FieldRow label="Description" wide>
                      <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} style={{ ...inputStyle, minHeight: 60, fontFamily: "inherit" }} />
                    </FieldRow>
                    <FieldRow label="Notes" wide>
                      <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} style={{ ...inputStyle, minHeight: 60, fontFamily: "inherit" }} />
                    </FieldRow>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                    <FieldRow label="Name">{data.item.name ?? "—"}</FieldRow>
                    <FieldRow label="Category">{data.item.category ?? "—"}</FieldRow>
                    <FieldRow label="Unit">{data.item.unit}</FieldRow>
                    {data.item.description && (
                      <FieldRow label="Description" wide>
                        <span style={{ whiteSpace: "pre-wrap" }}>{data.item.description}</span>
                      </FieldRow>
                    )}
                    {data.item.notes && (
                      <FieldRow label="Notes" wide>
                        <span style={{ whiteSpace: "pre-wrap" }}>{data.item.notes}</span>
                      </FieldRow>
                    )}
                  </div>
                )}
              </section>

              {/* IFC-extracted physical properties + qty status. */}
              <section style={panelStyle}>
                <h3 style={panelH3}>Physical properties (from IFC)</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 8 }}>
                  <Stat label="Weight" value={data.item.weightG != null ? `${Number(data.item.weightG).toFixed(2)} g` : "—"} />
                  <Stat label="Surface area" value={data.item.surfaceAreaMm2 != null ? `${Number(data.item.surfaceAreaMm2).toFixed(2)} mm²` : "—"} />
                  <Stat label="Volume" value={data.item.volumeMm3 != null ? `${Number(data.item.volumeMm3).toFixed(2)} mm³` : "—"} />
                  <Stat label="Material" value={data.item.material ?? "—"} />
                  <Stat label="Density" value={data.item.densityGCm3 != null ? `${Number(data.item.densityGCm3).toFixed(3)} g/cm³` : "—"} />
                </div>
                <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(202,138,4,0.08)", border: "1px solid rgba(202,138,4,0.35)", fontSize: 12 }}>
                  <strong style={{ color: "#ca8a04" }}>{data.item.pendingQty}</strong>
                  <span style={{ color: "var(--lb-text-2)" }}> on standby</span>
                  <span style={{ color: "var(--lb-text-3)" }}> · </span>
                  <strong style={{ color: "#16a34a" }}>{data.item.confirmedQty}</strong>
                  <span style={{ color: "var(--lb-text-2)" }}> confirmed</span>
                  <div style={{ fontSize: 10.5, color: "var(--lb-text-3)", marginTop: 4 }}>
                    Standby = total qty requested via open RFQs / quotes. Confirmed = total qty on POs that have been sent.
                  </div>
                </div>
                {data.item.ifcSourceUrl && (
                  <div style={{ marginTop: 8, fontSize: 11.5 }}>
                    <a href={data.item.ifcSourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lb-accent)" }}>
                      📐 Download source IFC{data.item.ifcSourceName ? ` · ${data.item.ifcSourceName}` : ""}
                    </a>
                  </div>
                )}
              </section>

              {/* Child parts — only on assemblies. Rendered as clickable cards. */}
              {data.item.kind === "assembly" && (
                <section style={panelStyle}>
                  <h3 style={panelH3}>Linked parts ({data.children.length})</h3>
                  {data.children.length === 0 ? (
                    <Empty>This assembly has no linked parts yet.</Empty>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 8 }}>
                      {data.children.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          // Drilling INTO a child swaps the drawer's open id —
                          // close current and re-open with the child.
                          onClick={() => { onClose(); setTimeout(() => onChanged(), 0); window.dispatchEvent(new CustomEvent("lb:open-inventory", { detail: { id: c.id } })); }}
                          style={{
                            padding: 10,
                            borderRadius: 10,
                            background: "var(--lb-bg)",
                            border: "1px solid var(--lb-border)",
                            color: "var(--lb-text)",
                            textAlign: "left",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {c.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.thumbnailUrl} alt={c.name ?? c.code} style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: 6, background: "var(--lb-bg-elev)" }} />
                          ) : (
                            <div style={{ width: "100%", aspectRatio: "1/1", borderRadius: 6, background: "var(--lb-bg-elev)", display: "grid", placeItems: "center", color: "var(--lb-text-3)", fontSize: 28 }}>🔧</div>
                          )}
                          <code style={{ fontSize: 10.5, color: "#0891b2", background: "rgba(8,145,178,0.15)", padding: "1px 6px", borderRadius: 4, fontWeight: 700, alignSelf: "flex-start" }}>
                            {c.code}
                          </code>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{c.name ?? "—"}</div>
                          {c.material && (
                            <div style={{ fontSize: 10.5, color: "var(--lb-text-3)" }}>{c.material}</div>
                          )}
                          <div style={{ fontSize: 10.5, color: "var(--lb-text-3)" }}>
                            <strong style={{ color: "#ca8a04" }}>{c.pendingQty}</strong> standby · <strong style={{ color: "#16a34a" }}>{c.confirmedQty}</strong> confirmed
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* Quote history — per supplier per RFQ */}
              <section style={panelStyle}>
                <h3 style={panelH3}>Quote history ({data.rfqs.reduce((n, r) => n + r.quoteLines.length, 0)})</h3>
                {data.rfqs.length === 0 ? (
                  <Empty>No RFQs yet for this part.</Empty>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    {data.rfqs.map(({ rfq, line, quoteLines }) => (
                      <li
                        key={rfq.id}
                        style={{ padding: 10, borderRadius: 8, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <a
                            href={`/suppliers/rfq/${rfq.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--lb-accent)", textDecoration: "none", fontWeight: 700, fontSize: 13 }}
                          >
                            {rfq.rfqNumber}
                          </a>
                          <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
                            · {rfq.projectName ?? rfq.projectNum}
                            · qty {line.qty}{line.securityStock > 0 ? ` (+${line.securityStock} sec)` : ""}
                            · {new Date(rfq.createdAt).toLocaleDateString()}
                          </span>
                          <span
                            style={{
                              marginLeft: "auto",
                              fontSize: 10.5,
                              padding: "2px 8px",
                              borderRadius: 5,
                              background: `${rfqStatusColor(rfq.status)}22`,
                              color: rfqStatusColor(rfq.status),
                              fontWeight: 800,
                              letterSpacing: 0.4,
                              textTransform: "uppercase",
                            }}
                          >
                            {rfq.status}
                          </span>
                        </div>
                        {quoteLines.length === 0 ? (
                          <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 6 }}>
                            No quotes received yet.
                          </div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
                            <thead>
                              <tr style={{ color: "var(--lb-text-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                                <th style={{ textAlign: "left", padding: "4px 6px" }}>Supplier</th>
                                <th style={{ textAlign: "right", padding: "4px 6px" }}>Unit price</th>
                                <th style={{ textAlign: "right", padding: "4px 6px" }}>MOQ</th>
                                <th style={{ textAlign: "right", padding: "4px 6px" }}>Lead</th>
                                <th style={{ textAlign: "left", padding: "4px 6px" }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {quoteLines.map(({ quote, line: ql, supplierName }) => (
                                <tr key={ql.id} style={{ borderTop: "1px solid var(--lb-border)" }}>
                                  <td style={{ padding: "4px 6px", color: "var(--lb-text)" }}>{supplierName}</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                    {fmtMoney(Number(ql.unitPrice), quote.currency)}
                                  </td>
                                  <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--lb-text-3)" }}>{ql.moq ?? "—"}</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--lb-text-3)" }}>
                                    {ql.leadTimeDays != null ? `${ql.leadTimeDays}d` : "—"}
                                  </td>
                                  <td style={{ padding: "4px 6px", color: "var(--lb-text-2)" }}>{quote.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* PO history */}
              <section style={panelStyle}>
                <h3 style={panelH3}>PO history ({data.pos.length})</h3>
                {data.pos.length === 0 ? (
                  <Empty>No POs yet for this part.</Empty>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    {data.pos.map(({ po, line }) => (
                      <li
                        key={po.id}
                        style={{ padding: 8, borderRadius: 6, background: "var(--lb-bg)", border: "1px solid var(--lb-border)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <a
                          href={`/suppliers/po/${po.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--lb-accent)", textDecoration: "none", fontWeight: 700, fontSize: 13 }}
                        >
                          {po.poNumber}
                        </a>
                        <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
                          → {po.supplierName} · qty {line.qty} @ {fmtMoney(Number(line.unitPrice), po.currency)}
                          · {new Date(po.createdAt).toLocaleDateString()}
                        </span>
                        <span style={{ marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "var(--lb-text)" }}>
                          {fmtMoney(Number(line.totalPrice), po.currency)}
                        </span>
                        <span style={{ fontSize: 10.5, color: "var(--lb-text-3)", textTransform: "uppercase" }}>
                          {po.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function rfqStatusColor(s: string): string {
  switch (s) {
    case "draft": return "#6b7280";
    case "sent": return "#2563eb";
    case "quotes-in": return "#0891b2";
    case "reviewed": return "#ca8a04";
    case "awarded": return "#16a34a";
    case "closed": return "#475569";
    case "cancelled": return "#dc2626";
    default: return "#6b7280";
  }
}

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

function FieldRow({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 13, color: "var(--lb-text)" }}>{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 10, borderRadius: 8, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700, color: "var(--lb-text)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
};
const panelH3: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: "var(--lb-text)",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  border: "1px solid var(--lb-border)",
  fontSize: 13,
};
function miniBtn(color: string): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    background: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}
