"use server";

// IFC parser — extracts a manufacturing-friendly bill of parts from an
// uploaded IFC (Industry Foundation Classes) file.
//
// Output per part (grouped by Name + ObjectType so identical instances
// collapse into a single line with the count as QTY):
//   • PART NUMBER (= Tag or Name)
//   • DESCRIPTION (Description or ObjectType)
//   • QTY (instance count)
//   • WEIGHT g, SURFACE AREA mm², VOLUME mm³ (from Pset_BaseQuantities OR
//     IfcElementQuantity, falling back to material density × computed
//     volume if available)
//   • MATERIAL, DENSITY g/cm³ (from IfcRelAssociatesMaterial)
//
// The parser also returns the overall assembly metadata so the caller can
// flag whether the file represents a single assembly grouping these parts.
//
// We do NOT render the isometric view here — that lives in the client
// component (IfcDropzone.tsx) which uses three.js + web-ifc to draw the
// mesh on a canvas and capture a PNG. Server-side WebGL would need a
// headless GPU stack that's overkill for a thumbnail.

import { requireSupplierEditor } from "@/lib/permissions";
import { db } from "@/db";
import { inventoryItems } from "@/db/schema";
import { sql } from "drizzle-orm";

// web-ifc node bundle. Loaded lazily so it doesn't pull into routes that
// don't touch IFC parsing (the bundle is ~10 MB of WASM).
type IfcLineId = number;

export type IfcPartExtract = {
  // Best-effort part identifier — Tag → Name → ObjectType. Used as the
  // "PART NUMBER" in the AutoFill flow.
  partNumber: string;
  description: string | null;
  qty: number;
  weightG: number | null;
  surfaceAreaMm2: number | null;
  volumeMm3: number | null;
  material: string | null;
  densityGCm3: number | null;
  // The IFC entity type (e.g. "IfcBeam", "IfcColumn", "IfcBuildingElementProxy").
  ifcType: string;
  // Whether at least one instance of this part lives inside an IfcElementAssembly.
  partOfAssembly: boolean;
  // Express IDs of every IFC element that belongs to this BOM line — the
  // part instances themselves PLUS their recursive decomposition children
  // (SolidWorks feature solids like Revolve1, Combine2 that carry the
  // actual geometry for assembly-style parts such as PG9-9448K12).
  // The client-side renderer uses this set to filter LoadAllGeometry so
  // each inventory card shows ONLY that part's isometric view, not the
  // whole machine.
  expressIds: number[];
};

export type IfcExtractResult = {
  // True when the file contains an IfcElementAssembly (or aggregates a
  // hierarchy of parts under a top-level group). The UI uses this to set
  // inventory_items.kind = "assembly" and link the children.
  isAssembly: boolean;
  assemblyName: string | null;
  parts: IfcPartExtract[];
  // Bytes the parser read — handy for the UX summary line.
  byteSize: number;
  // Warnings the parser collected (missing psets, unsupported entities, …).
  // Surfaced in the UI under the file picker.
  warnings: string[];
};

// ─────────────────────────────────────────────────────────────────────────────

