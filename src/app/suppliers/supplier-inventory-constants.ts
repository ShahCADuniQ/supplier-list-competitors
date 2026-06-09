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

// Predefined sub-categories surfaced when a supplier picks "LED Luminaires"
// as their primary capability. Each entry is the value persisted to
// suppliers.sub_category; the description sits underneath in the picker
// so the supplier knows which bucket they belong in. "Others" is the
// catch-all sentinel that swaps the picker for a free-text input.
export const LED_LUMINAIRE_SUBCATEGORIES: readonly { value: string; description: string }[] = [
  { value: "Bollards",                       description: "Short outdoor pathway lights, commonly used in landscaping and pedestrian walkways." },
  { value: "Bulb",                           description: "Standard replacement bulbs across MR16, GU10, A19, BR30, PAR, candelabra, etc." },
  { value: "Chandeliers / Decorative Pendants", description: "Suspended decorative fixtures for lobbies, dining, and hospitality spaces." },
  { value: "Cove Lighting",                  description: "Indirect lighting installed in ceilings or walls to create soft, ambient illumination." },
  { value: "Desk Lamps / Task Lights",       description: "Small, focused fixtures providing localized lighting for work surfaces." },
  { value: "Display / Showcase Lighting",    description: "Specialized lights for retail displays, museums, and product highlighting." },
  { value: "Downlight",                      description: "Recessed ceiling-mounted fixtures that provide general or accent illumination." },
  { value: "Emergency Lighting",             description: "Backup lights that activate during power outages for safety and egress." },
  { value: "Explosion-Proof Lighting",       description: "Heavy-duty fixtures designed for hazardous or industrial environments." },
  { value: "Facade Lighting",                description: "Exterior architectural lighting used to highlight building facades." },
  { value: "Floodlight",                     description: "Broad-beam fixtures for outdoor areas, security, and sports fields." },
  { value: "Highbay",                        description: "Powerful overhead fixtures used in warehouses, gyms, and large industrial spaces." },
  { value: "In-Ground / Uplights",           description: "Fixtures embedded in floors or ground to highlight trees, columns, or building exteriors." },
  { value: "Landscape",                      description: "Outdoor fixtures designed to light gardens, walkways, and landscape features." },
  { value: "Linear",                         description: "Long, continuous fixtures for modern office, retail, and decorative applications." },
  { value: "Medical / Clinical Lighting",    description: "Specialized fixtures for healthcare settings, such as exam and clean rooms." },
  { value: "Panel",                          description: "Flat, recessed ceiling lights commonly used in office grid ceilings." },
  { value: "Parking Light & Street Light",   description: "Outdoor pole-mounted fixtures for streets, roads, and parking areas." },
  { value: "Pendant Lighting",               description: "Hanging fixtures used in offices, retail, and dining for both function and style." },
  { value: "Pole-Mounted Area Lights",       description: "High-mounted fixtures for wide outdoor coverage, such as campuses and lots." },
  { value: "Projector",                      description: "Adjustable spotlight fixtures for accenting objects or surfaces." },
  { value: "Recessed Troffers",              description: "Rectangular fixtures integrated into grid ceilings for general office illumination." },
  { value: "Signage / Backlit Panels",       description: "Illuminated panels or lettering for branding and wayfinding." },
  { value: "Sport Lighting",                 description: "High-output lighting for stadiums, arenas, and sports facilities." },
  { value: "Standing Light",                 description: "Freestanding floor lamps for flexible task or accent lighting." },
  { value: "Step / Stair Lighting",          description: "Integrated lights in steps or handrails for safety and ambiance." },
  { value: "Surface-Mounted Fixtures",       description: "Directly mounted ceiling or wall lights where recessed installation isn't possible." },
  { value: "Theatrical / Stage Lighting",    description: "Specialized fixtures for performance venues, theaters, and event spaces." },
  { value: "Track Lighting",                 description: "Flexible systems with adjustable spotlights, often used in retail and galleries." },
  { value: "Tube Lighting",                  description: "Linear LED tubes, including T8/T5 retrofits and integrated tube fixtures." },
  { value: "Under-Cabinet / Shelf Lighting", description: "Compact fixtures for task lighting in kitchens or retail shelving." },
  { value: "UV-C / Germicidal Lighting",     description: "Ultraviolet lights used for sterilization and disinfection." },
  { value: "Wall Grazers / Washers",         description: "Fixtures that highlight vertical surfaces, textures, or features." },
  { value: "Wall Sconces",                   description: "Mounted fixtures providing both decorative and functional lighting along walls." },
  { value: "Wallpack",                       description: "Outdoor wall-mounted fixtures for building perimeters and security." },
  { value: "Others",                         description: "Any additional or custom fixture types not listed above." },
] as const;

