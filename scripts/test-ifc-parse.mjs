#!/usr/bin/env node
// Standalone IFC parse test — mirrors src/app/suppliers/ifc-actions.ts but
// runs as a plain Node script so we can validate extraction against a real
// IFC file before involving the dev server. Pass the .ifc path as arg 1.

import { readFileSync } from "node:fs";
import { IfcAPI } from "web-ifc";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/test-ifc-parse.mjs <file.ifc>");
  process.exit(1);
}

function stringValue(v) {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "value" in v) {
    const x = v.value;
    if (typeof x === "string") return x.trim() || null;
    if (typeof x === "number") return String(x);
  }
  return null;
}
function numberValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "value" in v) {
    const x = v.value;
    if (typeof x === "number") return Number.isFinite(x) ? x : null;
    if (typeof x === "string") {
      const n = parseFloat(x);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}
function cleanPartNumber(raw) {
  let pn = (raw ?? "").trim();
  // SolidWorks pairs the config + instance as "<config>_<instance>" where
  // BOTH halves start with LBLX or LXLB. Split at the first underscore that
  // is immediately followed by LBLX/LXLB — preserves underscores that are
  // part of the part name itself (e.g. "TOP_LENS", "FM_BRACKET").
  const m = pn.match(/_(?:LBLX|LXLB)/i);
  if (m && m.index != null) pn = pn.slice(m.index + 1).trim();
  if (pn.toUpperCase().startsWith("LXLB")) pn = "LBLX" + pn.slice(4);
  return pn;
}
function lineTypeName(api, modelID, id) {
  try {
    const v = api.GetLineType(modelID, id);
    if (typeof v === "string") return v;
    if (typeof v === "number") return `IFC#${v}`;
  } catch {
    /* */
  }
  return "IfcElement";
}
function readAllPsets(api, modelID, id) {
  let weightG = null;
  let surfaceAreaMm2 = null;
  let volumeMm3 = null;
  let material = null;
  let densityGCm3 = null;
  let description = null;
  try {
    const el = api.GetLine(modelID, id, true, true, "IsDefinedBy");
    if (!el?.IsDefinedBy) return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
    for (const rel of el.IsDefinedBy) {
      const rawDef = rel.RelatingPropertyDefinition;
      let def;
      if (rawDef && typeof rawDef.value === "number" && rawDef.type === 5) {
        try { def = api.GetLine(modelID, rawDef.value, true); } catch { continue; }
      } else {
        def = rawDef;
      }
      if (!def) continue;
      const psetName = (stringValue(def.Name) ?? "").toLowerCase();
      if (def.Quantities) {
        for (const q of def.Quantities) {
          const qName = (stringValue(q.Name) ?? "").trim().toLowerCase();
          if (!qName) continue;
          if (weightG == null && (qName.includes("weight") || qName.includes("mass"))) {
            const w = numberValue(q.WeightValue ?? q.LengthValue);
            if (w != null) weightG = w * 1000;
          } else if (surfaceAreaMm2 == null && qName.includes("surface")) {
            const a = numberValue(q.AreaValue);
            if (a != null) surfaceAreaMm2 = a * 1_000_000;
          } else if (volumeMm3 == null && qName.includes("volume")) {
            const v = numberValue(q.VolumeValue);
            if (v != null) volumeMm3 = v * 1_000_000_000;
          }
        }
      }
      if (def.HasProperties) {
        const isSolidWorks = psetName.includes("solidworks") || psetName.includes("custom");
        for (const p of def.HasProperties) {
          const pName = (stringValue(p.Name) ?? "").trim().toLowerCase();
          if (!pName) continue;
          const rawStr = stringValue(p.NominalValue);
          const rawNum = numberValue(p.NominalValue);
          const v = rawStr ? parseFloat(rawStr.replace(/,/g, ".")) : rawNum;
          const isFin = v != null && Number.isFinite(v);
          if (pName === "weight" || pName.includes("mass")) {
            if (isFin && weightG == null) weightG = isSolidWorks ? v : (v < 1 ? v * 1000 : v);
          } else if (pName === "surface area" || pName === "surfacearea" || pName.includes("surface")) {
            if (isFin && surfaceAreaMm2 == null) surfaceAreaMm2 = v;
          } else if (pName === "volume") {
            if (isFin && volumeMm3 == null) volumeMm3 = v;
          } else if (pName === "density") {
            if (isFin && densityGCm3 == null) densityGCm3 = v > 100 ? v / 1000 : v;
          } else if (pName === "material") {
            if (!material && rawStr) material = rawStr.trim();
          } else if (pName === "description" || pName.startsWith("description")) {
            if (!description && rawStr) description = rawStr.trim();
          }
        }
      }
    }
  } catch {
    /* */
  }
  return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
}

async function main() {
  console.log(`[ifc-test] loading ${path}`);
  const t0 = Date.now();
  const bytes = readFileSync(path);
  console.log(`[ifc-test] read ${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0} ms`);

  const api = new IfcAPI();
  await api.Init();
  const t1 = Date.now();
  const modelID = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: true });
  console.log(`[ifc-test] model opened in ${Date.now() - t1} ms`);

  // IFCELEMENT type code in web-ifc IFC4. (1095909175 is
  // IFCBUILDINGELEMENTPROXY — too narrow; misses IFCELEMENTASSEMBLY.)
  const IFCELEMENT = 1758889154;
  const t2 = Date.now();
  const idVec = api.GetLineIDsWithType(modelID, IFCELEMENT, true);
  const ids = [];
  for (let i = 0; i < idVec.size(); i++) ids.push(idVec.get(i));
  console.log(`[ifc-test] ${ids.length} IFCELEMENT instances in ${Date.now() - t2} ms`);

  // Quick debug: dump the first walked element + its IsDefinedBy contents
  // so we can see why psets weren't being read.
  if (ids.length > 0) {
    const dbgId = ids[0];
    const dbg = api.GetLine(modelID, dbgId, true, true, "IsDefinedBy");
    console.log("[ifc-test] DEBUG first element raw line:");
    console.log(JSON.stringify({
      expressID: dbgId,
      type: lineTypeName(api, modelID, dbgId),
      Name: dbg?.Name,
      Description: dbg?.Description,
      Tag: dbg?.Tag,
      IsDefinedByLen: Array.isArray(dbg?.IsDefinedBy) ? dbg.IsDefinedBy.length : "n/a",
      firstRel: Array.isArray(dbg?.IsDefinedBy) ? dbg.IsDefinedBy[0] : null,
    }, null, 2).slice(0, 2000));
  }

  // Detect container assemblies (parents of LBLX parts) — exclude them.
  // PG9-style assemblies whose children are SolidWorks features (non-LBLX)
  // are NOT containers and stay as leaf BOM lines.
  const elementIdSet = new Set(ids);
  const partNumberCache = new Map();
  for (const id of ids) {
    try {
      const ln = api.GetLine(modelID, id, true);
      if (!ln) continue;
      const rawName = stringValue(ln.Name) ?? stringValue(ln.ObjectType) ?? stringValue(ln.Tag) ?? "";
      partNumberCache.set(id, cleanPartNumber(rawName));
    } catch { /* */ }
  }
  const containerIds = new Set();
  for (const id of ids) {
    try {
      const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
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

  const buckets = new Map();
  let skippedCfg = 0;
  let skippedNonLblx = 0;
  let skippedContainer = 0;
  const t3 = Date.now();
  for (const id of ids) {
    let line;
    try { line = api.GetLine(modelID, id, true); } catch { continue; }
    if (!line) continue;
    const rawName = stringValue(line.Name) ?? stringValue(line.ObjectType) ?? stringValue(line.Tag) ?? "";
    const partNumber = cleanPartNumber(rawName);
    if (containerIds.has(id)) { skippedContainer += 1; continue; }
    const pn = partNumber.toUpperCase();
    if (pn.includes("CFG")) { skippedCfg += 1; continue; }
    if (!pn.startsWith("LBLX")) { skippedNonLblx += 1; continue; }

    const ifcType = lineTypeName(api, modelID, id);
    let description = stringValue(line.Description) ?? null;
    let ps = readAllPsets(api, modelID, id);
    // Assembly fallback: when the element has no pset, take the first
    // decomposed child's pset (SolidWorks copies values onto features).
    if (ps.weightG == null && ps.volumeMm3 == null && ps.surfaceAreaMm2 == null) {
      try {
        const dec = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
        const childId = dec?.IsDecomposedBy?.[0]?.RelatedObjects?.[0]?.value;
        if (typeof childId === "number") {
          const childData = readAllPsets(api, modelID, childId);
          if (childData.weightG != null || childData.volumeMm3 != null) ps = childData;
        }
      } catch { /* */ }
    }
    if (!description && ps.description) description = ps.description;

    const sig = `${partNumber}|${ps.material ?? ""}`;
    const existing = buckets.get(sig);
    if (existing) {
      existing.qty += 1;
    } else {
      buckets.set(sig, {
        partNumber,
        description,
        qty: 1,
        ifcType,
        weightG: ps.weightG,
        surfaceAreaMm2: ps.surfaceAreaMm2,
        volumeMm3: ps.volumeMm3,
        material: ps.material,
        densityGCm3: ps.densityGCm3,
      });
    }
  }
  console.log(`[ifc-test] walked elements in ${Date.now() - t3} ms`);
  console.log(`[ifc-test] kept ${buckets.size} unique parts · skipped ${skippedCfg} CFG · skipped ${skippedNonLblx} non-LBLX · skipped ${skippedContainer} container assemblies`);

  const parts = Array.from(buckets.values()).sort((a, b) =>
    b.qty - a.qty || a.partNumber.localeCompare(b.partNumber),
  );
  console.log("");
  console.log("─".repeat(140));
  console.log(
    "No.".padEnd(4),
    "PART NUMBER".padEnd(60),
    "DESCRIPTION".padEnd(20),
    "QTY".padStart(4),
    "WEIGHT".padStart(10),
    "SURFACE AREA".padStart(14),
    "VOLUME".padStart(14),
    "MATERIAL".padStart(12),
  );
  console.log("─".repeat(140));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    console.log(
      String(i + 1).padEnd(4),
      (p.partNumber ?? "").slice(0, 60).padEnd(60),
      (p.description ?? "—").slice(0, 20).padEnd(20),
      String(p.qty).padStart(4),
      (p.weightG != null ? p.weightG.toFixed(2) : "—").padStart(10),
      (p.surfaceAreaMm2 != null ? p.surfaceAreaMm2.toFixed(2) : "—").padStart(14),
      (p.volumeMm3 != null ? p.volumeMm3.toFixed(2) : "—").padStart(14),
      (p.material ?? "—").slice(0, 12).padStart(12),
    );
  }
  console.log("─".repeat(140));

  api.CloseModel(modelID);
}
main().catch((e) => { console.error(e); process.exit(1); });
