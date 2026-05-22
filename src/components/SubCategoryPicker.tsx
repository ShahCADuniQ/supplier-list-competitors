"use client";

// Shared sub-category input used everywhere a supplier's sub-category is
// captured (sign-up wizard, step-2 portal editor, About us tab, and the
// engineering tenant's admin supplier panel).
//
// Behaviour:
//   • When the parent's category has a predefined list (see
//     SUB_CATEGORY_OPTIONS_BY_CATEGORY in supplier-inventory-constants),
//     render a select with the canonical options + an "Others" sentinel
//     that swaps the picker for a free-text input. We always render the
//     description of the selected option so the supplier knows which
//     bucket they're in.
//   • Otherwise, render a plain text input — same UX the wizard has had
//     until now.
//
// Persisted value is always a string (suppliers.sub_category). When the
// user picks "Others" we keep their typed text as the saved value, not
// the literal word "Others".

import { useMemo } from "react";
import { subCategoriesFor } from "@/app/suppliers/supplier-inventory-constants";

const INPUT_BASE: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  fontSize: 14,
  border: "1px solid var(--lb-border)",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  outline: "none",
};

export default function SubCategoryPicker({
  category,
  value,
  onChange,
  placeholder,
  inputStyle,
  className,
}: {
  category: string | null | undefined;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  // Optional style override so the picker matches the rest of the form
  // it's embedded in (some surfaces use a class-based input, others
  // inline styles).
  inputStyle?: React.CSSProperties;
  className?: string;
}) {
  const list = useMemo(() => subCategoriesFor(category), [category]);
  const style: React.CSSProperties = { ...INPUT_BASE, ...inputStyle };

  // No predefined list for this category → free-text input.
  if (!list) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "e.g. aluminum extrusion, 0-10V drivers…"}
        style={style}
        className={className}
      />
    );
  }

  // Predefined list. "Others" is the catch-all that swaps to a free-text
  // field; any value not in the list also routes through the "Others"
  // bucket so legacy free-text data keeps rendering correctly.
  const valuesInList = new Set(list.map((o) => o.value));
  const useOthers = value !== "" && !valuesInList.has(value);
  const selected = useOthers ? "Others" : value;
  const selectedMeta = list.find((o) => o.value === selected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <select
        value={selected}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "Others") {
            // Swap to free-text; clear the persisted value so the user
            // can type their own. Pre-fills with whatever they already
            // had (covers legacy free text).
            onChange(useOthers ? value : "");
          } else {
            onChange(next);
          }
        }}
        style={style}
        className={className}
      >
        <option value="">— select sub-category —</option>
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value}
          </option>
        ))}
      </select>
      {selectedMeta && selectedMeta.value !== "Others" && (
        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", lineHeight: 1.4 }}>
          {selectedMeta.description}
        </div>
      )}
      {selected === "Others" && (
        <>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Describe your sub-category…"
            style={style}
            className={className}
            autoFocus
          />
          <div style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
            Any additional or custom fixture types not listed above.
          </div>
        </>
      )}
    </div>
  );
}
