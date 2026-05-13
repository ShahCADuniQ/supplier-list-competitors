// Sanity test for extractDownloadButtonLinks against an iGuzzini-shaped
// HTML pattern. Run with: npx tsx scripts/trial-iguzzini-extractor.ts
//
// Verifies the new extractor recovers the row labels and section headings
// when anchor text is just "DOWNLOAD". The existing extractDocumentLinks
// returns [] on this input — that's the bug this rung fixes.

import {
  extractDocumentLinks,
  extractDownloadButtonLinks,
} from "../src/lib/ai/parsers";

const html = `
<section>
  <h2>DOCUMENTATION</h2>
  <div class="row">
    <span class="title">Specification sheet - Solo</span>
    <a href="/download/spec-solo">DOWNLOAD <svg></svg></a>
  </div>
  <div class="row">
    <span class="title">Specification sheet - Inline</span>
    <a href="/download/spec-inline">DOWNLOAD</a>
  </div>
  <div class="row">
    <span class="title">Instruction Sheet - Solo (compact profile)</span>
    <a href="/download/inst-solo-compact">DOWNLOAD</a>
  </div>
  <div class="row">
    <span class="title">Instruction Sheet - Inline (Compact Profile)</span>
    <a href="/download/inst-inline-compact">DOWNLOAD</a>
  </div>
  <div class="row">
    <span class="title">Instruction Sheet - Solo (High profile)</span>
    <a href="/download/inst-solo-high">DOWNLOAD</a>
  </div>
  <div class="row">
    <span class="title">Instruction Sheet - Inline (High Profile)</span>
    <a href="/download/inst-inline-high">DOWNLOAD</a>
  </div>
</section>
<section>
  <h2>PHOTOMETRIC DATA (.IES / .LDT / DIALUX / RELUX)</h2>
  <div class="row"><span>IES</span><a href="/download/ies-file">DOWNLOAD</a></div>
</section>
<section>
  <h2>2D/3D DRAWINGS (.DWG / .MAX)</h2>
  <div class="row"><span>2D/3D drawings (.dwg / .max)</span><a href="/download/cad-files">DOWNLOAD</a></div>
</section>
`;

const base = "https://www.iguzzini.com/us/linear-small-laser-blade-xs-pendant/";

console.log("=== extractDocumentLinks (existing rung — expected to miss) ===");
const existing = extractDocumentLinks(html, base);
console.log(`found: ${existing.length}`);
for (const d of existing) console.log(` - [${d.kind}] ${d.text} → ${d.href}`);

console.log("\n=== extractDownloadButtonLinks (new rung) ===");
const recovered = extractDownloadButtonLinks(html, base);
console.log(`found: ${recovered.length}`);
for (const d of recovered) console.log(` - [${d.kind}] ${d.text} → ${d.href}`);
