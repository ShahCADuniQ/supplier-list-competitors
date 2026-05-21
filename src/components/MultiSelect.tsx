"use client";

// Multi-select chip picker with optional search and free-text additions.
// Extracted from the supplier onboarding form so the step-1 sign-up
// wizard and the step-2 compliance form can share the same UX (and so
// future surfaces — supplier admin edit, etc — can pick it up too).
//
// The component is self-contained: pass the list of options, the
// currently-selected items, an onChange callback, and (optionally) a
// flag to allow free-text custom entries.

import { useMemo, useState } from "react";

const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--lb-text-3)",
  marginBottom: 4,
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 14,
  border: "1px solid var(--lb-border)",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  outline: "none",
};

export default function MultiSelect({
  label,
  hint,
  options,
  selected,
  onChange,
  allowCustom,
  onAddCustom,
  disabled,
}: {
  label: string;
  hint?: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  allowCustom?: boolean;
  // Optional callback fired when the user clicks "Add" on a custom
  // entry. Use it to persist the new value to a shared taxonomy table
  // so the next supplier sees it as a normal option. The callback can
  // return a Promise<string> with the canonical value the server
  // stored (e.g. de-duped or normalised); if it does, that value is
  // used instead of the raw input.
  onAddCustom?: (value: string) => Promise<string | void> | string | void;
  // When true the entire control is read-only (no toggles, no custom
  // input). Used by the distributor flow to grey out manufacturing /
  // materials questions without removing the chips entirely.
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [busyCustom, setBusyCustom] = useState(false);

  const filteredOptions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [filter, options]);

  function toggle(opt: string) {
    if (disabled) return;
    if (selected.includes(opt)) onChange(selected.filter((s) => s !== opt));
    else onChange([...selected, opt]);
  }
  async function addCustom() {
    if (disabled) return;
    const v = draft.trim();
    if (!v) return;
    if (selected.some((s) => s.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    // If the parent wants to persist new terms to a shared catalog,
    // wait for it before adding to selected so we can use whatever
    // canonical value the server returned (case normalisation, etc.).
    let canonical = v;
    if (onAddCustom) {
      setBusyCustom(true);
      try {
        const out = await onAddCustom(v);
        if (typeof out === "string" && out) canonical = out;
      } catch {
        /* keep the raw user input on persistence failure; the parent
           will have shown an error elsewhere if it cares. */
      } finally {
        setBusyCustom(false);
      }
    }
    if (!selected.some((s) => s.toLowerCase() === canonical.toLowerCase())) {
      onChange([...selected, canonical]);
    }
    setDraft("");
  }
  function remove(opt: string) {
    if (disabled) return;
    onChange(selected.filter((s) => s !== opt));
  }

  return (
    <div>
      <div style={FIELD_LABEL}>{label}</div>
      {hint && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--lb-text-3)",
            marginTop: -2,
            marginBottom: 6,
          }}
        >
          {hint}
        </div>
      )}

      {selected.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            marginBottom: 8,
            borderRadius: 8,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
          }}
        >
          {selected.map((s) => (
            <span
              key={s}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12.5,
                fontWeight: 600,
                background: "var(--lb-accent)",
                color: "var(--lb-accent-fg)",
                borderRadius: 999,
              }}
            >
              {s}
              <button
                type="button"
                onClick={() => remove(s)}
                aria-label={`Remove ${s}`}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${label.toLowerCase()}…`}
        style={{ ...INPUT_STYLE, marginBottom: 6 }}
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          maxHeight: 180,
          overflowY: "auto",
          padding: 4,
          border: "1px solid var(--lb-border)",
          borderRadius: 8,
          background: "var(--lb-bg)",
        }}
      >
        {filteredOptions.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              style={{
                padding: "5px 11px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                border: on
                  ? "1px solid var(--lb-accent)"
                  : "1px solid var(--lb-border)",
                background: on ? "var(--lb-accent)" : "var(--lb-bg-elev)",
                color: on ? "var(--lb-accent-fg)" : "var(--lb-text)",
                cursor: "pointer",
              }}
            >
              {opt}
            </button>
          );
        })}
        {filteredOptions.length === 0 && (
          <span
            style={{
              fontSize: 12,
              color: "var(--lb-text-3)",
              padding: "4px 8px",
            }}
          >
            No matches.
          </span>
        )}
      </div>

      {allowCustom && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder="Add a custom entry…"
            disabled={disabled || busyCustom}
            style={{
              ...INPUT_STYLE,
              opacity: disabled || busyCustom ? 0.6 : 1,
            }}
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={disabled || busyCustom}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 8,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              cursor: disabled || busyCustom ? "wait" : "pointer",
              color: "var(--lb-text)",
              opacity: disabled || busyCustom ? 0.6 : 1,
            }}
          >
            {busyCustom ? "Adding…" : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}
