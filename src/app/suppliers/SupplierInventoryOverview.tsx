"use client";

// ERP System → "Supplier Inventory" sub-tab. Aggregate read-only view of
// every top-level PART across every supplier in the tenant, with
// filters by project number and free-text product search. Replaces the
// previous Manufacturing stub.
//
// Clicking a card hands off to the parent (InventoryAndManufacturing)
// via `onJumpToSupplier`, which switches the sub-tab to "Suppliers" and
// pre-opens the chosen supplier's detail panel + the Products tab on
// that panel so the user can drill into files/configurations with the
// full editor.

import { useEffect, useMemo, useState } from "react";
import {
  listAggregateSupplierInventory,
  type AggregateInventoryPart,
} from "./supplier-inventory-actions";

export default function SupplierInventoryOverview({
  onJumpToSupplier,
}: {
  // Called with the supplier id (and optional part id to focus) when the
  // user clicks a card. Parent navigates to the suppliers tab.
  onJumpToSupplier: (supplierId: number, partId?: number) => void;
}) {
  const [data, setData] = useState<{
    parts: AggregateInventoryPart[];
    projectNums: string[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");

  useEffect(() => {
    listAggregateSupplierInventory()
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  const suppliers = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of data?.parts ?? []) map.set(p.supplierId, p.supplierName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.parts ?? []).filter((p) => {
      if (supplierFilter !== "all" && String(p.supplierId) !== supplierFilter) {
        return false;
      }
      if (projectFilter !== "all" && !p.projectNums.includes(projectFilter)) {
        return false;
      }
      if (!q) return true;
      const hay = [
        p.name,
        p.productCode ?? "",
        p.category ?? "",
        p.description ?? "",
        p.supplierName,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, search, projectFilter, supplierFilter]);

  if (err) {
    return (
      <div style={{ padding: 24 }}>
        <div
          style={{
            padding: 14,
            borderRadius: 10,
            background: "rgba(220,38,38,0.10)",
            border: "1px solid rgba(220,38,38,0.40)",
            color: "#dc2626",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      </div>
    );
  }
  if (data === null) {
    return (
      <div style={{ padding: 24, color: "var(--lb-text-3)", fontSize: 13 }}>
        Loading supplier inventory…
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        background: "var(--lb-bg)",
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        color: "var(--lb-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "clamp(20px, 2.3vw, 26px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            Supplier Inventory
          </h1>
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
            Every part across every supplier in your tenant. Filter by project
            or by product to find what you need, then click a card to jump
            into that supplier&apos;s catalog.
          </p>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--lb-text-3)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 999,
            padding: "6px 14px",
            whiteSpace: "nowrap",
            alignSelf: "center",
          }}
        >
          {filtered.length} of {data.parts.length} part{data.parts.length === 1 ? "" : "s"}
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          padding: 14,
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <FilterField label="Product search">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, code, category…"
            style={INPUT_STYLE}
          />
        </FilterField>
        <FilterField label="Project">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="all">All projects</option>
            {data.projectNums.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Supplier">
          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="all">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        </FilterField>
        {(search || projectFilter !== "all" || supplierFilter !== "all") && (
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setProjectFilter("all");
                setSupplierFilter("all");
              }}
              style={RESET_BTN}
            >
              Reset filters
            </button>
          </div>
        )}
      </section>

      {filtered.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--lb-text-3)",
            fontSize: 13,
            border: "1px dashed var(--lb-border)",
            borderRadius: 10,
          }}
        >
          {data.parts.length === 0
            ? "No parts in any supplier's catalog yet. Add some from a supplier's Products tab and they'll show up here."
            : "No parts match the current filters."}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {filtered.map((p) => (
            <PartCard
              key={p.id}
              part={p}
              onClick={() => onJumpToSupplier(p.supplierId, p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
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

function PartCard({
  part,
  onClick,
}: {
  part: AggregateInventoryPart;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        color: "var(--lb-text)",
        textAlign: "left",
        cursor: "pointer",
        transition: "border-color 140ms ease, transform 140ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--lb-accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--lb-border)";
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "4/3",
          width: "100%",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          display: "grid",
          placeItems: "center",
        }}
      >
        {part.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={part.thumbnailUrl}
            alt={part.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 24, color: "var(--lb-text-3)" }}>📦</span>
        )}
        {part.modelCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              background: "rgba(124,58,237,0.85)",
              color: "white",
              backdropFilter: "blur(4px)",
            }}
          >
            {part.modelCount} config{part.modelCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 15,
            color: "var(--lb-text)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {part.productCode || part.name}
        </div>
        {part.productCode && part.name && part.name !== part.productCode && (
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
            {part.name}
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--lb-text-2)",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "rgba(8,145,178,0.15)",
            color: "#0891b2",
            border: "1px solid rgba(8,145,178,0.3)",
            fontWeight: 700,
          }}
        >
          {part.supplierName}
        </span>
        {part.category && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-3)",
              fontWeight: 600,
            }}
          >
            {part.category}
          </span>
        )}
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-3)",
            fontWeight: 600,
          }}
        >
          📎 {part.attachmentCount} file{part.attachmentCount === 1 ? "" : "s"}
        </span>
      </div>
      {part.projectNums.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: "var(--lb-text-3)",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
          }}
        >
          <span style={{ fontWeight: 700, color: "var(--lb-text-2)" }}>
            Projects:
          </span>
          {part.projectNums.slice(0, 5).map((n) => (
            <span
              key={n}
              style={{
                padding: "1px 7px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
              }}
            >
              {n}
            </span>
          ))}
          {part.projectNums.length > 5 && (
            <span>+{part.projectNums.length - 5} more</span>
          )}
        </div>
      )}
    </button>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 13,
  outline: "none",
};

const RESET_BTN: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text-2)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
