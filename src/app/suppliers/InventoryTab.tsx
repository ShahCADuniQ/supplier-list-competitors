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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items ?? [];
    if (!q) return list;
    return list.filter((i) =>
      `${i.code} ${i.name ?? ""} ${i.description ?? ""} ${i.category ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, search]);

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

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${items?.length ?? 0} parts by Lightbase Ref., name, description, category…`}
        style={{
          padding: "10px 14px",
          borderRadius: 999,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 13,
        }}
      />

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
                  <Th>Lightbase Ref.</Th>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Unit</Th>
                  <Th style={{ textAlign: "right" }}>RFQs</Th>
                  <Th style={{ textAlign: "right" }}>POs</Th>
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
                          {it.description.slice(0, 80)}
                          {it.description.length > 80 ? "…" : ""}
                        </div>
                      )}
                    </Td>
                    <Td style={{ color: "var(--lb-text-2)" }}>{it.category ?? "—"}</Td>
                    <Td style={{ color: "var(--lb-text-3)" }}>{it.unit}</Td>
                    <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{it.rfqCount}</Td>
                    <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{it.poCount}</Td>
                    <Td style={{ color: "var(--lb-text-3)", fontSize: 11.5 }}>
                      {it.lastActivityAt ? new Date(it.lastActivityAt).toLocaleDateString() : "—"}
                    </Td>
                    <Td style={{ textAlign: "right", color: "var(--lb-text-3)" }}>›</Td>
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
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            {data && (
              <>
                <code
                  style={{
                    alignSelf: "flex-start",
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
