// One-off: ingest the Axis Beam 2 Pendant product end-to-end.
//
// Mirrors aiAddProductFromInput but bypasses the Clerk auth check so it
// can run from a CLI. After inserting the brand + product, calls
// aiExtractProductFiles' download path to attach every spec sheet,
// brochure, and install instruction the page links to.
//
// Usage:
//   npx tsx --env-file=.env scripts/add-axis-beam2.ts [collectionId]
// If collectionId is omitted, lists the available collections so the
// caller can pick one.

import { neon } from "@neondatabase/serverless";
import {
  fetchUrlFully,
  extractImageUrls,
  extractDocumentLinks,
} from "../src/lib/ai/parsers";
import { renderPageHtml } from "../src/lib/ai/render";
import { put } from "@vercel/blob";
import OpenAI from "openai";
import crypto from "node:crypto";

const PRODUCT_URL = "https://www.axislighting.com/products/beam-2-pendant";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

const PRODUCT_SPECS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimensions: { type: "string" },
    maxLength: { type: "string" },
    length: { type: "string" },
    profileFaceSize: { type: "string" },
    cutout: { type: "string" },
    weight: { type: "string" },
    lumens: { type: "string" },
    wattage: { type: "string" },
    efficacy: { type: "string" },
    cct: { type: "string" },
    cri: { type: "string" },
    r9: { type: "string" },
    sdcm: { type: "string" },
    beamAngle: { type: "string" },
    opticType: { type: "string" },
    ugr: { type: "string" },
    voltage: { type: "string" },
    powerFactor: { type: "string" },
    inrushCurrent: { type: "string" },
    driverLocation: { type: "string" },
    driverType: { type: "string" },
    dimming: { type: "string" },
    mounting: { type: "string" },
    orientation: { type: "string" },
    lensType: { type: "string" },
    housingMaterial: { type: "string" },
    finishes: { type: "array", items: { type: "string" } },
    colors: { type: "array", items: { type: "string" } },
    ipRating: { type: "string" },
    ikRating: { type: "string" },
    operatingTemp: { type: "string" },
    lifespan: { type: "string" },
    warranty: { type: "string" },
    countryOfOrigin: { type: "string" },
    certifications: { type: "array", items: { type: "string" } },
    customization: { type: "array", items: { type: "string" } },
    accessories: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: [
    "dimensions","maxLength","length","profileFaceSize","cutout","weight",
    "lumens","wattage","efficacy","cct","cri","r9","sdcm","beamAngle",
    "opticType","ugr","voltage","powerFactor","inrushCurrent","driverLocation",
    "driverType","dimming","mounting","orientation","lensType","housingMaterial",
    "finishes","colors","ipRating","ikRating","operatingTemp","lifespan",
    "warranty","countryOfOrigin","certifications","customization","accessories",
    "notes",
  ],
};

const ADD_PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brand: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        website: { type: "string" },
        parent: { type: "string" },
        country: { type: "string" },
        tierKey: { type: "string", enum: ["mass", "mid", "spec", "premium"] },
        notes: { type: "string" },
      },
      required: ["name", "website", "parent", "country", "tierKey", "notes"],
    },
    product: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        productCode: { type: "string" },
        productCategory: { type: "string" },
        description: { type: "string" },
        sourceUrl: { type: "string" },
        imageUrls: { type: "array", items: { type: "string" } },
        specs: PRODUCT_SPECS_SCHEMA,
      },
      required: [
        "name","productCode","productCategory","description","sourceUrl",
        "imageUrls","specs",
      ],
    },
  },
  required: ["brand", "product"],
};