// Map from a primary category to the predefined sub-category list it
// surfaces. Today only "LED Luminaires" has a canonical sub-list; add
// other categories here as their taxonomies firm up. When a category
// is absent from this map, the sub-category input renders as plain
// free text.
export const SUB_CATEGORY_OPTIONS_BY_CATEGORY: Record<string, readonly { value: string; description: string }[]> = {
  "LED Luminaires": LED_LUMINAIRE_SUBCATEGORIES,
};

// Convenience: returns the predefined sub-category list for a category
// or null if there isn't one. Drives every supplier-side and
// client-side sub-category input so the picker stays in sync.
export function subCategoriesFor(
  category: string | null | undefined,
): readonly { value: string; description: string }[] | null {
  if (!category) return null;
  return SUB_CATEGORY_OPTIONS_BY_CATEGORY[category] ?? null;
}

// The fixed canonical sections the drawer always renders. The "other_file"
// enum value still exists in the DB and is now used under the hood for
// supplier-defined custom sections — those are surfaced from the
// attachments themselves (grouped by custom_category_label), not from
// this list.
export const SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES = [
  { key: "spec_datasheet",            label: "Specifications & Datasheet" },
  { key: "ies_file",                  label: "IES Photometric Files" },
  { key: "drawing",                   label: "Drawings (CAD / PDF)" },
  // "Projects" replaced the old single "Quotes & Pricing" bucket. The
  // sidebar shows the unique-project count; clicking it opens a custom
  // per-project panel (RFQ / Quote / PO / PI / Invoice slots) rather than
  // the standard flat attachment list.
  { key: "project_doc",               label: "Projects" },
  { key: "contract_nda",              label: "Contracts & NDAs" },
  { key: "certification_compliance",  label: "Certifications & Compliance" },
  { key: "test_report_qc",            label: "Test Reports & QC" },
  { key: "photo_media",               label: "Photos & Media" },
] as const;

export type SupplierProductAttachmentCategory =
  (typeof SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES)[number]["key"]
  // Legacy values kept for backward compatibility — the DB enum still
  // contains them, so older rows in the wild can still be read. They're
  // not surfaced in the sidebar list.
  | "quote_pricing"
  | "other_file";

// Short label used in tight UI like card pills and table column headers.
export function shortCategoryLabel(k: SupplierProductAttachmentCategory): string {
  switch (k) {
    case "spec_datasheet":           return "Spec";
    case "ies_file":                 return "IES";
    case "drawing":                  return "Drawing";
    case "project_doc":              return "Project";
    case "quote_pricing":            return "Quote";
    case "contract_nda":             return "Contract";
    case "certification_compliance": return "Cert.";
    case "test_report_qc":           return "QC";
    case "photo_media":              return "Media";
    case "other_file":               return "Other";
  }
}

// The five canonical per-project document types. Order matches the
// procurement lifecycle: RFQ → Quote → PO → PI → Invoice. The Projects
// panel renders one slot per type.
export const PROJECT_DOC_TYPES = [
  { key: "rfq",      label: "RFQ",     blurb: "Request for Quotation sent to the supplier." },
  { key: "quote",    label: "Quote",   blurb: "Supplier's pricing reply / quotation document." },
  { key: "po",       label: "PO",      blurb: "Purchase Order issued to the supplier." },
  { key: "pi",       label: "PI",      blurb: "Proforma Invoice from the supplier." },
  { key: "invoice",  label: "Invoice", blurb: "Final / commercial invoice for accounting." },
] as const;

export type ProjectDocType = (typeof PROJECT_DOC_TYPES)[number]["key"];
