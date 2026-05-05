// Client-safe canonical document-kind constants. Mirrored from _attachments.ts
// so client components can import them without dragging in the DB / blob deps.

export type CanonicalKind =
  | "spec-sheet"
  | "ies-photometric"
  | "cad-drawing"
  | "bim-revit"
  | "brochure"
  | "installation"
  | "warranty"
  | "manual"
  | "certification"
  | "image"
  | "other";

export const CANONICAL_KIND_LABELS: Record<CanonicalKind, string> = {
  "spec-sheet": "Spec sheet",
  "ies-photometric": "IES / photometric",
  "cad-drawing": "CAD drawing",
  "bim-revit": "BIM / Revit",
  "brochure": "Brochure",
  "installation": "Installation guide",
  "warranty": "Warranty",
  "manual": "Manual",
  "certification": "Certification",
  "image": "Image",
  "other": "Other",
};

export const CANONICAL_KIND_ORDER: CanonicalKind[] = [
  "spec-sheet",
  "ies-photometric",
  "cad-drawing",
  "bim-revit",
  "brochure",
  "installation",
  "manual",
  "warranty",
  "certification",
  "image",
  "other",
];

/**
 * Map a brand-site CATEGORY LABEL (e.g. "Specification Sheets",
 * "Installation Instructions", "Technical Files") to a canonical kind.
 * Used when extraction comes from an embedded JSON blob with category
 * labels — we use those over filename heuristics.
 *
 * Multi-file categories like "Technical Files" return null because they
 * mix CAD/IES/spectral — callers should classify each file individually
 * via `classifyDocument` from _attachments.ts.
 */
export function categoryLabelToKind(label: string): CanonicalKind | null {
  const l = label.toLowerCase().trim();
  if (/spec(?:ification)?\s?sheets?|cut\s?sheets?|datasheets?/.test(l)) return "spec-sheet";
  if (/brochure|catalog|family\s?brochure|line\s?card|app\s?guide/.test(l)) return "brochure";
  if (/installation|install\s?guide|mounting/.test(l)) return "installation";
  if (/warranty/.test(l)) return "warranty";
  if (/manual|operating|user\s?guide/.test(l)) return "manual";
  if (/cert|compliance|ul\s?listing|dlc|fcc|rohs/.test(l)) return "certification";
  if (/photometric|ies|ldt/.test(l)) return "ies-photometric";
  if (/cad|drawing|dwg|dxf/.test(l)) return "cad-drawing";
  if (/bim|revit|3d\s?model|sketch\s?up|step/.test(l)) return "bim-revit";
  // "Technical Files" / "Reference Guides" / "Related Documents" — let the
  // caller classify per-file because those labels mix kinds.
  if (/technical\s?files?|reference\s?guides?|related\s?documents?|resources?/.test(l)) {
    return null;
  }
  return null;
}

export function normalizeKind(raw: string | null | undefined): CanonicalKind {
  if (!raw) return "other";
  const k = raw.toLowerCase().trim();
  // Map legacy / loose values to canonical.
  const map: Record<string, CanonicalKind> = {
    datasheet: "spec-sheet",
    "data-sheet": "spec-sheet",
    "spec-sheet": "spec-sheet",
    specsheet: "spec-sheet",
    "cut-sheet": "spec-sheet",
    cutsheet: "spec-sheet",
    drawing: "cad-drawing",
    "cad-drawing": "cad-drawing",
    cad: "cad-drawing",
    dwg: "cad-drawing",
    dxf: "cad-drawing",
    bim: "bim-revit",
    "bim-revit": "bim-revit",
    revit: "bim-revit",
    rfa: "bim-revit",
    rvt: "bim-revit",
    ies: "ies-photometric",
    "ies-photometric": "ies-photometric",
    photometric: "ies-photometric",
    ldt: "ies-photometric",
    brochure: "brochure",
    catalog: "brochure",
    installation: "installation",
    install: "installation",
    warranty: "warranty",
    manual: "manual",
    operating: "manual",
    user: "manual",
    certification: "certification",
    cert: "certification",
    image: "image",
    photo: "image",
    other: "other",
  };
  return map[k] ?? "other";
}
