"use client";

// Drop-in replacement for the native <select> used for Incoterms across the
// app. Reproduces the look + keyboard behaviour of a native picker but each
// open-state option carries a (?) icon. Hovering the icon reveals a tooltip
// with the full term + transport mode + a plain-English explanation —
// without forcing the user to look up the abbreviation elsewhere.
//
// Why custom and not <option title="…">? Native option tooltips are
// inconsistent across browsers (Chrome ignores them on the popup, Firefox
// shows them only after a long hover, Safari skips them entirely). A custom
// listbox lets us guarantee the tooltip works the same everywhere.

import { useEffect, useRef, useState } from "react";
import { INCOTERM_META, INCOTERM_OPTIONS } from "./_orders-constants";

type Incoterm = (typeof INCOTERM_OPTIONS)[number];

export default function IncotermSelect({
  value,
  onChange,
  disabled,
  // Match the existing inputStyle / inputs in the form so the picker blends
  // in. Caller can pass overrides for width / margin / etc.
  style,
  // Allow callers to pass an empty/unset choice (e.g. the supplier-side
  // quote form where Incoterms is optional).
  allowEmpty = false,
  placeholder = "Select…",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside dismisses.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedMeta =
    value && (INCOTERM_OPTIONS as readonly string[]).includes(value)
      ? INCOTERM_META[value as Incoterm]
      : null;

  return (
    <div ref={rootRef} style={{ position: "relative", ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          background: "var(--lb-bg)",
          color: "var(--lb-text)",
          border: "1px solid var(--lb-border)",
          fontSize: 13,
          fontFamily: "inherit",
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          opacity: disabled ? 0.6 : 1,
        }}
        title={selectedMeta ? `${value} — ${selectedMeta.full}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value ? (
            <>
              <strong>{value}</strong>
              {selectedMeta && (
                <span style={{ color: "var(--lb-text-3)", marginLeft: 6, fontWeight: 400 }}>
                  · {selectedMeta.full}
                </span>
              )}
            </>
          ) : (
            <span style={{ color: "var(--lb-text-3)" }}>{placeholder}</span>
          )}
        </span>
        <span style={{ color: "var(--lb-text-3)", fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 40,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
            maxHeight: 360,
            overflowY: "auto",
            padding: 4,
          }}
        >
          {allowEmpty && (
            <Option
              code=""
              label="— None —"
              selected={!value}
              onPick={() => { onChange(""); setOpen(false); }}
            />
          )}
          {INCOTERM_OPTIONS.map((code) => {
            const meta = INCOTERM_META[code];
            return (
              <Option
                key={code}
                code={code}
                label={meta.full}
                mode={meta.mode}
                tooltip={meta.summary}
                selected={code === value}
                onPick={() => { onChange(code); setOpen(false); }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Option({
  code,
  label,
  mode,
  tooltip,
  selected,
  onPick,
}: {
  code: string;
  label: string;
  mode?: string;
  tooltip?: string;
  selected: boolean;
  onPick: () => void;
}) {
  // Hover-tooltip state on the (?) icon. Pinning to the icon (not the row)
  // means the row stays clickable without the tooltip getting in the way.
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onPick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? "rgba(8,145,178,0.15)" : "transparent",
        border: selected ? "1px solid rgba(8,145,178,0.45)" : "1px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--lb-bg)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <strong style={{ fontSize: 12.5, color: "var(--lb-text)", minWidth: 44 }}>
        {code || "—"}
      </strong>
      <span style={{ flex: 1, fontSize: 12, color: "var(--lb-text-2)" }}>
        {label}
        {mode && (
          <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--lb-text-3)" }}>
            · {mode}
          </span>
        )}
      </span>
      {tooltip && (
        <div
          style={{ position: "relative", display: "inline-flex" }}
          onMouseEnter={() => setTipOpen(true)}
          onMouseLeave={() => setTipOpen(false)}
        >
          <span
            role="img"
            aria-label={`Explain ${code}`}
            // Stop the click from bubbling so a hover-then-click on the
            // icon doesn't accidentally pick the option.
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "rgba(124,58,237,0.18)",
              color: "#a78bfa",
              fontSize: 11,
              fontWeight: 800,
              display: "grid",
              placeItems: "center",
              cursor: "help",
              border: "1px solid rgba(124,58,237,0.45)",
              userSelect: "none",
            }}
          >
            ?
          </span>
          {tipOpen && (
            <div
              role="tooltip"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 6px)",
                width: 280,
                padding: "10px 12px",
                background: "#0f1115",
                color: "#f5f5f7",
                border: "1px solid rgba(124,58,237,0.5)",
                borderRadius: 8,
                fontSize: 11.5,
                lineHeight: 1.45,
                boxShadow: "0 12px 24px rgba(0,0,0,0.4)",
                zIndex: 50,
                whiteSpace: "normal",
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                {code} — {label}
              </div>
              {mode && (
                <div style={{ color: "#a78bfa", fontSize: 10.5, fontWeight: 600, marginBottom: 4 }}>
                  {mode}
                </div>
              )}
              <div style={{ color: "#d4d4d8" }}>{tooltip}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
