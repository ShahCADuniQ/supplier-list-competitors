"use client";

// Small embedded picker for tagging an order/line with the Lightbase
// assembly it's being procured for. Search + click; shows the current
// selection inline with an "Unlink" affordance.

import { useEffect, useMemo, useState } from "react";
import {
  listAssembliesForPicker,
  type AssemblyPickerItem,
} from "./inventory-actions";

type Props = {
  value: number | null;
  // Optional label override; defaults to "For product / assembly".
  label?: string;
  // Free-text hint shown under the field.
  hint?: string;
  onChange: (item: AssemblyPickerItem | null) => void;
};

export default function AssemblyPicker({ value, label, hint, onChange }: Props) {
  const [items, setItems] = useState<AssemblyPickerItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (items != null) return;
    listAssembliesForPicker()
      .then(setItems)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, [items]);

  const selected = useMemo(
    () => (items ?? []).find((i) => i.id === value) ?? null,
    [items, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items ?? [];
    return (items ?? []).filter((i) => {
      const hay = [i.code, i.name ?? "", i.description ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label ?? "For product / assembly"}
      </span>

      {selected ? (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--lb-accent) 10%, transparent)",
            border: "1px solid var(--lb-accent)",
            color: "var(--lb-text)",
            fontSize: 12.5,
            alignSelf: "flex-start",
          }}
        >
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 800 }}>
            {selected.code}
          </span>
          {selected.name && (
            <span style={{ color: "var(--lb-text-2)" }}>· {selected.name}</span>
          )}
          <button
            type="button"
            onClick={() => onChange(null)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--lb-text-3)",
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
            }}
            aria-label="Unlink assembly"
            title="Unlink — this order will no longer be tagged with that assembly"
          >
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            padding: "6px 10px",
            fontSize: 12.5,
            fontWeight: 700,
            borderRadius: 8,
            border: "1px dashed var(--lb-border)",
            background: "var(--lb-bg)",
            color: "var(--lb-text-2)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          🧩 Pick assembly…
        </button>
      )}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>{hint}</span>
      )}

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "grid",
            placeItems: "center",
            zIndex: 90,
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 14,
              width: "min(560px, 100%)",
              maxHeight: "85vh",
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
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>
                Pick a Lightbase assembly
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ background: "transparent", border: "none", color: "var(--lb-text-3)", fontSize: 20, cursor: "pointer" }}
              >
                ×
              </button>
            </header>

            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by code, name, description…"
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
                minHeight: 160,
                overflowY: "auto",
                border: "1px solid var(--lb-border)",
                borderRadius: 8,
              }}
            >
              {items === null ? (
                <div style={{ padding: 16, color: "var(--lb-text-3)", fontSize: 12.5, textAlign: "center" }}>
                  Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: 16, color: "var(--lb-text-3)", fontSize: 12.5, textAlign: "center" }}>
                  {(items ?? []).length === 0
                    ? "No assemblies yet — create one in Lightbase Inventory first, or skip this field."
                    : "No matches."}
                </div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {filtered.slice(0, 200).map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(i);
                          setOpen(false);
                        }}
                        style={{
                          display: "flex",
                          gap: 8,
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
                        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 800, fontSize: 12.5 }}>
                          {i.code}
                        </span>
                        {i.name && (
                          <span style={{ fontSize: 12.5, color: "var(--lb-text-2)" }}>
                            · {i.name}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
