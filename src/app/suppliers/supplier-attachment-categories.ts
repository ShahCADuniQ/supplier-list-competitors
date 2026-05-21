// Shared category list for the supplier_attachments table — used by:
//   • src/app/portal/SupplierOnboardingForm.tsx (step-2 supplier upload)
//   • src/app/portal/AboutUsTab.tsx             (approved-supplier portal)
//   • src/app/suppliers/SuppliersView.tsx       (engineering tenant's admin)
//
// Both sides share the 8 canonical sections so an "ISO certificate" the
// supplier uploaded lands under "Certifications & Compliance" in the
// reviewer's panel without any mapping.
//
// "Other" is GONE — the same use case is covered by custom sections:
// either side can add a new section, drop files into it, and the other
// side picks it up automatically the next time it renders (the catId is
// stored on the attachment row, so any non-canonical catId is treated as
// a custom section).

export type SupplierAttachmentCategoryMeta = {
  id: string;
  label: string;
  icon: string;
  color: string;
  desc: string;
};

// Canonical sections — visible to BOTH the supplier and the engineering
// tenant's admin. Add a new entry here only when it's worth surfacing
// universally; otherwise let the user create a custom section themselves.
export const SUPPLIER_ATTACHMENT_CATEGORIES: readonly SupplierAttachmentCategoryMeta[] = [
  { id: "specs",     label: "Specifications & Datasheets", icon: "📋", color: "#2563ff", desc: "Product specs, technical datasheets, drawings" },
  { id: "quotes",    label: "Quotes & Pricing",            icon: "💰", color: "#4ade80", desc: "Price lists, RFQ responses, quotations" },
  { id: "contracts", label: "Contracts & NDAs",            icon: "📜", color: "#a78bfa", desc: "MSAs, NDAs, supply agreements, terms" },
  { id: "certs",     label: "Certifications & Compliance", icon: "🛡", color: "#fbbf24", desc: "CE, UL, RoHS, REACH, ISO, FCC, CSA" },
  { id: "tests",     label: "Test Reports & QC",           icon: "🧪", color: "#22d3ee", desc: "Photometric, IES, LM-80, IP ratings, QC reports" },
  { id: "catalogs",  label: "Catalogs & Brochures",        icon: "📚", color: "#ff4d2e", desc: "Marketing materials, product catalogs" },
  { id: "comms",     label: "Communications",              icon: "✉️", color: "#fb7185", desc: "Cover letters, references, prior work" },
  { id: "media",     label: "Photos & Media",              icon: "🖼", color: "#e879f9", desc: "Factory tour photos, sample images" },
] as const;

// Client-only — engineering tenants track POs / invoices they sent the
// supplier. Suppliers don't upload these themselves, so this list is
// rendered ONLY on the client-side admin panel, not on the supplier
// portal.
export const SUPPLIER_ATTACHMENT_CATEGORIES_CLIENT_ONLY: readonly SupplierAttachmentCategoryMeta[] = [
  { id: "invoices", label: "Invoices & POs", icon: "🧾", color: "#60a5fa", desc: "Purchase orders, invoices, payment receipts" },
] as const;

// Default look for custom-section chips (icon + tint). All free-text
// sections share this so they're visually distinct from the curated 8.
export const CUSTOM_SECTION_META = {
  icon: "📁",
  color: "#94a3b8",
  desc: "Custom section",
} as const;

const _canonicalIds = new Set<string>([
  ...SUPPLIER_ATTACHMENT_CATEGORIES.map((c) => c.id),
  ...SUPPLIER_ATTACHMENT_CATEGORIES_CLIENT_ONLY.map((c) => c.id),
  // Legacy "other" catId — silently swallowed so old rows uploaded
  // before custom sections existed don't surface as a "Other" custom
  // section the user can't get rid of. They still get rendered, but
  // grouped under a single "Other" tile when present (see helpers).
  "other",
]);

export function isCanonicalCatId(catId: string): boolean {
  return _canonicalIds.has(catId);
}

// Slugify a user-typed section name into a stable catId. Lowercase,
// alpha-numeric + dashes only. Two users typing the same name end up in
// the same bucket regardless of casing or punctuation.
export function customCatSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Convert a catId back to a human label for display. Used when the
// other side renders a custom section it didn't create — we don't have
// the original label, just the slug, so title-case the slug.
export function customCatLabel(catId: string): string {
  if (!catId) return "Untitled";
  return catId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Group a list of attachment catIds into the canonical buckets plus
// every distinct non-canonical catId (each one becomes a custom
// section). The "other" legacy catId is reported as a single bucket
// rather than promoted to a custom section.
export function listCustomSectionIds(catIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of catIds) {
    if (isCanonicalCatId(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
