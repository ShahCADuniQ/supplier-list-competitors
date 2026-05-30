// One-off ingestion of the Antron AM49 constant-current LED driver family
// from https://antron.com.tw/product/current-current-led-driver-9w-36w-am49/.
//
// • Creates the "Antron Electronics" supplier if it doesn't exist.
// • Inserts a parent supplier_products row "Constant Current LED Driver
//   9W-36W AM49" with the shared features + dimensions in `description`
//   and `notes`.
// • Inserts 11 configuration rows (one per SKU on the spec table)
//   nested under the parent via parent_product_id.
// • Downloads each configuration's spec-sheet PDF from the WordPress
//   protected-attachment endpoint, uploads it to Vercel Blob, and
//   inserts a supplier_product_attachments row with category =
//   'spec_datasheet' so it shows under "Specifications & Datasheet" in
//   the supplier inventory drawer.
// • Downloads the family's main product images (the og:image variants),
//   uploads them to Blob, attaches them to the PARENT row as
//   'photo_media', and promotes the first one to thumbnailUrl so the
//   catalog card has a hero shot.
//
// Idempotency: if the supplier already exists we reuse it. If the
// parent product with the same (supplier_id, name) already exists we
// abort with a clear message — re-run after deleting the parent if
// you want to overwrite. The script intentionally does NOT update
// existing rows so a partial re-run can't silently mutate fields.
//
// Usage:
//   npx tsx --env-file=.env scripts/add-antron-am49.ts [--dry-run]
//
// Env required: DATABASE_URL, BLOB_READ_WRITE_TOKEN.

import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";
import crypto from "node:crypto";

const PRODUCT_URL =
  "https://antron.com.tw/product/current-current-led-driver-9w-36w-am49/";

const SUPPLIER_NAME = "Antron Electronics";
const PARENT_PRODUCT_NAME = "Constant Current LED Driver 9W-36W AM49";
const PRODUCT_CATEGORY = "LED Driver";

const SUPPLIER_INFO = {
  category: "Drivers & Power Supplies",
  subCategory: null as string | null,
  origin: "Taiwan",
  website: "https://antron.com.tw",
  email: "info@antron.com.tw",
  phone: "+886-6-726-3906",
  contactName: null as string | null,
  notes:
    "OEM/ODM/OBM manufacturer of LED drivers, emergency LED drivers, and ballasts. Address: No.17-14 Lai-Kan Liaw, Hi-Chien Li, Jiali District, Tainan City, Taiwan 722012. Fax: +886-6-726-3908.",
};

// 11 configurations from the product-page spec table.
type Config = {
  productCode: string;
  inputVoltage: string;
  outputPowerW: string;
  outputCurrentMa: string;
  outputVoltage: string;
  efficiency: string;
  // The WordPress download URL for this configuration's spec sheet PDF.
  specUrl: string;
};

