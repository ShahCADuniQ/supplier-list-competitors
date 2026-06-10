"use client";

// Reusable supplier-catalogue picker. Opens as a modal, searchable list
// of every product in the tenant (or scoped to a single supplier when
// supplierId is set). Selecting one fires onPick with the item; the
// caller pre-fills its RFQ line or order form from the returned data.

import { useEffect, useMemo, useState } from "react";
import {
  listCataloguePickerItems,
  type CataloguePickerItem,
} from "./supplier-inventory-actions";

type Props = {
  open: boolean;
  // When set, the picker is scoped to this supplier (useful for "Pick
  // another product from this same vendor"). Otherwise shows every
  // product in the tenant.
  supplierId?: number;
  onClose: () => void;
  onPick: (item: CataloguePickerItem) => void;
};

export default function CataloguePickerDialog({
  open,
  supplierId,
  onClose,
  onPick,
}: Props) {
  const [items, setItems] = useState<CataloguePickerItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setErr(null);
    listCataloguePickerItems(
      supplierId != null ? { supplierId } : undefined,
    )
      .then(setItems)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, [open, supplierId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items ?? [];
    return (items ?? []).filter((i) => {
      const hay = [
        i.name,
        i.productCode ?? "",
        i.category ?? "",
        i.description ?? "",
        i.supplierName,
        i.parentName ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 80,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          width: "min(720px, 100%)",
          maxHeight: "90vh",
          overflow: "hidden",
          padding: 16,
          color: "var(--lb-text)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
            Pick from catalogue
            {supplierId != null && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "var(--lb-text-3)", fontWeight: 600 }}>
                (scoped to this supplier)
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--lb-text-3)", fontSize: 20, cursor: "pointer" }}
          >
            ×
          </button>
        </header>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, code, supplier, category…"
          autoFocus
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid var(--lb-border)",
            background: "var(--lb-bg)",
            color: "var(--lb-text)",
          }}
        />

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

        <div
          style={{
            flex: 1,
            minHeight: 200,
            overflowY: "auto",
            border: "1px solid var(--lb-border)",
            borderRadius: 8,
          }}
        >
          {items === null ? (
            <div style={{ padding: 20, color: "var(--lb-text-3)", fontSize: 13, textAlign: "center" }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, color: "var(--lb-text-3)", fontSize: 13, textAlign: "center" }}>
              No matches.
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {filtered.slice(0, 200).map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => onPick(i)}
                    style={{
                      display: "flex",
                      gap: 10,
                      width: "100%",
                      padding: 10,
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--lb-border)",
                      color: "var(--lb-text)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {i.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={i.thumbnailUrl}
                        alt=""
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 6,
                          objectFit: "cover",
                          background: "var(--lb-bg)",
                          border: "1px solid var(--lb-border)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: i.productCode
                            ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                            : undefined,
                          fontWeight: 700,
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {i.productCode || i.name}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--lb-text-3)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {i.productCode && i.name !== i.productCode ? `${i.name} · ` : ""}
                        {i.supplierName}
                        {i.parentName ? ` · from ${i.parentName}` : ""}
                        {i.category ? ` · ${i.category}` : ""}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
              {filtered.length > 200 && (
                <li style={{ padding: 10, fontSize: 11, color: "var(--lb-text-3)", textAlign: "center" }}>
                  Showing first 200 of {filtered.length}. Narrow the search to see more.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
