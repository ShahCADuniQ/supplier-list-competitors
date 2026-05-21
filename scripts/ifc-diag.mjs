#!/usr/bin/env node
// Diagnostic walk over an IFC. Lists every IFCELEMENTASSEMBLY + IFCELEMENT
// with cleaned part number, container status, pset weight, and decomposition
// children so we can see why parts are being dropped.

import { readFileSync } from "node:fs";
import { IfcAPI } from "web-ifc";

const path = process.argv[2];
if (!path) { console.error("Usage: node scripts/ifc-diag.mjs <file.ifc>"); process.exit(1); }

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

async function main() {
  const bytes = readFileSync(path);
  console.log(`# ${path}  (${(bytes.length/1024/1024).toFixed(1)} MB)`);

  const api = new IfcAPI();
  await api.Init();
  const modelID = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: true });

  const IFCELEMENT = 1758889154;
  const IFCELEMENTASSEMBLY = 2237359047;

  // ── assemblies ──────────────────────────────────────────────
  const asmVec = api.GetLineIDsWithType(modelID, IFCELEMENTASSEMBLY, true);
  console.log(`\n## IFCELEMENTASSEMBLY (${asmVec.size()})`);
  const asmIds = [];
  for (let i = 0; i < asmVec.size(); i++) asmIds.push(asmVec.get(i));
  for (const id of asmIds) {
    const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
    const rawName = stringValue(ln?.Name) ?? "";
    const cleaned = cleanPartNumber(rawName);
    const upper = cleaned.toUpperCase();
    const hasCfg = upper.includes("CFG");
    const startsLBLX = upper.startsWith("LBLX");
    const childCount = (ln?.IsDecomposedBy ?? [])
      .reduce((s, r) => s + (r.RelatedObjects?.length ?? 0), 0);
    console.log(`  #${id}  CFG=${hasCfg?"Y":"·"} LBLX=${startsLBLX?"Y":"·"}  kids=${childCount}  raw="${rawName}"  cleaned="${cleaned}"`);
  }

  // ── elements ────────────────────────────────────────────────
  const elVec = api.GetLineIDsWithType(modelID, IFCELEMENT, true);
  const elIds = [];
  for (let i = 0; i < elVec.size(); i++) elIds.push(elVec.get(i));
  console.log(`\n## IFCELEMENT (${elIds.length})`);

  // partnumber cache
  const pnCache = new Map();
  for (const id of elIds) {
    try {
      const ln = api.GetLine(modelID, id, true);
      const rawName = stringValue(ln?.Name) ?? stringValue(ln?.ObjectType) ?? stringValue(ln?.Tag) ?? "";
      pnCache.set(id, { raw: rawName, cleaned: cleanPartNumber(rawName) });
    } catch { /* */ }
  }
  const elementIdSet = new Set(elIds);
  const containerIds = new Set();
  for (const id of elIds) {
    try {
      const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
      const decomp = ln?.IsDecomposedBy;
      if (!decomp) continue;
      outer: for (const r of decomp) {
        for (const ro of r.RelatedObjects ?? []) {
          if (typeof ro?.value === "number" && elementIdSet.has(ro.value)) {
            const childPn = (pnCache.get(ro.value)?.cleaned ?? "").toUpperCase();
            if (childPn.startsWith("LBLX")) { containerIds.add(id); break outer; }
          }
        }
      }
    } catch { /* */ }
  }

  let skippedCfg=0, skippedNonLblx=0, skippedContainer=0, kept=0;
  const rows = [];
  for (const id of elIds) {
    const meta = pnCache.get(id) ?? { raw: "", cleaned: "" };
    const cleaned = meta.cleaned;
    const upper = cleaned.toUpperCase();
    const ifcType = lineTypeName(api, modelID, id);
    const isContainer = containerIds.has(id);
    let bucket = "KEEP";
    if (isContainer) { bucket = "SKIP container"; skippedContainer++; }
    else if (upper.includes("CFG")) { bucket = "SKIP CFG"; skippedCfg++; }
    else if (!upper.startsWith("LBLX")) { bucket = "SKIP nonLBLX"; skippedNonLblx++; }
    else { kept++; }
    rows.push({ id, ifcType, raw: meta.raw, cleaned, bucket });
  }
  console.log(`# kept=${kept} skipCFG=${skippedCfg} skipNonLBLX=${skippedNonLblx} skipContainer=${skippedContainer}`);
  // Show first 80 elements (or all if < 80)
  for (const r of rows.slice(0, 80)) {
    console.log(`  #${r.id}  ${r.bucket.padEnd(15)}  ${r.ifcType.padEnd(14)}  raw="${(r.raw||"").slice(0,80)}"  pn="${r.cleaned.slice(0,60)}"`);
  }
  if (rows.length > 80) console.log(`  … (+${rows.length-80} more rows)`);

  // ── decomposition tree for top-level assembly ──────────────
  // Find the LBLX root assembly (not CFG)
  const lblxRootAsm = asmIds.find((id) => {
    const ln = api.GetLine(modelID, id, true);
    const cl = cleanPartNumber(stringValue(ln?.Name) ?? "").toUpperCase();
    return cl.startsWith("LBLX") && !cl.includes("CFG");
  });
  if (lblxRootAsm) {
    console.log(`\n## tree from non-CFG LBLX root assembly #${lblxRootAsm}`);
    const visited = new Set();
    function walk(id, depth=0) {
      if (visited.has(id) || depth > 6) return;
      visited.add(id);
      const ln = api.GetLine(modelID, id, true, true, "IsDecomposedBy");
      const ifcType = lineTypeName(api, modelID, id);
      const rawName = stringValue(ln?.Name) ?? "";
      const cleaned = cleanPartNumber(rawName);
      console.log(`${"  ".repeat(depth)}#${id} ${ifcType} "${cleaned.slice(0,60)}"`);
      const decomp = ln?.IsDecomposedBy;
      if (!decomp) return;
      for (const r of decomp) {
        for (const ro of r.RelatedObjects ?? []) {
          if (typeof ro?.value === "number") walk(ro.value, depth+1);
        }
      }
    }
    walk(lblxRootAsm);
  } else {
    console.log(`\n## NO non-CFG LBLX root assembly found`);
  }

  api.CloseModel(modelID);
}
main().catch((e)=>{ console.error(e); process.exit(1); });
