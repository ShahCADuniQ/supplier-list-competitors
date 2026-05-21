#!/usr/bin/env node
// Convert an IFC file to a structured JSON BOM extract.
// Mirrors src/app/suppliers/ifc-actions.ts but runs as a plain Node script
// and writes the result to <input>.json (or the path passed as arg 2).
//
// Usage: node scripts/ifc-to-json.mjs <file.ifc> [out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { IfcAPI } from "web-ifc";

const inputPath = process.argv[2];
const outPath = process.argv[3] ?? inputPath?.replace(/\.ifc$/i, "") + ".json";
if (!inputPath) {
  console.error("Usage: node scripts/ifc-to-json.mjs <file.ifc> [out.json]");
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
  } catch { /* */ }
  return "IfcElement";
}
function readAllPsets(api, modelID, id) {
  let weightG = null, surfaceAreaMm2 = null, volumeMm3 = null;
  let material = null, densityGCm3 = null, description = null;
  try {
    const el = api.GetLine(modelID, id, true, true, "IsDefinedBy");
    if (!el?.IsDefinedBy) return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
    for (const rel of el.IsDefinedBy) {
      const rawDef = rel.RelatingPropertyDefinition;
      let def;
      if (rawDef && typeof rawDef.value === "number" && rawDef.type === 5) {
        try { def = api.GetLine(modelID, rawDef.value, true); } catch { continue; }
      } else { def = rawDef; }
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
  } catch { /* */ }
  return { weightG, surfaceAreaMm2, volumeMm3, material, densityGCm3, description };
}

async function main() {
  process.stderr.write(`[ifc→json] loading ${inputPath}\n`);
  const t0 = Date.now();
  const bytes = readFileSync(inputPath);
  process.stderr.write(`[ifc→json] read ${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0} ms\n`);

  const api = new IfcAPI();
  await api.Init();
  const t1 = Date.now();
  const modelID = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: true });
  process.stderr.write(`[ifc→json] model opened in ${Date.now() - t1} ms\n`);

  const IFCELEMENT = 1758889154;
  const IFCELEMENTASSEMBLY = 4123344466; // IFC4 schema (web-ifc default)
  const t2 = Date.now();
  const idVec = api.GetLineIDsWithType(modelID, IFCELEMENT, true);
  const ids = [];
  for (let i = 0; i < idVec.size(); i++) ids.push(idVec.get(i));
  process.stderr.write(`[ifc→json] ${ids.length} IFCELEMENT instances in ${Date.now() - t2} ms\n`);

  // Resolve the assembly name: skip CFG-named IFCELEMENTASSEMBLY entries,
  // pick the one with the most LBLX-prefixed LEAF descendants (the true
  // root of the BOM tree — not a leaf sub-assembly like PG9-9448K12).
  let isAssembly = false;
  let assemblyName = null;
  const assemblyChildIds = new Set();
  const asmIds = [];
  try {
    const asmVec = api.GetLineIDsWithType(modelID, IFCELEMENTASSEMBLY, true);
    for (let i = 0; i < asmVec.size(); i++) asmIds.push(asmVec.get(i));
  } catch { /* */ }
  if (asmIds.length > 0) {
    const asmDirectChildren = new Map();
    for (const id of asmIds) {
      const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
      const kids = [];
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
    const asmInfo = new Map();
    for (const id of asmIds) {
      const ln = api.GetLine(modelID, id, true);
      const rawName = stringValue(ln?.Name) ?? stringValue(ln?.LongName) ?? stringValue(ln?.Tag) ?? "";
      const cleaned = cleanPartNumber(rawName);
      asmInfo.set(id, { name: rawName, cleaned, isCfg: cleaned.toUpperCase().includes("CFG") });
    }
    const asmSet = new Set(asmIds);
    function countLblxLeaves(id, seen = new Set()) {
      if (seen.has(id)) return 0;
      seen.add(id);
      const kids = asmDirectChildren.get(id) ?? [];
      let count = 0;
      for (const kid of kids) {
        if (asmSet.has(kid)) count += countLblxLeaves(kid, seen);
        else {
          const ln = api.GetLine(modelID, kid, true);
          const raw = stringValue(ln?.Name) ?? stringValue(ln?.ObjectType) ?? stringValue(ln?.Tag) ?? "";
          const pn = cleanPartNumber(raw).toUpperCase();
          if (pn.startsWith("LBLX") && !pn.includes("CFG")) count += 1;
        }
      }
      return count;
    }
    let bestId = null, bestScore = -1;
    for (const id of asmIds) {
      const info = asmInfo.get(id);
      if (!info || info.isCfg) continue;
      const score = countLblxLeaves(id);
      if (score > bestScore) { bestScore = score; bestId = id; }
    }
    if (bestId != null) {
      isAssembly = true;
      const info = asmInfo.get(bestId);
      assemblyName = info.cleaned || info.name || inputPath.replace(/\\/g, "/").split("/").pop().replace(/\.ifc$/i, "");
      process.stderr.write(`[ifc→json] assembly #${bestId} "${assemblyName}" (${bestScore} LBLX leaves, skipped ${asmIds.length - 1} candidates)\n`);
    } else {
      isAssembly = asmIds.length > 0;
      const fileBase = inputPath.replace(/\\/g, "/").split("/").pop().replace(/\.ifc$/i, "");
      assemblyName = fileBase.replace(/[\s_-]+CFG(\s*\d+)?$/i, "").trim() || fileBase;
      process.stderr.write(`[ifc→json] no non-CFG assembly found, falling back to filename "${assemblyName}"\n`);
    }
  }

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
            if (childPn.startsWith("LBLX")) { containerIds.add(id); break outer; }
          }
        }
      }
    } catch { /* */ }
  }

  const buckets = new Map();
  let skippedCfg = 0, skippedNonLblx = 0, skippedContainer = 0;
  function collectDescendantIds(rootId) {
    const ids = [rootId];
    const seen = new Set([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
      const cur = stack.pop();
      try {
        const ln = api.GetLine(modelID, cur, true, true, "IsDecomposedBy");
        for (const r of ln?.IsDecomposedBy ?? []) {
          for (const ro of r.RelatedObjects ?? []) {
            if (typeof ro?.value === "number" && !seen.has(ro.value)) {
              seen.add(ro.value);
              ids.push(ro.value);
              stack.push(ro.value);
            }
          }
        }
      } catch { /* */ }
    }
    return ids;
  }
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

    const partOfAssembly = assemblyChildIds.has(id);
    const ownIds = collectDescendantIds(id);
    const sig = `${partNumber}|${ps.material ?? ""}`;
    const existing = buckets.get(sig);
    if (existing) {
      existing.qty += 1;
      existing.partOfAssembly = existing.partOfAssembly || partOfAssembly;
      existing.weightG ??= ps.weightG;
      existing.surfaceAreaMm2 ??= ps.surfaceAreaMm2;
      existing.volumeMm3 ??= ps.volumeMm3;
      existing.material ??= ps.material;
      existing.densityGCm3 ??= ps.densityGCm3;
      existing.expressIds.push(...ownIds);
    } else {
      buckets.set(sig, {
        partNumber,
        description,
        qty: 1,
        ifcType,
        partOfAssembly,
        weightG: ps.weightG,
        surfaceAreaMm2: ps.surfaceAreaMm2,
        volumeMm3: ps.volumeMm3,
        material: ps.material,
        densityGCm3: ps.densityGCm3,
        expressIds: ownIds,
      });
    }
  }
  process.stderr.write(`[ifc→json] walked elements in ${Date.now() - t3} ms\n`);

  const parts = Array.from(buckets.values()).sort(
    (a, b) => b.qty - a.qty || a.partNumber.localeCompare(b.partNumber),
  );

  const warnings = [];
  if (parts.length === 0) warnings.push("No LBLX parts found — verify PART NUMBERs in the IFC begin with \"LBLX\".");
  if (skippedNonLblx > 0) warnings.push(`Skipped ${skippedNonLblx} non-LBLX entit${skippedNonLblx === 1 ? "y" : "ies"}`);
  if (skippedCfg > 0) warnings.push(`Skipped ${skippedCfg} CFG entit${skippedCfg === 1 ? "y" : "ies"}`);
  if (skippedContainer > 0) warnings.push(`Skipped ${skippedContainer} container assembl${skippedContainer === 1 ? "y" : "ies"}`);

  const out = {
    sourceFile: inputPath.replace(/\\/g, "/").split("/").pop(),
    byteSize: bytes.length,
    isAssembly: isAssembly || parts.some((p) => p.partOfAssembly) || parts.length > 1,
    assemblyName,
    partCount: parts.length,
    totalInstances: parts.reduce((s, p) => s + p.qty, 0),
    parts,
    warnings,
  };

  writeFileSync(outPath, JSON.stringify(out, null, 2));
  api.CloseModel(modelID);
  process.stderr.write(`[ifc→json] wrote ${outPath} (${parts.length} unique parts, ${out.totalInstances} instances)\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