async function main() {
  const cidArg = process.argv[2];

  if (!cidArg) {
    const rows = (await sql.query(
      `SELECT id, name FROM competitor_collections ORDER BY id`,
    )) as Array<{ id: number; name: string }>;
    console.log("Available collections:");
    for (const r of rows) console.log(`  ${r.id}: ${r.name}`);
    console.log(`\nRe-run with: npx tsx --env-file=.env scripts/add-axis-beam2.ts <id>`);
    return;
  }

  const collectionId = parseInt(cidArg, 10);
  if (!Number.isFinite(collectionId)) {
    console.error(`Invalid collectionId: ${cidArg}`);
    process.exit(1);
  }

  const collRows = (await sql.query(
    `SELECT id, name FROM competitor_collections WHERE id = $1`,
    [collectionId],
  )) as Array<{ id: number; name: string }>;
  if (collRows.length === 0) {
    console.error(`Collection ${collectionId} not found.`);
    process.exit(1);
  }
  const collection = collRows[0];
  console.log(`Target collection: #${collection.id} "${collection.name}"\n`);

  // ── 1. Fetch the product page (will retry past Cloudflare) ──
  console.log(`[1/5] Fetching ${PRODUCT_URL} …`);
  let html = "";
  let text = "";
  try {
    const r = await fetchUrlFully(PRODUCT_URL);
    html = r.html;
    text = r.text;
  } catch (e) {
    console.warn(`  static fetch failed: ${e instanceof Error ? e.message : e}`);
  }
  if (!text || text.length < 200) {
    console.log(`  static body short — falling back to headless render`);
    const rendered = await renderPageHtml(PRODUCT_URL, {
      waitUntil: "networkidle",
      timeoutMs: 25_000,
      blockResources: true,
      scrollPasses: 3,
      clickToReveal: true,
    });
    if (!rendered.html) {
      console.error("  render returned empty html — aborting");
      process.exit(1);
    }
    html = rendered.html;
    text = rendered.html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60_000);
  }
  console.log(`  ✓ html=${html.length} text=${text.length}`);

  // ── 2. Send to OpenAI with the same schema the app uses ──
  console.log(`\n[2/5] Asking OpenAI to identify brand + product …`);
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey: openaiKey });

  const systemPrompt = `You are identifying a single lighting product the user is researching, plus the brand that makes it.

Your output is JSON: { "brand": {...}, "product": {...} }.

Brand: name, website (homepage URL), parent (or ""), country (e.g. "USA (NY)" or "Canada"), tierKey (mass|mid|spec|premium), notes (1-2 sentence positioning).
Product: name, productCode (SKU if printed), productCategory (e.g. "Linear Pendant"), description (1-2 sentences), sourceUrl, imageUrls (absolute URLs visible on the page), specs (fill every field the source actually states; empty string is fine when not stated).

Niche hint: "Linear lighting" — used to interpret ambiguous text but do NOT exclude the product.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-2024-08-06",
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `URL: ${PRODUCT_URL}\n\nPAGE TEXT:\n${text}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "add_product_extraction",
        strict: true,
        schema: ADD_PRODUCT_SCHEMA,
      },
    },
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) {
    console.error("OpenAI returned no content");
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  console.log(`  ✓ brand="${parsed.brand.name}" product="${parsed.product.name}"`);

  // ── 3. Look up or create the brand ──
  console.log(`\n[3/5] Persisting brand …`);
  const existing = (await sql.query(
    `SELECT id, name, website, country, notes FROM competitors
       WHERE collection_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [collectionId, parsed.brand.name],
  )) as Array<{
    id: number;
    name: string;
    website: string | null;
    country: string | null;
    notes: string | null;
  }>;

  let brandId: number;
  let brandName: string;
  let brandCreated = false;
  if (existing.length > 0) {
    brandId = existing[0].id;
    brandName = existing[0].name;
    console.log(`  ↻ brand exists: #${brandId} "${brandName}"`);
  } else {
    const inserted = (await sql.query(
      `INSERT INTO competitors (collection_id, name, website, parent, tier_key, country, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name`,
      [
        collectionId,
        parsed.brand.name,
        parsed.brand.website || null,
        parsed.brand.parent || null,
        parsed.brand.tierKey,
        parsed.brand.country || null,
        parsed.brand.notes || null,
      ],
    )) as Array<{ id: number; name: string }>;
    brandId = inserted[0].id;
    brandName = inserted[0].name;
    brandCreated = true;
    console.log(`  + created brand #${brandId} "${brandName}"`);
  }

  // ── 4. Persist the product ──
  console.log(`\n[4/5] Persisting product …`);
  let imageUrls: string[] = (parsed.product.imageUrls ?? [])
    .map((u: string) => (typeof u === "string" ? u.trim() : ""))
    .filter((u: string) => /^https?:\/\//i.test(u));
  if (imageUrls.length === 0) {
    imageUrls = extractImageUrls(html, PRODUCT_URL);
  }

  const productInserted = (await sql.query(
    `INSERT INTO competitor_products
       (competitor_id, name, product_code, product_category, description,
        source_url, image_urls, specs)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb)
       RETURNING id, name`,
    [
      brandId,
      parsed.product.name?.trim() || "Untitled product",
      parsed.product.productCode || null,
      parsed.product.productCategory || null,
      parsed.product.description || null,
      parsed.product.sourceUrl || PRODUCT_URL,
      imageUrls,
      JSON.stringify(parsed.product.specs ?? {}),
    ],
  )) as Array<{ id: number; name: string }>;
  const productId = productInserted[0].id;
  const productName = productInserted[0].name;
  console.log(`  + product #${productId} "${productName}" with ${imageUrls.length} image(s)`);

  // ── 5. Download every linked PDF and persist to Vercel Blob ──
  console.log(`\n[5/5] Downloading + persisting linked documents …`);
  const docLinks = extractDocumentLinks(html, PRODUCT_URL);
  console.log(`  found ${docLinks.length} unique document URLs in the page`);

  let attached = 0;
  let skipped = 0;
  for (const d of docLinks) {
    try {
      const ok = await downloadAndAttach(productId, d.href, d.text);
      if (ok) attached++; else skipped++;
    } catch (e) {
      console.warn(`  ✗ ${d.href}: ${e instanceof Error ? e.message : e}`);
      skipped++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  brandCreated: ${brandCreated}`);
  console.log(`  brandId:      ${brandId}`);
  console.log(`  brandName:    ${brandName}`);
  console.log(`  productId:    ${productId}`);
  console.log(`  productName:  ${productName}`);
  console.log(`  imageUrls:    ${imageUrls.length}`);
  console.log(`  attachments:  ${attached} attached, ${skipped} skipped`);
  console.log(
    `\nView at: /competitors  →  collection "${collection.name}" → "${brandName}" → "${productName}"`,
  );
}

const MAX_BYTES = 25 * 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function classifyKind(url: string, label: string): {
  kind: string;
  mime: string;
} {
  const path = url.toLowerCase().split("?")[0];
  const lbl = label.toLowerCase();
  const hay = `${path} ${lbl}`;
  if (path.endsWith(".ies") || path.endsWith(".ldt"))
    return { kind: "ies-photometric", mime: "text/plain" };
  if (path.endsWith(".dwg") || path.endsWith(".dxf") || /\b(dwg|dxf|cad)\b/.test(hay))
    return { kind: "cad-drawing", mime: "application/octet-stream" };
  if (path.endsWith(".rfa") || path.endsWith(".rvt") || /\b(rfa|revit|bim)\b/.test(hay))
    return { kind: "bim-revit", mime: "application/octet-stream" };
  if (path.endsWith(".pdf") || path.endsWith(".pdf?")) {
    if (/\b(install|installation|mount)\b/.test(hay))
      return { kind: "installation", mime: "application/pdf" };
    if (/\b(brochure|catalog(ue)?|family|portfolio)\b/.test(hay))
      return { kind: "brochure", mime: "application/pdf" };
    if (/\b(warranty)\b/.test(hay))
      return { kind: "warranty", mime: "application/pdf" };
    if (/\b(manual|user[\s-]?guide)\b/.test(hay))
      return { kind: "manual", mime: "application/pdf" };
    if (/\b(integrated[_\s-]?controls|control)\b/.test(hay))
      return { kind: "manual", mime: "application/pdf" };
    return { kind: "spec-sheet", mime: "application/pdf" };
  }
  return { kind: "other", mime: "application/octet-stream" };
}

function safeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

async function downloadAndAttach(
  productId: number,
  fileUrl: string,
  label: string,
): Promise<boolean> {
  const u = fileUrl.trim();
  if (!/^https?:\/\//i.test(u)) return false;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/pdf,application/octet-stream,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: new URL(u).origin + "/",
      },
    });
  } catch (e) {
    console.warn(`  ✗ network error: ${u}`);
    clearTimeout(t);
    return false;
  }
  clearTimeout(t);

  if (!res.ok) {
    console.warn(`  ✗ HTTP ${res.status}: ${u}`);
    return false;
  }
  let contentType = res.headers.get("content-type") ?? "";
  const lengthHeader = Number(res.headers.get("content-length") ?? "0");
  if (lengthHeader && lengthHeader > MAX_BYTES) {
    console.warn(`  ✗ too large (${lengthHeader}B): ${u}`);
    return false;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    console.warn(`  ✗ empty or oversize: ${u}`);
    return false;
  }
  // HTML returned for a doc URL — only keep if first 4 bytes are "%PDF".
  if (
    /\.pdf(\?|$)/i.test(u) &&
    contentType.toLowerCase().includes("text/html")
  ) {
    const head4 = String.fromCharCode(...buf.slice(0, 4));
    if (head4 !== "%PDF") {
      console.warn(`  ✗ HTML returned for PDF URL: ${u}`);
      return false;
    }
    contentType = "application/pdf";
  }

  const { kind, mime } = classifyKind(u, label);
  const last = u.split("?")[0].split("#")[0].split("/").pop() ?? "document";
  const safe = safeFileName(last);
  const finalName = /\.[a-z0-9]{2,5}$/i.test(safe)
    ? safe
    : `${safe}.pdf`;
  const pathname = `competitors/products/${productId}/${crypto.randomUUID()}-${finalName}`;
  const blob = await put(pathname, Buffer.from(buf), {
    access: "public",
    contentType: mime || contentType || "application/octet-stream",
  });
  await sql.query(
    `INSERT INTO competitor_product_attachments
       (product_id, name, size, mime_type, kind, url, blob_pathname)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      productId,
      finalName,
      lengthHeader || buf.length,
      mime || contentType || null,
      kind,
      blob.url,
      blob.pathname,
    ],
  );
  console.log(`  + [${kind}] ${finalName} (${(buf.length / 1024).toFixed(1)} KB)`);
  return true;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
