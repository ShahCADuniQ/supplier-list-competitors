"use client";

// ERP System → "Supplier Inventory" sub-tab. Aggregate read-only view of
// every top-level PART across every supplier in the tenant, with
// filters by project number, supplier (searchable), part name
// (searchable), and free-text product search.
//
// Clicking a card opens the part's drawer INLINE on this tab — no tab
// switch — so the user can manage files / configurations without
// losing their place in the overview.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  listAggregateSupplierInventory,
  type AggregateInventoryPart,
} from "./supplier-inventory-actions";
import ProductDrawerLoader from "./ProductDrawerLoader";
import { dedupeParts, type SupplierCatalogueScope } from "./_dedupe-parts";

export default function SupplierInventoryOverview({
  canEdit,
}: {
  canEdit: boolean;
}) {
  const [data, setData] = useState<{
    parts: AggregateInventoryPart[];
    projectNums: string[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [partNameFilter, setPartNameFilter] = useState<string>("all");
  // Scope controls deduplication. See dedupeParts above for the rule.
  const [scope, setScope] = useState<SupplierCatalogueScope>("all");
  const [openPart, setOpenPart] = useState<AggregateInventoryPart | null>(null);

  function reload() {
    listAggregateSupplierInventory()
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }

  useEffect(() => {
    reload();
  }, []);

  // Distinct supplier and part-name lists — feed the searchable dropdowns.
  const suppliers = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of data?.parts ?? []) map.set(p.supplierId, p.supplierName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const partNames = useMemo(() => {
    const set = new Set<string>();
    for (const p of data?.parts ?? []) {
      if (p.name && p.name.trim()) set.add(p.name.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesFilters = (p: AggregateInventoryPart): boolean => {
      if (supplierFilter !== "all" && String(p.supplierId) !== supplierFilter) {
        return false;
      }
      if (projectFilter !== "all" && !p.projectNums.includes(projectFilter)) {
        return false;
      }
      if (partNameFilter !== "all" && p.name !== partNameFilter) {
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
    };
    // Dedup BEFORE field-filtering so the per-cluster representative is
    // picked from the full set, not from rows that happened to survive the
    // supplier filter. Otherwise selecting a supplier in the filter would
    // skew which row wins each cluster.
    const deduped = dedupeParts(data?.parts ?? [], scope);
    return deduped.filter(matchesFilters);
  }, [data, search, projectFilter, supplierFilter, partNameFilter, scope]);

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

  const anyFilterActive =
    !!search ||
    projectFilter !== "all" ||
    supplierFilter !== "all" ||
    partNameFilter !== "all" ||
    scope !== "all";

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
            Supplier Catalogue
          </h1>
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
            Every part across every supplier in your tenant. Green
            highlight = the one you picked as primary; open any card to
            link alternative products from the catalogue and decide
            which one of them is your primary. Linked products share a
            global product ID so swapping primaries never loses history.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            alignSelf: "center",
          }}
        >
          {/* Scope toggle — All vs Primary only. Sits right next to
              the count badge so the relationship between "what's
              shown" and "scope" reads instantly. */}
          <div
            role="tablist"
            aria-label="Scope"
            style={{
              display: "flex",
              gap: 4,
              padding: 3,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 999,
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === "all"}
              onClick={() => setScope("all")}
              style={SCOPE_PILL(scope === "all")}
            >
              All products
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === "primary"}
              onClick={() => setScope("primary")}
              style={SCOPE_PILL(scope === "primary", "#16a34a")}
            >
              ★ Primary only
            </button>
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
            }}
          >
            {filtered.length} of {data.parts.length} part{data.parts.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
          padding: 14,
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <FilterField label="Free-text search">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, code, category…"
            style={INPUT_STYLE}
          />
        </FilterField>

        <FilterField label="Supplier">
          <SearchableDropdown
            value={
              supplierFilter === "all"
                ? null
                : suppliers.find((s) => String(s.id) === supplierFilter)?.name ?? null
            }
            options={suppliers.map((s) => ({ id: String(s.id), label: s.name }))}
            allLabel="All suppliers"
            placeholder="Search suppliers…"
            onChange={(id) => setSupplierFilter(id ?? "all")}
          />
        </FilterField>

        <FilterField label="Part name">
          <SearchableDropdown
            value={partNameFilter === "all" ? null : partNameFilter}
            options={partNames.map((n) => ({ id: n, label: n }))}
            allLabel="All parts"
            placeholder="Search part names…"
            onChange={(id) => setPartNameFilter(id ?? "all")}
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

        {anyFilterActive && (
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setProjectFilter("all");
                setSupplierFilter("all");
                setPartNameFilter("all");
                setScope("all");
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
              onClick={() => setOpenPart(p)}
            />
          ))}
        </div>
      )}

      {openPart && (
        <ProductDrawerLoader
          partId={openPart.id}
          supplierId={openPart.supplierId}
          canEdit={canEdit}
          onClose={() => setOpenPart(null)}
          onChanged={reload}
        />
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

// Compact combobox: text input that filters a scrollable list of
// options. Used for the supplier and part-name dropdowns so long lists
// stay browsable. The "all" sentinel is the implicit reset option and
// is rendered as the first row of the popup.
function SearchableDropdown({
  value,
  options,
  allLabel,
  placeholder,
  onChange,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  allLabel: string;
  placeholder: string;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Close popup on outside click — use a per-instance ref so multiple
  // dropdowns on the same page don't share a single id.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const root = rootRef.current;
      if (root && root.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Display label = value (current selection) or the "all" sentinel.
  return (
    <div style={{ position: "relative" }} ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...INPUT_STYLE,
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
        title={value ?? allLabel}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: value ? "var(--lb-text)" : "var(--lb-text-3)",
          }}
        >
          {value ?? allLabel}
        </span>
        <span style={{ color: "var(--lb-text-3)", fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 10,
            boxShadow: "var(--lb-shadow)",
            maxHeight: 280,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoFocus
            style={{
              ...INPUT_STYLE,
              borderRadius: 0,
              border: "none",
              borderBottom: "1px solid var(--lb-border)",
              background: "var(--lb-bg)",
            }}
          />
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              overflowY: "auto",
              flex: 1,
            }}
          >
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                  setQuery("");
                }}
                style={DROPDOWN_OPTION_STYLE}
              >
                {allLabel}
              </button>
            </li>
            {filtered.length === 0 ? (
              <li style={{ padding: 10, fontSize: 12, color: "var(--lb-text-3)" }}>
                No matches.
              </li>
            ) : (
              filtered.map((o) => {
                const selected = o.id === (value ?? "");
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(o.id);
                        setOpen(false);
                        setQuery("");
                      }}
                      style={{
                        ...DROPDOWN_OPTION_STYLE,
                        background: selected
                          ? "color-mix(in srgb, var(--lb-accent) 14%, transparent)"
                          : "transparent",
                        color: selected ? "var(--lb-accent)" : "var(--lb-text)",
                        fontWeight: selected ? 700 : 500,
                      }}
                    >
                      {o.label}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function PartCard({
  part,
  onClick,
}: {
  part: AggregateInventoryPart;
  onClick: () => void;
}) {
  const isPrimary = part.isPrimarySupplier;
  const idleBorder = isPrimary ? "#16a34a" : "var(--lb-border)";
  const idleBg = isPrimary
    ? "color-mix(in srgb, #16a34a 8%, var(--lb-bg-elev))"
    : "var(--lb-bg-elev)";
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
        background: idleBg,
        // Primary suppliers get a thicker green border so they pop
        // out of the catalogue grid at a glance.
        border: isPrimary
          ? "2px solid #16a34a"
          : "1px solid var(--lb-border)",
        color: "var(--lb-text)",
        textAlign: "left",
        cursor: "pointer",
        transition: "border-color 140ms ease, transform 140ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = isPrimary ? "#22c55e" : "var(--lb-accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = idleBorder;
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
            style={{
              // Fit the entire picture in frame — no cropping. The
              // surrounding card panels in --lb-bg so the letterbox
              // edges blend with the card.
              width: "100%",
              height: "100%",
              objectFit: "contain",
            }}
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
        {isPrimary && (
          <span
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
              background: "#16a34a",
              color: "white",
            }}
          >
            ★ PRIMARY
          </span>
        )}
        {!isPrimary && part.alternativeSupplierCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
              background: "rgba(15,23,42,0.7)",
              color: "white",
              backdropFilter: "blur(4px)",
            }}
          >
            ALTERNATIVE
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
        {part.alternativeSupplierCount > 0 && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: "rgba(16,185,129,0.15)",
              color: "#16a34a",
              border: "1px solid rgba(16,185,129,0.45)",
              fontWeight: 700,
            }}
          >
            +{part.alternativeSupplierCount} alternative
            {part.alternativeSupplierCount === 1 ? "" : "s"}
          </span>
        )}
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

const DROPDOWN_OPTION_STYLE: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--lb-text)",
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

function SCOPE_PILL(active: boolean, activeColor = "var(--lb-accent)"): React.CSSProperties {
  return {
    padding: "5px 14px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: active ? 800 : 600,
    border: active ? `1px solid ${activeColor}` : "1px solid transparent",
    background: active ? activeColor : "transparent",
    color: active ? "#fff" : "var(--lb-text-2)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background 140ms ease, color 140ms ease",
  };
}
