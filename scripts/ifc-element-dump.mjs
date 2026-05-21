#!/usr/bin/env node
// Dump every readable field of one IFC element so we can see what data
// is actually in the file (Description, HasAssociations material, geometry, …).

import { readFileSync } from "node:fs";
import { IfcAPI } from "web-ifc";

const path = process.argv[2];
const elementId = parseInt(process.argv[3] ?? "42", 10);
if (!path) { console.error("Usage: node scripts/ifc-element-dump.mjs <file.ifc> [expressID]"); process.exit(1); }

const bytes = readFileSync(path);
const api = new IfcAPI();
await api.Init();
const modelID = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: true });

console.log(`# element #${elementId} in ${path}`);

// Flat with no inverse
const flat = api.GetLine(modelID, elementId, true);
console.log("\n## flat:");
console.log(JSON.stringify(flat, null, 2).slice(0, 4000));

// Flat with HasAssociations
const flatAssoc = api.GetLine(modelID, elementId, true, true, "HasAssociations");
console.log("\n## HasAssociations:");
console.log(JSON.stringify(flatAssoc?.HasAssociations ?? null, null, 2).slice(0, 4000));

// Flat with IsDefinedBy
const flatDef = api.GetLine(modelID, elementId, true, true, "IsDefinedBy");
console.log("\n## IsDefinedBy:");
console.log(JSON.stringify(flatDef?.IsDefinedBy ?? null, null, 2).slice(0, 4000));

// Flat with IsDecomposedBy
const flatDec = api.GetLine(modelID, elementId, true, true, "IsDecomposedBy");
console.log("\n## IsDecomposedBy:");
console.log(JSON.stringify(flatDec?.IsDecomposedBy ?? null, null, 2).slice(0, 4000));

// Project unit assignment
console.log("\n## IfcProject + UnitAssignment:");
const projVec = api.GetLineIDsWithType(modelID, 103090709, true); // IFCPROJECT
for (let i = 0; i < projVec.size(); i++) {
  const pid = projVec.get(i);
  const proj = api.GetLine(modelID, pid, true);
  console.log(JSON.stringify(proj, null, 2).slice(0, 3000));
}

api.CloseModel(modelID);
