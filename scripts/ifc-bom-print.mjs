#!/usr/bin/env node
// Pretty-print the parsed JSON BOM as a table mirroring the customer's
// BOM screenshot. Reads a JSON produced by scripts/ifc-to-json.mjs.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) { console.error("Usage: node scripts/ifc-bom-print.mjs <out.json>"); process.exit(1); }

const data = JSON.parse(readFileSync(path, "utf8"));

console.log(`source       : ${data.sourceFile}`);
console.log(`assembly     : ${data.assemblyName ?? "(none)"}`);
console.log(`isAssembly   : ${data.isAssembly}`);
console.log(`partCount    : ${data.partCount}    totalInstances: ${data.totalInstances}`);
console.log(`warnings     : ${(data.warnings ?? []).join(" · ") || "—"}`);
console.log();

const cols = [
  ["#", 3, "right"],
  ["PART NUMBER", 56, "left"],
  ["QTY", 4, "right"],
  ["WEIGHT(g)", 11, "right"],
  ["SURFACE(mm²)", 14, "right"],
  ["VOLUME(mm³)", 14, "right"],
  ["MATERIAL", 30, "left"],
];
function pad(s, w, align) {
  s = String(s ?? "—");
  if (s.length > w) s = s.slice(0, w);
  if (align === "right") return s.padStart(w, " ");
  return s.padEnd(w, " ");
}
const sep = cols.map(([, w]) => "─".repeat(w)).join(" ");
console.log(cols.map(([h, w, a]) => pad(h, w, a)).join(" "));
console.log(sep);
data.parts.forEach((p, i) => {
  console.log([
    pad(i + 1, 3, "right"),
    pad(p.partNumber, 56, "left"),
    pad(p.qty, 4, "right"),
    pad(p.weightG != null ? p.weightG.toFixed(4) : "—", 11, "right"),
    pad(p.surfaceAreaMm2 != null ? p.surfaceAreaMm2.toFixed(2) : "—", 14, "right"),
    pad(p.volumeMm3 != null ? p.volumeMm3.toFixed(2) : "—", 14, "right"),
    pad(p.material ?? "—", 30, "left"),
  ].join(" "));
});
console.log(sep);
