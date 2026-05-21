// Plain constants + types used by the Supplier Inventory tab. NOT a
// "use server" module — Next.js rejects non-function exports from
// server-action files, which would crash the page with a generic
// "Failed to fetch" before the action even runs.
//
// Source-of-truth for the pg enum `supplier_product_attachment_category`
// — keep this list in sync with the matching ALTER TYPE statements in
// _ensure-supplier-inventory-schema.ts.

// Standard manufacturing capabilities a vendor might offer. Used as the
// option set for the multi-select in the supplier onboarding form. The
// list is intentionally lighting-industry-flavoured but broad enough to
// cover most adjacent suppliers (electronics, optics, finishing).
export const MANUFACTURING_TYPES = [
  "CNC machining",
  "Sheet-metal fabrication",
  "Laser cutting",
  "Water-jet cutting",
  "Metal stamping",
  "Die casting (aluminum)",
  "Sand casting",
  "Investment casting",
  "Aluminum extrusion",
  "Plastic extrusion",
  "Injection molding",
  "Blow molding",
  "Thermoforming",
  "3D printing / additive",
  "Welding (TIG / MIG / spot)",
  "Brazing / soldering",
  "Powder coating",
  "Wet paint",
  "E-coat / electrocoat",
  "Anodizing",
  "Plating (zinc / nickel / chrome)",
  "Silk-screen / pad printing",
  "Laser engraving",
  "PCB fabrication",
  "SMT assembly",
  "Through-hole assembly",
  "Wire harness / cable assembly",
  "Final luminaire assembly",
  "Optical lens molding",
  "Tool & die / mold making",
  "Logistics / freight forwarding",
] as const;
export type ManufacturingType = (typeof MANUFACTURING_TYPES)[number];

// Standard materials a supplier might work with. Same role as
// MANUFACTURING_TYPES — option set for the multi-select onboarding picker.
export const SUPPLIER_MATERIALS = [
  "Aluminum 6061",
  "Aluminum 6063",
  "Aluminum 5052",
  "Stainless steel 304",
  "Stainless steel 316",
  "Carbon steel (cold-rolled)",
  "Carbon steel (galvanized)",
  "Brass",
  "Copper",
  "Bronze",
  "Zinc (die-cast)",
  "Magnesium",
  "PMMA / acrylic",
  "Polycarbonate (PC)",
  "ABS",
  "Nylon (PA / PA6)",
  "PVC",
  "Silicone",
  "Glass",
  "Tempered glass",
  "Optical-grade resin",
  "LED phosphor",
  "EPDM",
  "PORON foam",
  "Wood",
  "MDF",
] as const;
export type SupplierMaterial = (typeof SUPPLIER_MATERIALS)[number];

// Canonical supplier-category vocabulary. Single source of truth — the
// onboarding wizard, the supplier-database admin panel, the supplier
// product catalog, and the AI extractor all import from here so the
// list never drifts. Grouped by topic in the source order so the
// dropdown reads coherently top-to-bottom (lighting first since that's
// Lightbase's domain, then electronics, mechanical, services, etc.).
//
// Categories are deliberately broad — manufacturing PROCESSES (CNC,
// sheet-metal, injection moulding, etc.) belong to the separate
// "Manufacturing capabilities" multi-select, not in this list. A
// supplier picks ONE primary category here and tags multiple processes
// in the dedicated multi-select.
//
// When adding a new category, also add it to the migration map in
// scripts/migrate-supplier-categories.ts if you're consolidating
// existing values.
export const SUPPLIER_CATEGORIES = [
  // Lighting — core domain.
  "LED Components",
  "LED Luminaires",
  "Lamps & Bulbs",
  "Optics",
  "Drivers & Power Supplies",

  // Electronics.
  "Electronics & PCBs",
  "Wire, Cable & Connectors",

  // Mechanical + materials.
  "Metals & Extrusions",
  "Plastics & Composites",
  "Glass & Mirrors",
  "Mechanical Hardware",
  "Sealants & Thermal Materials",

  // Manufacturing services (NOT processes — those live in the
  // Manufacturing-capabilities multi-select).
  "Contract Manufacturing",
  "Surface Finishing",
  "Tooling & Mold Making",

  // Distribution + logistics.
  "Distribution & Wholesale",
  "Logistics & Freight",

  // Adjacent industries.
  "Furniture & Architectural",
  "Building Materials",
  "Flooring",
  "Acoustics",
  "Horticultural Lighting",
  "Exhibition & Display",

  // Services.
  "Design Services",
  "Software & Digital",
  "Testing & Certification",

  // Catch-all.
  "Other",
] as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

// The fixed canonical sections the drawer always renders. The "other_file"
// enum value still exists in the DB and is now used under the hood for
// supplier-defined custom sections — those are surfaced from the
// attachments themselves (grouped by custom_category_label), not from
// this list.
export const SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES = [
  { key: "spec_datasheet",            label: "Specifications & Datasheet" },
  { key: "ies_file",                  label: "IES Photometric Files" },
  { key: "drawing",                   label: "Drawings (CAD / PDF)" },
  { key: "quote_pricing",             label: "Quotes & Pricing" },
  { key: "contract_nda",              label: "Contracts & NDAs" },
  { key: "certification_compliance",  label: "Certifications & Compliance" },
  { key: "test_report_qc",            label: "Test Reports & QC" },
  { key: "photo_media",               label: "Photos & Media" },
] as const;

export type SupplierProductAttachmentCategory =
  (typeof SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES)[number]["key"];

// Short label used in tight UI like card pills and table column headers.
export function shortCategoryLabel(k: SupplierProductAttachmentCategory): string {
  switch (k) {
    case "spec_datasheet":           return "Spec";
    case "ies_file":                 return "IES";
    case "drawing":                  return "Drawing";
    case "quote_pricing":            return "Quote";
    case "contract_nda":             return "Contract";
    case "certification_compliance": return "Cert.";
    case "test_report_qc":           return "QC";
    case "photo_media":              return "Media";
  }
}