export async function parseIfcUpload(input: {
  // Vercel Blob URL of the uploaded .ifc file.
  url: string;
  fileName?: string;
}): Promise<IfcExtractResult> {
  await requireSupplierEditor();

  // Lazy-load web-ifc (~10 MB WASM) so build-time analysis doesn't drag
  // it into bundles that never use IFC parsing.
  //
  // The WASM is resolved relative to the web-ifc package's own __dirname
  // by `web-ifc-api-node.js`. We rely on serverExternalPackages: ["web-ifc"]
  // in next.config.ts to keep the package un-bundled so __dirname points
  // at the real node_modules/web-ifc/ directory where the WASM lives.
  // Don't try to call require.resolve here — Turbopack tries to statically
  // bundle the string and fails.
  const ifcModule = await import("web-ifc");
  const api = new ifcModule.IfcAPI();
  await api.Init();

  const res = await fetch(input.url);
  if (!res.ok) throw new Error(`Failed to fetch IFC: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  const warnings: string[] = [];
  const modelID = api.OpenModel(buf, { COORDINATE_TO_ORIGIN: true });

  try {
    // Pull all IfcBuildingElement* lines + IfcElementAssembly + the
    // generic catch-all IfcBuildingElementProxy. We grab everything from
    // IfcElement upward through inheritance so non-AEC parts (members,
    // fittings, etc.) are included too.
    const elementType = (ifcModule as unknown as { IFCELEMENT: number }).IFCELEMENT;
    const assemblyType = (ifcModule as unknown as { IFCELEMENTASSEMBLY: number }).IFCELEMENTASSEMBLY;
    const elementIds: IfcLineId[] = [];
    const elementVec = api.GetLineIDsWithType(modelID, elementType, true);
    for (let i = 0; i < elementVec.size(); i++) elementIds.push(elementVec.get(i));

    let isAssembly = false;
    let assemblyName: string | null = null;
    const assemblyChildIds = new Set<number>();
    // Cache: assembly id → count of LBLX-prefixed LEAF descendants (recursive
    // through nested sub-assemblies). Used to pick the "real" assembly root
    // among multiple candidates.
    const asmIds: number[] = [];
    try {
      const asmVec = api.GetLineIDsWithType(modelID, assemblyType, true);
      for (let i = 0; i < asmVec.size(); i++) asmIds.push(asmVec.get(i));
    } catch { /* no assemblies — flat file */ }

    if (asmIds.length > 0) {
      // Walk every assembly's IsDecomposedBy ONCE and cache the immediate
      // child ids, so the recursive LBLX-leaf count below doesn't refetch.
      const asmDirectChildren = new Map<number, number[]>();
      for (const id of asmIds) {
        const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy") as
          | { IsDecomposedBy?: Array<{ RelatedObjects?: Array<{ value: number }> }> }
          | undefined;
        const kids: number[] = [];
        for (const r of ln?.IsDecomposedBy ?? []) {
          for (const ro of r.RelatedObjects ?? []) {
            if (typeof ro?.value === "number") {
              kids.push(ro.value);
              assemblyChildIds.add(ro.value);
            }
          }
        }
        asmDirectChildren.set(id, kids);
      }

      // Cleaned name + CFG flag per assembly.
      const asmInfo = new Map<number, { name: string; cleaned: string; isCfg: boolean }>();
      for (const id of asmIds) {
        const ln = api.GetLine(modelID, id, true) as { Name?: unknown; LongName?: unknown; Tag?: unknown } | undefined;
        const rawName = stringValue(ln?.Name) ?? stringValue(ln?.LongName) ?? stringValue(ln?.Tag) ?? "";
        const cleaned = cleanPartNumber(rawName);
        asmInfo.set(id, { name: rawName, cleaned, isCfg: cleaned.toUpperCase().includes("CFG") });
      }

      // Recursive LBLX-leaf count: walks IsDecomposedBy chains and counts
      // distinct LBLX-prefixed descendants that AREN'T themselves containers
      // (i.e. true leaf BOM parts).
      const asmSet = new Set(asmIds);
      function countLblxLeaves(id: number, seen = new Set<number>()): number {
        if (seen.has(id)) return 0;
        seen.add(id);
        const kids = asmDirectChildren.get(id) ?? [];
        if (kids.length === 0) return 0;
        let count = 0;
        for (const kid of kids) {
          if (asmSet.has(kid)) {
            // Nested assembly — recurse.
            count += countLblxLeaves(kid, seen);
          } else {
            // Leaf element — count if its name is LBLX-prefixed.
            const ln = api.GetLine(modelID, kid, true) as
              | { Name?: unknown; ObjectType?: unknown; Tag?: unknown }
              | undefined;
            const raw = stringValue(ln?.Name) ?? stringValue(ln?.ObjectType) ?? stringValue(ln?.Tag) ?? "";
            const pn = cleanPartNumber(raw).toUpperCase();
            if (pn.startsWith("LBLX") && !pn.includes("CFG")) count += 1;
          }
        }
        return count;
      }

      // Pick the BEST assembly: skip CFG entries, prefer the one with the
      // most LBLX leaf descendants (true root, not a leaf sub-assembly).
      // Tiebreak: prefer assemblies that aren't decomposed by any non-CFG
      // parent (i.e. closest to the top).
      let bestId: number | null = null;
      let bestScore = -1;
      for (const id of asmIds) {
        const info = asmInfo.get(id);
        if (!info || info.isCfg) continue;
        const score = countLblxLeaves(id);
        if (score > bestScore) { bestScore = score; bestId = id; }
      }
      if (bestId != null) {
        isAssembly = true;
        const info = asmInfo.get(bestId)!;
        assemblyName = info.cleaned || info.name || input.fileName?.replace(/\.ifc$/i, "") || null;
      } else {
        // Every IFCELEMENTASSEMBLY is CFG — fall back to the filename (with
        // the trailing "-CFG" / " CFG" suffix stripped so the user sees a
        // clean assembly name).
        isAssembly = asmIds.length > 0;
        const fileBase = input.fileName?.replace(/\.ifc$/i, "") ?? null;
        assemblyName = fileBase?.replace(/[\s_-]+CFG(\s*\d+)?$/i, "").trim() || fileBase;
      }
    }

    // Group identical parts by signature (name + object type + material).
    type Bucket = {
      partNumber: string;
      description: string | null;
      qty: number;
      ifcType: string;
      partOfAssembly: boolean;
      // Aggregate physical properties across the bucket — we report the
      // per-instance value (= first one observed) since identical parts
      // share these. Sum'd at the caller if they want totals.
      weightG: number | null;
      surfaceAreaMm2: number | null;
      volumeMm3: number | null;
      material: string | null;
      densityGCm3: number | null;
      // Every express id that contributes geometry to this bucket — the
      // instance ids themselves plus the recursive decomposition children
      // (SolidWorks feature solids). Used by the client-side per-part
      // isometric renderer.
      expressIds: number[];
    };
    const buckets = new Map<string, Bucket>();

    // Counters surfaced as warnings so the user knows exactly which IFC
    // entities were skipped vs included.
    let skippedNonLblx = 0;
    let skippedCfg = 0;
    let skippedContainerAssembly = 0;

    // Build a set of "container" element ids — IFCELEMENTASSEMBLY entries
    // whose IsDecomposedBy children themselves carry LBLX-prefixed names
    // (i.e. real Lightbase parts). Those containers are sub-assemblies
    // holding the leaf BOM parts; we want to walk INTO them, not include
    // the container itself as a BOM line.
    //
    // An IFCELEMENTASSEMBLY whose children are SolidWorks feature solids
    // (named "Revolve1[2]", "Combine2", …) IS a real leaf BOM part —
    // e.g. PG9-9448K12 is modelled as an assembly of revolves internally,
    // but commercially it's one purchased component. Those stay out of
    // the container set.
    const elementIdSet = new Set(elementIds);
    // We need a quick lookup from id → cleaned partNumber to test child
    // names. Build the partNumber map first, but cheaply — just the Name
    // string, no pset lookup (which is expensive). We'll do the full
    // walk later.
    const partNumberCache = new Map<number, string>();
    for (const id of elementIds) {
      try {
        const ln = api.GetLine(modelID, id, true) as
          | { Name?: unknown; ObjectType?: unknown; Tag?: unknown }
          | undefined;
        if (!ln) continue;
        const rawName =
          stringValue(ln.Name) ?? stringValue(ln.ObjectType) ?? stringValue(ln.Tag) ?? "";
        partNumberCache.set(id, cleanPartNumber(rawName));
      } catch { /* */ }
    }
    const containerIds = new Set<number>();
    for (const id of elementIds) {
      try {
        const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy") as
          | { IsDecomposedBy?: Array<{ RelatedObjects?: Array<{ value: number }> }> }
          | undefined;
        const decomp = ln?.IsDecomposedBy;
        if (!decomp) continue;
        outer: for (const r of decomp) {
          for (const ro of r.RelatedObjects ?? []) {
            if (typeof ro?.value === "number" && elementIdSet.has(ro.value)) {
              const childPn = (partNumberCache.get(ro.value) ?? "").toUpperCase();
              if (childPn.startsWith("LBLX")) {
                containerIds.add(id);
                break outer;
              }
            }
          }
        }
      } catch { /* */ }
    }

    for (const id of elementIds) {
      let line;
      try {
        line = api.GetLine(modelID, id, true);
      } catch {
        continue;
      }
      if (!line) continue;
      const ifcType = lineTypeName(api, modelID, id);
      // PART NUMBER lives in `Name` for SolidWorks IFC exports (Tag is a
      // UUID). SolidWorks pairs the config + instance as "<config>_<instance>"
      // — we keep the instance side (everything after the LAST underscore),
      // which matches what's shown in the customer's BOM screenshot.
      const rawName =
        stringValue(line.Name) ??
        stringValue(line.ObjectType) ??
        stringValue(line.Tag) ??
        ifcType;
      const partNumber = cleanPartNumber(rawName);
      // Description starts as null — we'll pull it from a custom pset
      // (SolidWorks Custom Properties has a "DESCRIPTION " key) below.
      let description = stringValue(line.Description) ?? null;

      // FILTER — Lightbase parts only.
      //   • Skip "container" sub-assemblies (their child parts ARE the
      //     BOM lines; the parent itself isn't a real part to order).
      //   • Keep PART NUMBERs that start with "LBLX" (case-insensitive).
      //     LXLB is treated as a typo'd LBLX and accepted; cleanPartNumber
      //     normalised the prefix already.
      //   • Reject anything with "CFG" in the cleaned part number — those
      //     are config templates, not real instances.
      if (containerIds.has(id)) { skippedContainerAssembly += 1; continue; }
      const pn = partNumber.toUpperCase();
      if (pn.includes("CFG")) { skippedCfg += 1; continue; }
      if (!pn.startsWith("LBLX")) { skippedNonLblx += 1; continue; }

      // Read the IsDefinedBy psets. Returns SolidWorks custom values
      // (already in g / mm² / mm³ / g/cm³ — no unit conversion) when the
      // file uses a SolidWorks export, and Pset_BaseQuantities (SI units,
      // converted) when standard IFC. Also returns DESCRIPTION if the
      // custom pset has it.
      let psetData = readAllPsets(api, modelID, id);
      // SolidWorks IFCELEMENTASSEMBLY entries (e.g. PG9-9448K12) often
      // have no pset attached to the assembly itself — the same WEIGHT /
      // VOLUME / etc. is duplicated onto every internal feature child.
      // Fall back to the first decomposed child's pset so the assembly
      // shows the correct values.
      if (psetData.weightG == null && psetData.volumeMm3 == null && psetData.surfaceAreaMm2 == null) {
        try {
          const dec = api.GetLine(modelID, id, true, true, "IsDecomposedBy") as
            | { IsDecomposedBy?: Array<{ RelatedObjects?: Array<{ value: number }> }> }
            | undefined;
          const childId = dec?.IsDecomposedBy?.[0]?.RelatedObjects?.[0]?.value;
          if (typeof childId === "number") {
            const childData = readAllPsets(api, modelID, childId);
            // Only adopt if the child actually has measurable values.
            if (childData.weightG != null || childData.volumeMm3 != null) {
              psetData = childData;
            }
          }
        } catch { /* */ }
      }
      const weightG = psetData.weightG;
      const surfaceAreaMm2 = psetData.surfaceAreaMm2;
      const volumeMm3 = psetData.volumeMm3;
      if (!description && psetData.description) description = psetData.description;

      // Pull material associations via HasAssociations → IfcRelAssociatesMaterial.
      // Pset data takes precedence (SolidWorks puts material in a custom prop).
      const matAssoc = readMaterial(api, modelID, id);
      const material = psetData.material ?? matAssoc.material;
      const densityGCm3 = psetData.densityGCm3 ?? matAssoc.densityGCm3;

      // Derive weight if missing but volume + density are present.
      // density [g/cm³] × volume [mm³] / 1000 = grams
      const computedWeight =
        weightG ??
        (densityGCm3 != null && volumeMm3 != null
          ? densityGCm3 * volumeMm3 / 1000
          : null);

      // Group identical instances by cleaned PART NUMBER + material so a
      // bag of 12 M3 screws collapses to one line with qty=12. We ignore
      // ifcType in the signature because SolidWorks tags every part as
      // IfcBuildingElementProxy — including it would have no effect.
      // Walk this part's full decomposition tree so the per-part isometric
      // render can include feature-solid children (Revolve1, Combine2, …)
      // whose geometry is what's actually drawn for assembly-style parts
      // like PG9-9448K12.
      const ownIds: number[] = [id];
      try {
        const stack: number[] = [id];
        const seen = new Set<number>([id]);
        while (stack.length > 0) {
          const cur = stack.pop()!;
          const ln = api.GetLine(modelID, cur, true, true, "IsDecomposedBy") as
            | { IsDecomposedBy?: Array<{ RelatedObjects?: Array<{ value: number }> }> }
            | undefined;
          for (const r of ln?.IsDecomposedBy ?? []) {
            for (const ro of r.RelatedObjects ?? []) {
              if (typeof ro?.value === "number" && !seen.has(ro.value)) {
                seen.add(ro.value);
                ownIds.push(ro.value);
                stack.push(ro.value);
              }
            }
          }
        }
      } catch { /* */ }

      const sig = `${partNumber}|${material ?? ""}`;
      const partOfAssembly = assemblyChildIds.has(id);
      const existing = buckets.get(sig);
      if (existing) {
        existing.qty += 1;
        existing.partOfAssembly = existing.partOfAssembly || partOfAssembly;
        // Keep the first measurable values seen — instances are identical.
        existing.weightG ??= computedWeight;
        existing.surfaceAreaMm2 ??= surfaceAreaMm2;
        existing.volumeMm3 ??= volumeMm3;
        existing.material ??= material;
        existing.densityGCm3 ??= densityGCm3;
        existing.expressIds.push(...ownIds);
      } else {
        buckets.set(sig, {
          partNumber,
          description,
          qty: 1,
          ifcType,
          partOfAssembly,
          weightG: computedWeight,
          surfaceAreaMm2,
          volumeMm3,
          material,
          densityGCm3,
          expressIds: ownIds,
        });
      }
    }

    if (buckets.size === 0) {
      warnings.push(
        "No LBLX parts found — verify PART NUMBERs in the IFC begin with \"LBLX\".",
      );
    }
    if (skippedNonLblx > 0) {
      warnings.push(`Skipped ${skippedNonLblx} non-LBLX entit${skippedNonLblx === 1 ? "y" : "ies"}`);
    }
    if (skippedCfg > 0) {
      warnings.push(`Skipped ${skippedCfg} CFG entit${skippedCfg === 1 ? "y" : "ies"}`);
    }
    if (skippedContainerAssembly > 0) {
      warnings.push(`Skipped ${skippedContainerAssembly} container assembl${skippedContainerAssembly === 1 ? "y" : "ies"}`);
    }

    const parts: IfcPartExtract[] = Array.from(buckets.values()).sort(
      (a, b) => b.qty - a.qty || a.partNumber.localeCompare(b.partNumber),
    );

    // Inventory enrichment — for every part the IFC couldn't describe
    // (SolidWorks doesn't write a DESCRIPTION pset, so the field is null),
    // look up the inventory row by part number and pull in whatever a human
    // has already typed there ("Floor Mounted Profile", "Wall Washer Top
    // Lens", …). Same for material / density when the IFC export is
    // pset-less. We never overwrite IFC-derived values — they're the truth
    // for THIS file — only fill the gaps.
    try {
      const lookup = parts.map((p) => p.partNumber.toLowerCase());
      if (lookup.length > 0) {
        const rows = await db
          .select({
            name: inventoryItems.name,
            description: inventoryItems.description,
            material: inventoryItems.material,
            densityGCm3: inventoryItems.densityGCm3,
            weightG: inventoryItems.weightG,
            surfaceAreaMm2: inventoryItems.surfaceAreaMm2,
            volumeMm3: inventoryItems.volumeMm3,
          })
          .from(inventoryItems)
          .where(
            sql`LOWER(${inventoryItems.name}) IN (${sql.join(
              lookup.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          );
        const byName = new Map(
          rows.filter((r): r is typeof r & { name: string } => !!r.name)
            .map((r) => [r.name.toLowerCase(), r]),
        );
        for (const p of parts) {
          const inv = byName.get(p.partNumber.toLowerCase());
          if (!inv) continue;
          if (!p.description && inv.description) p.description = inv.description;
          if (!p.material && inv.material) p.material = inv.material;
          if (p.densityGCm3 == null && inv.densityGCm3 != null) p.densityGCm3 = Number(inv.densityGCm3);
          if (p.weightG == null && inv.weightG != null) p.weightG = Number(inv.weightG);
          if (p.surfaceAreaMm2 == null && inv.surfaceAreaMm2 != null) p.surfaceAreaMm2 = Number(inv.surfaceAreaMm2);
          if (p.volumeMm3 == null && inv.volumeMm3 != null) p.volumeMm3 = Number(inv.volumeMm3);
        }
      }
    } catch {
      // Inventory table may not exist yet on a fresh install — just skip
      // enrichment, the parser's IFC-only output is still valid.
    }

    return {
      isAssembly: isAssembly || parts.some((p) => p.partOfAssembly) || parts.length > 1,
      assemblyName,
      parts,
      byteSize: buf.byteLength,
      warnings,
    };
  } finally {
    api.CloseModel(modelID);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// PART NUMBER cleanup — SolidWorks exports the IFC element Name as
// "<configName>_<instanceName>" where:
//   • <configName> is the design template (uses -LXXXX-/-WXXXX- placeholders
//     and typically ends with -CFG); the user wants this DROPPED.
//   • <instanceName> is the resolved instance (real -L0186-/-W0080-/-FM
//     values) — this is what the BOM screenshot shows.
// We keep everything after the LAST underscore. If there's no underscore
// (rare; flat exports), the whole string is the part number.
// Common typo: some Lightbase part numbers ship as "LXLB-…" — we rewrite
// to "LBLX-…" so they pass the filter and de-dupe alongside their siblings.
function cleanPartNumber(raw: string): string {
  let pn = (raw ?? "").trim();
  const i = pn.lastIndexOf("_");
  if (i >= 0) pn = pn.slice(i + 1).trim();
  if (pn.toUpperCase().startsWith("LXLB")) pn = "LBLX" + pn.slice(4);
  return pn;
}

// IFC string fields arrive as { type: 1, value: "…" } objects when flat=true.
function stringValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
    const x = (v as Record<string, unknown>).value;
    if (typeof x === "string") return x.trim() || null;
    if (typeof x === "number") return String(x);
  }
  return null;
}

