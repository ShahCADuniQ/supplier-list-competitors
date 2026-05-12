// Verify the Perplexity product-context fallback used by aiAddProductFromInput
// when static fetch + render both yield empty text. Mirrors the helper at
// src/app/competitors/add-actions.ts → perplexityProductContext but stripped
// of server-action wrapping so we can run it from the CLI without DB access.
//
// Usage: npx tsx --env-file=.env scripts/trial-perplexity-product.ts <url>

import { hasPerplexityKey, perplexityChat } from "../src/lib/ai/perplexity";

const url = process.argv[2];
if (!url) {
  console.error(
    "Usage: npx tsx --env-file=.env scripts/trial-perplexity-product.ts <url>",
  );
  process.exit(1);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    productName: { type: "string" },
    brandName: { type: "string" },
    description: { type: "string" },
    summary: { type: "string" },
    imageUrls: { type: "array", items: { type: "string" } },
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          label: { type: "string" },
        },
        required: ["url", "label"],
      },
    },
  },
  required: [
    "productName",
    "brandName",
    "description",
    "summary",
    "imageUrls",
    "documents",
  ],
} as const;

async function main() {
  console.log(`\n=== TRIAL PERPLEXITY PRODUCT CONTEXT ===`);
  console.log(`URL: ${url}\n`);
  if (!hasPerplexityKey()) {
    console.error(
      "PPLX_API_KEY (or PERPLEXITY_API_KEY) not set. Add it to .env.",
    );
    process.exit(2);
  }

  const host = (() => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (!host) {
    console.error("Invalid URL");
    process.exit(2);
  }

  const userPrompt = `Read the product page at ${url} and return everything a lighting designer would need to know about this single product.

Be thorough — pull from the page itself AND any spec-sheet PDF / brochure linked from it. Cover at minimum:
  - Brand and product name (exactly as the brand prints it)
  - Product category (e.g. "linear pendant", "recessed downlight", "wall sconce")
  - 1–2 sentence description plus a longer multi-paragraph summary
  - Geometry, photometry, electrical, mounting, lens, finishes, IP/IK, lifespan, warranty, certifications
  - Customisation + accessories
  - Direct https:// image URLs (product photography on the brand's site / CDN)
  - Direct download URLs for spec sheets, IES files, CAD drawings, BIM, brochures, install guides

Return ONLY valid JSON matching the schema. URLs MUST be absolute https://. Do not invent values — leave fields empty if the page does not state them.`;

  const t0 = Date.now();
  const r = await perplexityChat<{
    productName: string;
    brandName: string;
    description: string;
    summary: string;
    imageUrls: string[];
    documents: Array<{ url: string; label: string }>;
  }>({
    systemPrompt:
      "You read product pages on lighting-manufacturer websites and return exhaustive structured data. Always return only valid JSON matching the requested schema.",
    userPrompt,
    schema: SCHEMA,
    schemaName: "product_page_context",
    searchDomains: [host],
    maxTokens: 4000,
  });
  const ms = Date.now() - t0;

  console.log(`Perplexity returned in ${ms}ms\n`);
  console.log(`brand:       ${r.content.brandName || "(empty)"}`);
  console.log(`product:     ${r.content.productName || "(empty)"}`);
  console.log(
    `description: ${(r.content.description || "(empty)").slice(0, 200)}`,
  );
  console.log(`summary len: ${r.content.summary?.length ?? 0}`);
  console.log(`images:      ${r.content.imageUrls?.length ?? 0}`);
  for (const u of (r.content.imageUrls ?? []).slice(0, 5)) {
    console.log(`   ${u}`);
  }
  console.log(`documents:   ${r.content.documents?.length ?? 0}`);
  for (const d of (r.content.documents ?? []).slice(0, 8)) {
    console.log(`   [${(d.label || "(unlabeled)").slice(0, 60)}] ${d.url}`);
  }
  console.log(`citations:   ${r.citations.length}`);
  for (const c of r.citations.slice(0, 5)) {
    console.log(`   ${c}`);
  }
  console.log(`\n=== Done in ${ms}ms ===`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