const CONFIGURATIONS: Config[] = [
  { productCode: "AC450S9D",   inputVoltage: "120-277Vac", outputPowerW: "9W",  outputCurrentMa: "450mA",  outputVoltage: "12-20V", efficiency: "85%",
    specUrl: `${PRODUCT_URL}?attachment_id=65027&download_file=6jez33kv6yrag` },
  { productCode: "AC440S15D",  inputVoltage: "120-277Vac", outputPowerW: "15W", outputCurrentMa: "440mA",  outputVoltage: "19-34V", efficiency: "85%",
    specUrl: `${PRODUCT_URL}?attachment_id=65025&download_file=30absffyzou3k` },
  { productCode: "AC1400S21D", inputVoltage: "120-277Vac", outputPowerW: "21W", outputCurrentMa: "1400mA", outputVoltage: "9-15V",  efficiency: "86%",
    specUrl: `${PRODUCT_URL}?attachment_id=65037&download_file=onjgy84pkqqsb` },
  { productCode: "AC1150S23D", inputVoltage: "120-277Vac", outputPowerW: "23W", outputCurrentMa: "1150mA", outputVoltage: "12-20V", efficiency: "86%",
    specUrl: `${PRODUCT_URL}?attachment_id=65035&download_file=vkwpafy8gz2fb` },
  { productCode: "AC620S25D",  inputVoltage: "120-277Vac", outputPowerW: "25W", outputCurrentMa: "620mA",  outputVoltage: "24-41V", efficiency: "87%",
    specUrl: `${PRODUCT_URL}?attachment_id=65029&download_file=ymiuhyzdyn8jg` },
  { productCode: "AC1050S25D", inputVoltage: "120-277Vac", outputPowerW: "25W", outputCurrentMa: "1050mA", outputVoltage: "14-24V", efficiency: "87%",
    specUrl: `${PRODUCT_URL}?attachment_id=65031&download_file=mbb3zngcm86q5` },
  { productCode: "AC1050S32D", inputVoltage: "120-277Vac", outputPowerW: "32W", outputCurrentMa: "1050mA", outputVoltage: "18-30V", efficiency: "87%",
    specUrl: `${PRODUCT_URL}?attachment_id=65033&download_file=l4q8ja12xkq5t` },
  { productCode: "AC1800S36D", inputVoltage: "120-277Vac", outputPowerW: "36W", outputCurrentMa: "1800mA", outputVoltage: "12-20V", efficiency: "87%",
    specUrl: `${PRODUCT_URL}?attachment_id=65039&download_file=nmvx5aroww8mq` },
  { productCode: "3C450S9D",   inputVoltage: "347Vac",     outputPowerW: "9W",  outputCurrentMa: "450mA",  outputVoltage: "12-20V", efficiency: "85%",
    specUrl: `${PRODUCT_URL}?attachment_id=65041&download_file=2m96vwiao6lxh` },
  { productCode: "3C900S18D",  inputVoltage: "347Vac",     outputPowerW: "18W", outputCurrentMa: "900mA",  outputVoltage: "12-20V", efficiency: "86%",
    specUrl: `${PRODUCT_URL}?attachment_id=65043&download_file=8iw5pkandxgfr` },
  { productCode: "3C1800S36D", inputVoltage: "347Vac",     outputPowerW: "36W", outputCurrentMa: "1800mA", outputVoltage: "12-20V", efficiency: "87%",
    specUrl: `${PRODUCT_URL}?attachment_id=65023&download_file=i127hfw09p2e2` },
];

// Main product images extracted from the product page. The og:image is
// AC440S15D-AM198 (used as the family hero); we also pull the
// 1050S40 variant photo + 1050S12M variant photo so the gallery has
// alternate angles. All three are 1000x1000 master JPEGs hosted on
// antron.com.tw's wp-content directory.
const PRODUCT_IMAGES: { url: string; label: string }[] = [
  { url: "https://antron.com.tw/wp-content/uploads/2026/05/AC440S15D-AM198.jpg",      label: "AC440S15D AM198 photo" },
  { url: "https://antron.com.tw/wp-content/uploads/2020/02/AC1050S40_AM188_rev_N-1-A.jpg", label: "AC1050S40 AM188 photo" },
  { url: "https://antron.com.tw/wp-content/uploads/2020/02/AC1050S12M_AM122_N-A.jpg", label: "AC1050S12M AM122 photo" },
  { url: "https://antron.com.tw/wp-content/uploads/2022/01/LED-DriverIP65-調光-1通道.png", label: "Wire diagram (3-in-1 dimming)" },
];

const PARENT_DESCRIPTION = [
  "Universal-input constant-current LED driver, 9–36W output range, case AM49.",
  "L: 15.8 cm × W: 4.4 cm × H: 3.1 cm.",
  "Features: PFC, flicker-free, isolated design. 3-in-1 dimming (PWM, 0-10V, resistance) down to 1%. Open/short/over-voltage/over-temp protection. 2-4 kV surge protection. UL dry & damp location. 5 year warranty.",
  "Source: " + PRODUCT_URL,
].join("\n\n");

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAX_BYTES = 25 * 1024 * 1024;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN not set");
  process.exit(1);
}
const sql = neon(url);

const DRY_RUN = process.argv.includes("--dry-run");

function configName(c: Config): string {
  return `${PARENT_PRODUCT_NAME} — ${c.productCode} (${c.outputPowerW}, ${c.inputVoltage})`;
}

function configDescription(c: Config): string {
  return [
    `Model: ${c.productCode}`,
    `Input voltage: ${c.inputVoltage}`,
    `Output power: ${c.outputPowerW}`,
    `Output current: ${c.outputCurrentMa}`,
    `Output voltage: ${c.outputVoltage}`,
    `Efficiency: ${c.efficiency}`,
    "Part of the AM49 constant-current LED driver family.",
  ].join("\n");
}