function numberValue(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
    const x = (v as Record<string, unknown>).value;
    if (typeof x === "number") return Number.isFinite(x) ? x : null;
    if (typeof x === "string") {
      const n = parseFloat(x);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// Look up the IFC type-name (e.g. "IFCBEAM") for a given express id.
function lineTypeName(api: { GetLineType: (m: number, id: number) => unknown }, modelID: number, id: number): string {
  try {
    const v = api.GetLineType(modelID, id);
    if (typeof v === "string") return v;
    if (typeof v === "number") return `IFC#${v}`;
  } catch {
    /* fall through */
  }
  return "IfcElement";
}

// Read ALL psets attached to an element — both IFC standard
// (Pset_BaseQuantities / IfcElementQuantity, SI units) AND custom CAD-tool
// psets ("SolidWorks Custom Properties", "Tekla_Common", etc., usually
// already in the user's preferred units).
//
// Returns the merged set. The SolidWorks custom values win when present —
// they're the ones the engineer typed into the part properties dialog, so
// they're authoritative even if the file also has computed BaseQuantities.
function readAllPsets(api: {
  GetLine: (m: number, id: number, flatten?: boolean, inverse?: boolean, inversePropKey?: string) => unknown;
}, modelID: number, id: number): {
  weightG: number | null;
  surfaceAreaMm2: number | null;
  volumeMm3: number | null;
  material: string | null;
  densityGCm3: number | null;
  description: string | null;
} {
  let weightG: number | null = null;
  let surfaceAreaMm2: number | null = null;
  let volumeMm3: number | null = null;
  let material: string | null = null;
  let densityGCm3: number | null = null;
  let description: string | null = null;

  try {
    const el = api.GetLine(modelID, id, true, true, "IsDefinedBy") as
      | {
          IsDefinedBy?: Array<{ RelatingPropertyDefinition?: unknown }>;
        }
      | undefined;
    if (!el?.IsDefinedBy) {
      return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
    }
    for (const rel of el.IsDefinedBy) {
      // The flatten=true GetLine call above leaves nested EXPRESS refs
      // un-resolved (they arrive as { value: <expressID>, type: 5 }), so
      // RelatingPropertyDefinition is just a pointer — dereference it.
      const rawDef = rel.RelatingPropertyDefinition as
        | { value?: number; type?: number }
        | Record<string, unknown>
        | undefined;
      let def: {
        Name?: unknown;
        Quantities?: Array<Record<string, unknown>>;
        HasProperties?: Array<Record<string, unknown>>;
      } | undefined;
      if (rawDef && typeof (rawDef as { value?: unknown }).value === "number"
        && (rawDef as { type?: unknown }).type === 5) {
        try {
          def = api.GetLine(modelID, (rawDef as { value: number }).value, true) as typeof def;
        } catch {
          continue;
        }
      } else if (rawDef) {
        def = rawDef as typeof def;
      }
      if (!def) continue;
      const psetName = (stringValue(def.Name) ?? "").toLowerCase();

      // Standard IFC quantity sets — SI units, convert.
      if (def.Quantities) {
        for (const q of def.Quantities) {
          const qName = (stringValue(q.Name) ?? "").trim().toLowerCase();
          if (!qName) continue;
          if (weightG == null && (qName.includes("weight") || qName.includes("mass"))) {
            const w = numberValue(q.WeightValue ?? q.LengthValue);
            if (w != null) weightG = w * 1000; // kg → g
          } else if (surfaceAreaMm2 == null && qName.includes("surface")) {
            const a = numberValue(q.AreaValue);
            if (a != null) surfaceAreaMm2 = a * 1_000_000; // m² → mm²
          } else if (volumeMm3 == null && qName.includes("volume")) {
            const v = numberValue(q.VolumeValue);
            if (v != null) volumeMm3 = v * 1_000_000_000; // m³ → mm³
          }
        }
      }

      // Custom psets (SolidWorks, Tekla, …). Values are typically already
      // in the user's units (g, mm², mm³). The SolidWorks IFC exporter
      // packages these as IfcPropertySingleValue with IFCLABEL (string)
      // values, which is why we parseFloat the string here.
      if (def.HasProperties) {
        const isSolidWorks = psetName.includes("solidworks") || psetName.includes("custom");
        for (const p of def.HasProperties) {
          const pName = (stringValue(p.Name) ?? "").trim().toLowerCase();
          if (!pName) continue;
          // String value first (IFCLABEL); fall back to numeric (IFCREAL).
          const rawStr = stringValue((p as { NominalValue?: unknown }).NominalValue);
          const rawNum = numberValue((p as { NominalValue?: unknown }).NominalValue);
          const v = rawStr ? parseFloat(rawStr.replace(/,/g, ".")) : rawNum;
          const isFinite = v != null && Number.isFinite(v);
          if (pName === "weight" || pName.includes("mass")) {
            if (isFinite && weightG == null) {
              // SolidWorks writes weights already in g (e.g. 393.72).
              // Other tools write kg — assume kg only if value < 1.
              weightG = isSolidWorks ? v : (v < 1 ? v * 1000 : v);
            }
          } else if (pName === "surface area" || pName === "surfacearea" || pName.includes("surface")) {
            if (isFinite && surfaceAreaMm2 == null) surfaceAreaMm2 = v;
          } else if (pName === "volume") {
            if (isFinite && volumeMm3 == null) volumeMm3 = v;
          } else if (pName === "density") {
            if (isFinite && densityGCm3 == null) {
              // SolidWorks density is g/cm³ already. Bigger values are kg/m³.
              densityGCm3 = v > 100 ? v / 1000 : v;
            }
          } else if (pName === "material") {
            if (!material && rawStr) material = rawStr.trim();
          } else if (pName === "description" || pName.startsWith("description")) {
            // SolidWorks uses 'DESCRIPTION ' (note trailing space).
            if (!description && rawStr) description = rawStr.trim();
          }
        }
      }
    }
  } catch {
    /* swallow — return whatever we got */
  }
  return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
}

// Inline material-name lookup as a last-resort fallback when an IFC's
// Pset_MaterialCommon is missing. Most common metals & polymers — values
// in g/cm³, sourced from standard engineering references.
const DENSITY_BY_MATERIAL: Record<string, number> = {
  steel: 7.85,
  "stainless steel": 7.9,
  "316 stainless steel": 7.95,
  "304 stainless steel": 7.9,
  aluminium: 2.7,
  aluminum: 2.7,
  brass: 8.55,
  bronze: 8.8,
  copper: 8.96,
  iron: 7.87,
  "cast iron": 7.2,
  zinc: 7.14,
  nickel: 8.9,
  titanium: 4.5,
  lead: 11.34,
  glass: 2.5,
  pvc: 1.4,
  polycarbonate: 1.2,
  abs: 1.05,
  pe: 0.95,
  pp: 0.9,
};
function densityFromMaterialName(name: string | null): number | null {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  if (DENSITY_BY_MATERIAL[key] != null) return DENSITY_BY_MATERIAL[key];
  // Loose substring match — "316 Stainless Steel Hex Drive" → "stainless steel"
  for (const [k, v] of Object.entries(DENSITY_BY_MATERIAL)) {
    if (key.includes(k)) return v;
  }
  return null;
}

function readMaterial(api: {
  GetLine: (m: number, id: number, flatten?: boolean, inverse?: boolean, inversePropKey?: string) => unknown;
}, modelID: number, id: number): { material: string | null; densityGCm3: number | null } {
  let material: string | null = null;
  let densityGCm3: number | null = null;
  try {
    const el = api.GetLine(modelID, id, true, true, "HasAssociations") as
      | { HasAssociations?: Array<{ RelatingMaterial?: unknown }> }
      | undefined;
    if (el?.HasAssociations) {
      for (const rel of el.HasAssociations) {
        const mat = rel.RelatingMaterial as
          | {
              Name?: unknown;
              Materials?: Array<{ Name?: unknown; HasProperties?: Array<Record<string, unknown>> }>;
              ForLayerSet?: { MaterialLayers?: Array<{ Material?: { Name?: unknown; HasProperties?: Array<Record<string, unknown>> } }> };
              HasProperties?: Array<Record<string, unknown>>;
            }
          | undefined;
        if (!mat) continue;
        if (mat.Name && !material) material = stringValue(mat.Name);
        // Direct material HasProperties → Pset_MaterialCommon
        if (mat.HasProperties && !densityGCm3) {
          densityGCm3 = readDensityFromProperties(mat.HasProperties);
        }
        if (mat.Materials && mat.Materials.length > 0) {
          if (!material) material = stringValue(mat.Materials[0].Name);
          if (!densityGCm3 && mat.Materials[0].HasProperties) {
            densityGCm3 = readDensityFromProperties(mat.Materials[0].HasProperties);
          }
        }
        if (mat.ForLayerSet?.MaterialLayers?.length) {
          if (!material) material = stringValue(mat.ForLayerSet.MaterialLayers[0].Material?.Name);
          if (!densityGCm3 && mat.ForLayerSet.MaterialLayers[0].Material?.HasProperties) {
            densityGCm3 = readDensityFromProperties(mat.ForLayerSet.MaterialLayers[0].Material.HasProperties);
          }
        }
      }
    }
  } catch {
    /* swallow */
  }
  // Last-resort fallback — infer density from the material name itself.
  if (!densityGCm3) densityGCm3 = densityFromMaterialName(material);
  return { material, densityGCm3 };
}

// Walks Pset_MaterialCommon-style HasProperties array for MassDensity.
// IFC density is kg/m³; we store g/cm³ for the UI (divide by 1000).
function readDensityFromProperties(props: Array<Record<string, unknown>>): number | null {
  for (const p of props) {
    const name = (stringValue(p.Name) ?? "").toLowerCase();
    if (!name) continue;
    if (name.includes("massdensity") || name === "density") {
      const v = numberValue((p as { NominalValue?: unknown }).NominalValue);
      if (v != null) {
        // Heuristic: values >100 are kg/m³, smaller are already g/cm³.
        return v > 100 ? v / 1000 : v;
      }
    }
  }
  return null;
}
