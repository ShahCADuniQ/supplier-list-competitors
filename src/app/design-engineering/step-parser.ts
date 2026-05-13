// Minimal STEP (ISO 10303-21) BOM extractor. STEP files describe CAD
// geometry as a graph of typed entities; for BOM purposes we only need a
// few entity types:
//
//   PRODUCT('name','description','id',(#context))       — defines one unique part
//   PRODUCT_DEFINITION_FORMATION / PRODUCT_DEFINITION    — internal refs
//   NEXT_ASSEMBLY_USAGE_OCCURRENCE(...)                  — parent→child usage
//
// We don't traverse the assembly tree fully — that would require building
// a graph + counting paths from the root. Instead we:
//   1. Pull every unique PRODUCT name.
//   2. Count how many NEXT_ASSEMBLY_USAGE_OCCURRENCE references touch
//      each PRODUCT (via the part's PRODUCT_DEFINITION id).
//   3. Clamp the count to at least 1 per unique part (some parts appear
//      only at the root and have no NAUO referring to them).
//
// This is heuristic — STEP files in the wild vary wildly. Quantities for
// nested assemblies will undercount. But it gets the user 80% of the way
// to a populated BOM in one click, and they can edit the quantities by
// hand from there.

export type ExtractedBomEntry = {
  name: string;
  description: string;
  quantity: number;
};

const PRODUCT_RX =
  /#(\d+)\s*=\s*PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/gi;

// PRODUCT_DEFINITION_FORMATION links a #id back to a PRODUCT #id.
// shape: #N = PRODUCT_DEFINITION_FORMATION('','',#PROD_ID);
const PDF_RX =
  /#(\d+)\s*=\s*PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?\s*\([^)]*?#(\d+)\s*[),]/gi;

// PRODUCT_DEFINITION links to a PRODUCT_DEFINITION_FORMATION.
// shape: #N = PRODUCT_DEFINITION('','',#PDF_ID,#PDFC_ID);
const PD_RX =
  /#(\d+)\s*=\s*PRODUCT_DEFINITION\s*\([^)]*?#(\d+)\s*,\s*#\d+\s*\)/gi;

// NEXT_ASSEMBLY_USAGE_OCCURRENCE references two PRODUCT_DEFINITION ids.
// shape: #N = NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','','',#PARENT_PD, #CHILD_PD, $);
const NAUO_RX =
  /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\([^)]*?#(\d+)\s*,\s*#(\d+)/gi;

export function extractBomFromStepText(stepText: string): ExtractedBomEntry[] {
  if (!stepText || stepText.length < 50) return [];

  // 1. Index every PRODUCT entity.
  const productById = new Map<
    string,
    { name: string; description: string }
  >();
  let m: RegExpExecArray | null;
  while ((m = PRODUCT_RX.exec(stepText)) !== null) {
    const id = m[1];
    const name = m[2].trim();
    const description = m[3].trim();
    if (!name) continue;
    if (productById.has(id)) continue;
    productById.set(id, { name, description });
  }
  if (productById.size === 0) return [];

  // 2. Build PRODUCT_DEFINITION_FORMATION → PRODUCT and
  //    PRODUCT_DEFINITION → PRODUCT_DEFINITION_FORMATION lookup maps.
  const pdfToProduct = new Map<string, string>();
  while ((m = PDF_RX.exec(stepText)) !== null) {
    pdfToProduct.set(m[1], m[2]);
  }
  const pdToProduct = new Map<string, string>();
  while ((m = PD_RX.exec(stepText)) !== null) {
    const pdId = m[1];
    const pdfId = m[2];
    const prodId = pdfToProduct.get(pdfId);
    if (prodId) pdToProduct.set(pdId, prodId);
  }

  // 3. Count NEXT_ASSEMBLY_USAGE_OCCURRENCE references per child PRODUCT.
  //    NAUO(parent_pd, child_pd) means "parent uses child"; we count the
  //    child references as a proxy for usage count.
  const usageCount = new Map<string, number>();
  while ((m = NAUO_RX.exec(stepText)) !== null) {
    const childPdId = m[2];
    const childProdId = pdToProduct.get(childPdId);
    if (!childProdId) continue;
    usageCount.set(childProdId, (usageCount.get(childProdId) ?? 0) + 1);
  }

  // 4. Compose BOM entries. Always at least qty=1.
  const out: ExtractedBomEntry[] = [];
  for (const [id, info] of productById.entries()) {
    out.push({
      name: info.name,
      description: info.description,
      quantity: Math.max(1, usageCount.get(id) ?? 1),
    });
  }

  // De-dupe by canonical lowercased name (some STEPs emit the same part
  // multiple times with subtle whitespace differences). Merge quantities.
  const byKey = new Map<string, ExtractedBomEntry>();
  for (const e of out) {
    const key = e.name.toLowerCase().replace(/\s+/g, " ").trim();
    const prior = byKey.get(key);
    if (prior) {
      prior.quantity += e.quantity;
      if (!prior.description && e.description) {
        prior.description = e.description;
      }
    } else {
      byKey.set(key, { ...e });
    }
  }

  // Sort: highest-quantity first, then alphabetical.
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Tells us whether a file is a STEP file based on its name/MIME. Used by
 * the wizard to decide whether to offer the "Auto-extract BOM" button.
 */
export function isStepFile(input: { name: string; mime?: string | null }): boolean {
  const name = input.name.toLowerCase();
  if (/\.(step|stp|stpx|stp\.gz)$/.test(name)) return true;
  const mime = (input.mime ?? "").toLowerCase();
  if (mime.includes("step")) return true;
  return false;
}