async function fetchBinary(fileUrl: string): Promise<{
  buf: Uint8Array;
  contentType: string;
} | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(fileUrl, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/pdf,application/octet-stream,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: new URL(fileUrl).origin + "/",
      },
    });
    if (!res.ok) {
      console.warn(`    ✗ HTTP ${res.status}: ${fileUrl}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      console.warn(`    ✗ empty or oversize (${buf.length}B): ${fileUrl}`);
      return null;
    }
    return { buf, contentType };
  } catch (e) {
    console.warn(`    ✗ network error: ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function safeFileName(s: string, fallback: string): string {
  const cleaned = (s || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

async function uploadToBlob(input: {
  buf: Uint8Array;
  contentType: string;
  pathnamePrefix: string;
  filename: string;
}): Promise<{ url: string; pathname: string }> {
  const pathname = `${input.pathnamePrefix}/${crypto.randomUUID()}-${input.filename}`;
  const blob = await put(pathname, Buffer.from(input.buf), {
    access: "public",
    contentType: input.contentType,
  });
  return { url: blob.url, pathname: blob.pathname };
}

async function ensureSupplierSchema(): Promise<void> {
  // Self-heal the supplier_products + supplier_product_attachments tables
  // in case the deployment hasn't run the corresponding migration.
  // Mirrors _ensure-supplier-inventory-schema.ts (just the bits we need).
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "supplier_products" (
      "id" serial PRIMARY KEY,
      "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "product_code" text,
      "description" text,
      "category" text,
      "notes" text,
      "thumbnail_url" text,
      "thumbnail_pathname" text,
      "archived" boolean NOT NULL DEFAULT false,
      "created_by_role" text NOT NULL DEFAULT 'lightbase',
      "created_by_clerk_id" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "parent_product_id" integer,
      "global_product_id" text,
      "is_primary_supplier" boolean NOT NULL DEFAULT true
    )`);
  await sql.query(`
    DO $$ BEGIN
      CREATE TYPE "supplier_product_attachment_category" AS ENUM (
        'spec_datasheet','quote_pricing','contract_nda',
        'certification_compliance','test_report_qc','photo_media',
        'ies_file','drawing','other_file'
      );
    EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "supplier_product_attachments" (
      "id" serial PRIMARY KEY,
      "product_id" integer NOT NULL REFERENCES "supplier_products"("id") ON DELETE CASCADE,
      "category" "supplier_product_attachment_category" NOT NULL,
      "name" text NOT NULL,
      "url" text NOT NULL,
      "blob_pathname" text,
      "content_type" text,
      "size" bigint NOT NULL DEFAULT 0,
      "notes" text,
      "uploaded_by_role" text NOT NULL DEFAULT 'lightbase',
      "uploaded_by_clerk_id" text,
      "uploaded_at" timestamp NOT NULL DEFAULT now(),
      "custom_category_label" text
    )`);
}

async function findOrCreateSupplier(): Promise<{ id: number; created: boolean }> {
  const found = (await sql.query(
    `SELECT id FROM suppliers WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [SUPPLIER_NAME],
  )) as Array<{ id: number }>;
  if (found.length > 0) {
    return { id: found[0].id, created: false };
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] would create supplier "${SUPPLIER_NAME}"`);
    return { id: -1, created: true };
  }
  const inserted = (await sql.query(
    `INSERT INTO suppliers
       (name, category, sub_category, origin, website, email, phone, contact_name, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Active')
       RETURNING id`,
    [
      SUPPLIER_NAME,
      SUPPLIER_INFO.category,
      SUPPLIER_INFO.subCategory,
      SUPPLIER_INFO.origin,
      SUPPLIER_INFO.website,
      SUPPLIER_INFO.email,
      SUPPLIER_INFO.phone,
      SUPPLIER_INFO.contactName,
      SUPPLIER_INFO.notes,
    ],
  )) as Array<{ id: number }>;
  return { id: inserted[0].id, created: true };
}

async function createProductRow(input: {
  supplierId: number;
  parentProductId: number | null;
  name: string;
  productCode: string | null;
  description: string;
  notes: string | null;
  category: string;
  thumbnailUrl: string | null;
  thumbnailPathname: string | null;
}): Promise<number> {
  if (DRY_RUN) {
    console.log(`  [dry-run] would insert product "${input.name}"${
      input.parentProductId ? ` (child of #${input.parentProductId})` : ""
    }`);
    return -1;
  }
  const rows = (await sql.query(
    `INSERT INTO supplier_products
       (supplier_id, parent_product_id, global_product_id, name, product_code,
        description, category, notes, thumbnail_url, thumbnail_pathname,
        is_primary_supplier, created_by_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, 'lightbase')
       RETURNING id`,
    [
      input.supplierId,
      input.parentProductId,
      `gp-${crypto.randomUUID()}`,
      input.name,
      input.productCode,
      input.description,
      input.category,
      input.notes,
      input.thumbnailUrl,
      input.thumbnailPathname,
    ],
  )) as Array<{ id: number }>;
  return rows[0].id;
}

async function attachFile(input: {
  productId: number;
  category:
    | "spec_datasheet"
    | "photo_media"
    | "drawing"
    | "ies_file"
    | "certification_compliance"
    | "test_report_qc"
    | "quote_pricing"
    | "contract_nda"
    | "other_file";
  name: string;
  url: string;
  blobPathname: string;
  contentType: string;
  size: number;
  notes?: string;
  customLabel?: string;
}): Promise<void> {
  if (DRY_RUN) return;
  await sql.query(
    `INSERT INTO supplier_product_attachments
       (product_id, category, name, url, blob_pathname, content_type, size, notes, custom_category_label, uploaded_by_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'lightbase')`,
    [
      input.productId,
      input.category,
      input.name,
      input.url,
      input.blobPathname,
      input.contentType,
      input.size,
      input.notes ?? null,
      input.customLabel ?? null,
    ],
  );
}

async function main() {
  console.log(`\n=== Antron AM49 ingestion ${DRY_RUN ? "(DRY RUN)" : ""} ===`);
  console.log(`Source: ${PRODUCT_URL}\n`);

  // ── Schema self-heal ────────────────────────────────────────────────
  console.log("[0/4] Ensuring supplier inventory schema …");
  await ensureSupplierSchema();
  console.log("  ✓");

  // ── 1. Supplier ─────────────────────────────────────────────────────
  console.log("\n[1/4] Resolving supplier …");
  const { id: supplierId, created: supplierCreated } = await findOrCreateSupplier();
  console.log(
    `  ${supplierCreated ? "+ created" : "↻ reused"} supplier #${supplierId} "${SUPPLIER_NAME}"`,
  );

  // ── 2. Pre-flight duplicate check on the parent product ─────────────
  console.log("\n[2/4] Checking for existing parent product …");
  if (supplierId !== -1) {
    const existing = (await sql.query(
      `SELECT id FROM supplier_products
         WHERE supplier_id = $1
           AND LOWER(name) = LOWER($2)
           AND parent_product_id IS NULL
         LIMIT 1`,
      [supplierId, PARENT_PRODUCT_NAME],
    )) as Array<{ id: number }>;
    if (existing.length > 0) {
      console.error(
        `\nABORT: parent product already exists (id=${existing[0].id}). Delete it from the supplier inventory drawer and re-run if you want to overwrite.`,
      );
      process.exit(2);
    }
  }
  console.log("  ✓ no existing parent — clear to insert");

  // ── 3. Download + upload product images so the parent has a hero ────
  console.log("\n[3/4] Fetching product images …");
  type Attachable = {
    url: string;
    pathname: string;
    contentType: string;
    size: number;
    filename: string;
    label: string;
  };
  const uploadedImages: Attachable[] = [];
  for (const img of PRODUCT_IMAGES) {
    console.log(`  → ${img.label} (${img.url.split("/").pop()})`);
    const fetched = await fetchBinary(img.url);
    if (!fetched) continue;
    if (DRY_RUN) {
      console.log(`    [dry-run] would upload ${(fetched.buf.length / 1024).toFixed(1)} KB`);
      continue;
    }
    const filename = safeFileName(
      decodeURIComponent(img.url.split("/").pop() ?? ""),
      "image.jpg",
    );
    const blob = await uploadToBlob({
      buf: fetched.buf,
      contentType: fetched.contentType,
      pathnamePrefix: "suppliers/antron/am49/images",
      filename,
    });
    uploadedImages.push({
      url: blob.url,
      pathname: blob.pathname,
      contentType: fetched.contentType,
      size: fetched.buf.length,
      filename,
      label: img.label,
    });
    console.log(`    ✓ uploaded ${(fetched.buf.length / 1024).toFixed(1)} KB`);
  }

  // ── 4. Insert parent + 11 configurations + spec sheets ──────────────
  console.log("\n[4/4] Inserting parent + configurations + spec sheets …");
  const heroImage = uploadedImages[0] ?? null;
  const parentId = await createProductRow({
    supplierId,
    parentProductId: null,
    name: PARENT_PRODUCT_NAME,
    productCode: "AM49",
    description: PARENT_DESCRIPTION,
    notes: null,
    category: PRODUCT_CATEGORY,
    thumbnailUrl: heroImage?.url ?? null,
    thumbnailPathname: heroImage?.pathname ?? null,
  });
  console.log(`  + parent product #${parentId}`);

  // Attach images to the parent (cover image is already set via thumbnail).
  for (const img of uploadedImages) {
    await attachFile({
      productId: parentId,
      category: "photo_media",
      name: img.filename,
      url: img.url,
      blobPathname: img.pathname,
      contentType: img.contentType,
      size: img.size,
      notes: img.label,
    });
    console.log(`    + photo: ${img.filename}`);
  }

  // For each configuration: insert child row, download + attach spec PDF.
  let attached = 0;
  let skipped = 0;
  for (const cfg of CONFIGURATIONS) {
    console.log(`\n  ── ${cfg.productCode} (${cfg.outputPowerW}, ${cfg.inputVoltage}) ──`);
    const childId = await createProductRow({
      supplierId,
      parentProductId: parentId === -1 ? null : parentId,
      name: configName(cfg),
      productCode: cfg.productCode,
      description: configDescription(cfg),
      notes: null,
      category: PRODUCT_CATEGORY,
      thumbnailUrl: null,
      thumbnailPathname: null,
    });
    console.log(`    + config product #${childId}`);

    const fetched = await fetchBinary(cfg.specUrl);
    if (!fetched) {
      console.warn(`    ✗ spec sheet download failed for ${cfg.productCode}`);
      skipped++;
      continue;
    }
    // WordPress sometimes returns a 200 HTML page when the download token
    // is wrong. Sanity-check the first 4 bytes are "%PDF".
    const head4 = String.fromCharCode(...fetched.buf.slice(0, 4));
    if (head4 !== "%PDF") {
      console.warn(`    ✗ download returned non-PDF content (${head4})`);
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `    [dry-run] would upload spec sheet (${(fetched.buf.length / 1024).toFixed(1)} KB)`,
      );
      attached++;
      continue;
    }
    const filename = `${cfg.productCode}-AM49-spec.pdf`;
    const blob = await uploadToBlob({
      buf: fetched.buf,
      contentType: "application/pdf",
      pathnamePrefix: `suppliers/antron/am49/${cfg.productCode}`,
      filename,
    });
    await attachFile({
      productId: childId,
      category: "spec_datasheet",
      name: filename,
      url: blob.url,
      blobPathname: blob.pathname,
      contentType: "application/pdf",
      size: fetched.buf.length,
      notes: `Spec sheet — ${cfg.productCode} AM49 (${cfg.outputPowerW}, ${cfg.outputCurrentMa})`,
    });
    console.log(
      `    + spec_datasheet: ${filename} (${(fetched.buf.length / 1024).toFixed(1)} KB)`,
    );
    attached++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  supplier:        #${supplierId} "${SUPPLIER_NAME}" (${supplierCreated ? "created" : "reused"})`);
  console.log(`  parent product:  #${parentId} "${PARENT_PRODUCT_NAME}"`);
  console.log(`  configurations:  ${CONFIGURATIONS.length} inserted`);
  console.log(`  spec sheets:     ${attached} attached, ${skipped} skipped`);
  console.log(`  images:          ${uploadedImages.length} attached`);
  if (DRY_RUN) console.log(`  *** DRY RUN — no DB / Blob writes were performed ***`);
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
