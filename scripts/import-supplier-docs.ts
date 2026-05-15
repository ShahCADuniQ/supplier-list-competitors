/**
 * One-shot bulk importer for supplier documents.
 *
 * Walks `C:\Users\hasaa\OneDrive - LightBase\OPERATIONS\SUPPLIERS\SUPPLIERS V2`,
 * matches each top-level subfolder to a supplier in the DB (creating one if
 * none exists), then uploads every file inside as a `supplier_attachments`
 * row. Sub-folder names are mapped to attachment categories (catId) so
 * everything lands in the right tab on the supplier detail panel.
 *
 * Idempotent — re-running skips any (supplier, catId, name, size) triple
 * that's already on disk.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/import-supplier-docs.ts --dry-run
 *   npx tsx --env-file=.env scripts/import-supplier-docs.ts
 *   npx tsx --env-file=.env scripts/import-supplier-docs.ts --only "BELITE"
 *   npx tsx --env-file=.env scripts/import-supplier-docs.ts --root "C:\path\to\SUPPLIERS V1"
 *
 * Env required: DATABASE_URL, BLOB_READ_WRITE_TOKEN
 */

import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT_DEFAULT =
  "C:\\Users\\hasaa\\OneDrive - LightBase\\OPERATIONS\\SUPPLIERS\\SUPPLIERS V2";

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const eqIdx = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return undefined;
  const a = argv[eqIdx];
  const eq = a.indexOf("=");
  if (eq !== -1) return a.slice(eq + 1);
  const next = argv[eqIdx + 1];
  if (next && !next.startsWith("--")) return next;
  return "true";
};
const DRY = flag("dry-run") === "true";
const ROOT = flag("root") ?? ROOT_DEFAULT;
const ONLY = flag("only")?.toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set — load with --env-file=.env");
  process.exit(1);
}
const sql = neon(dbUrl);

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!DRY && !blobToken) {
  console.error("BLOB_READ_WRITE_TOKEN not set — load with --env-file=.env");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY MAPPING — folder-name + filename heuristics → catId in
// SuppliersView.tsx (ATT_CATEGORIES). Match in this order; first hit wins.
// ─────────────────────────────────────────────────────────────────────────────

type CatId =
  | "specs"
  | "quotes"
  | "contracts"
  | "certs"
  | "tests"
  | "catalogs"
  | "invoices"
  | "comms"
  | "media"
  | "other";

const FOLDER_RULES: Array<{ re: RegExp; cat: CatId }> = [
  { re: /\bcertif/i, cat: "certs" },
  { re: /\b(test|ies|lm-?80|photometric|qc)\b/i, cat: "tests" },
  { re: /\b(media|photos?|pictures?|videos?)/i, cat: "media" },
  { re: /\b(quote|pricing|price|rfq)/i, cat: "quotes" },
  { re: /\b(invoice|po|purchase|pi)\b/i, cat: "invoices" },
  { re: /\b(contract|nda|msa|agreement|terms)/i, cat: "contracts" },
  { re: /\b(spec|datasheet|drawing|dimension|dwg)/i, cat: "specs" },
  { re: /\b(catalog|brochure|catalogue|overview|profile)/i, cat: "catalogs" },
  { re: /\b(email|comm|correspondence|notes?)/i, cat: "comms" },
  { re: /\b(design|guideline)/i, cat: "specs" },
];

const FILENAME_RULES: Array<{ re: RegExp; cat: CatId }> = [
  { re: /\b(rfq|price|pricelist|pricing|quote|quotation)/i, cat: "quotes" },
  { re: /\b(invoice|po-?\d|purchase\s*order|pi[-_\s])/i, cat: "invoices" },
  { re: /\b(certif|ul[-_\s]?report|etl|fcc|ce[-_\s]?mark|rohs|reach|iso[-_\s]?\d|csa)/i, cat: "certs" },
  // Tests — drop the trailing \b on lm-?80 / ies because filenames often
  // chain into _Results etc. with underscores (LM80_Results, IES_test).
  { re: /(lm-?80|photometric|spectroradiometric|test\s*report)/i, cat: "tests" },
  { re: /\.(ies|ldt)$/i, cat: "tests" },
  // Installation manuals + assembly instructions are technical specs.
  { re: /\b(install\w*|manual|instruction|assembly)/i, cat: "specs" },
  { re: /\b(datasheet|spec|specification|drawing|dimension|cad|dxf|dwg)/i, cat: "specs" },
  { re: /\b(catalog|catalogue|brochure|portfolio|overview|profile|company\s*presentation|series)/i, cat: "catalogs" },
  { re: /\b(contract|nda|msa|agreement|terms)/i, cat: "contracts" },
  { re: /\b(email|letter|memo|meeting)/i, cat: "comms" },
];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".wmv", ".webm"]);
const IES_EXTS = new Set([".ies", ".ldt"]);

function catForFile(filePath: string, supplierRoot: string): CatId {
  const rel = path.relative(supplierRoot, filePath).replace(/\\/g, "/");
  const folders = rel.split("/").slice(0, -1);
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();

  // 1. Hard ext-based hits first.
  if (IES_EXTS.has(ext)) return "tests";
  if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
    // Photos in CERTIFICATE/ are still certs (e.g. cert scans).
    for (const f of folders) {
      if (/\bcertif/i.test(f)) return "certs";
    }
    return "media";
  }

  // 2. Folder rules from innermost outwards.
  for (let i = folders.length - 1; i >= 0; i--) {
    for (const r of FOLDER_RULES) {
      if (r.re.test(folders[i])) return r.cat;
    }
  }

  // 3. Filename rules.
  for (const r of FILENAME_RULES) {
    if (r.re.test(base)) return r.cat;
  }

  // 4. xlsx / csv default → quotes (most are RFQ/pricing in this dataset).
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") return "quotes";

  // 5. Root-level PDFs (no parent folder inside the supplier dir) without
  // any other signal — most are brand catalogs / spec brochures, not
  // randomly-categorized "other". Bucket them as catalogs so they end up
  // on the right tab.
  if (ext === ".pdf" && folders.length === 0) return "catalogs";

  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME types — quick lookup; the server doesn't need perfect MIME, but the
// detail-tab preview is friendlier when it's right.
// ─────────────────────────────────────────────────────────────────────────────

function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  switch (e) {
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".bmp": return "image/bmp";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".m4v": return "video/x-m4v";
    case ".webm": return "video/webm";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls": return "application/vnd.ms-excel";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc": return "application/msword";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".csv": return "text/csv";
    case ".zip": return "application/zip";
    case ".dwg": return "image/vnd.dwg";
    case ".dxf": return "image/vnd.dxf";
    case ".ies": return "text/plain";
    default: return "application/octet-stream";
  }
}

function safeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(2)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILESYSTEM walker — depth-first, skips hidden + Office temp files +
// archive subfolders we don't want to import (per the OneDrive convention).
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "_supplier-name",       // template folder
  "archive",              // historical / deprecated assets
]);

const SKIP_FILE_RE = /^(~\$|\.|thumbs\.db$|desktop\.ini$)/i;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      out.push(...(await walk(path.join(dir, e.name))));
    } else if (e.isFile()) {
      if (SKIP_FILE_RE.test(e.name)) continue;
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER MATCHING
// ─────────────────────────────────────────────────────────────────────────────

type DBSupplier = { id: number; name: string };

async function loadSuppliers(): Promise<DBSupplier[]> {
  const rows = (await sql.query(
    `SELECT id, name FROM suppliers ORDER BY name`,
    [],
  )) as DBSupplier[];
  return rows;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function matchSupplier(folderName: string, all: DBSupplier[]): DBSupplier | null {
  const target = normalizeName(folderName);
  if (!target) return null;
  // Exact match first.
  let hit = all.find((s) => normalizeName(s.name) === target);
  if (hit) return hit;
  // Then "contains" both ways (catches "BELITE" → "Belite Lighting", "HY METAL" → "HY Metals").
  hit = all.find((s) => {
    const n = normalizeName(s.name);
    return n.includes(target) || target.includes(n);
  });
  return hit ?? null;
}

async function createSupplier(name: string): Promise<DBSupplier> {
  const cleanName = name.replace(/_/g, " ").trim();
  // Default: Active / Manufacturing (lighting-supply leaning) — the user
  // can rename / re-categorize in the UI afterwards.
  const rows = (await sql.query(
    `INSERT INTO suppliers (name, status, category, origin)
     VALUES ($1, 'Active', 'Manufacturing', NULL)
     RETURNING id, name`,
    [cleanName],
  )) as DBSupplier[];
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACHMENT DEDUP — load existing (name, size, catId) tuples per supplier
// so re-runs don't duplicate uploads.
// ─────────────────────────────────────────────────────────────────────────────

async function loadExistingAttachmentKeys(
  supplierId: number,
): Promise<Set<string>> {
  const rows = (await sql.query(
    `SELECT name, size, cat_id FROM supplier_attachments WHERE supplier_id = $1`,
    [supplierId],
  )) as Array<{ name: string; size: number; cat_id: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    set.add(`${r.cat_id}::${r.name}::${r.size}`);
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT
// ─────────────────────────────────────────────────────────────────────────────

// Vercel Blob's single-shot `put()` tops out around 500MB; anything larger
// has to go via multipart and we don't need that complexity for this
// dataset. Files above this size are skipped + logged, and the user can
// link them out (OneDrive / Drive / etc) instead.
const MAX_UPLOAD_SIZE_BYTES = 450 * 1024 * 1024;

type Summary = {
  supplier: string;
  matched: boolean;
  created: boolean;
  files: number;
  uploaded: number;
  skippedExisting: number;
  skippedTooLarge: number;
  errors: number;
  byCat: Record<CatId, number>;
};

async function importSupplier(
  folder: string,
  folderName: string,
  all: DBSupplier[],
): Promise<Summary> {
  const summary: Summary = {
    supplier: folderName,
    matched: false,
    created: false,
    files: 0,
    uploaded: 0,
    skippedExisting: 0,
    skippedTooLarge: 0,
    errors: 0,
    byCat: {
      specs: 0, quotes: 0, contracts: 0, certs: 0, tests: 0,
      catalogs: 0, invoices: 0, comms: 0, media: 0, other: 0,
    },
  };

  let supplier = matchSupplier(folderName, all);
  if (supplier) {
    summary.matched = true;
  } else if (!DRY) {
    supplier = await createSupplier(folderName);
    summary.created = true;
    all.push(supplier);
  }
  if (!supplier) {
    console.log(`  [DRY] would create supplier "${folderName}"`);
    return summary;
  }

  const files = await walk(folder);
  summary.files = files.length;
  if (files.length === 0) return summary;

  const existing = DRY ? new Set<string>() : await loadExistingAttachmentKeys(supplier.id);

  for (const filePath of files) {
    try {
      const fname = path.basename(filePath);
      const st = await stat(filePath);
      const cat = catForFile(filePath, folder);
      const key = `${cat}::${fname}::${st.size}`;
      if (existing.has(key)) {
        summary.skippedExisting += 1;
        continue;
      }
      if (st.size > MAX_UPLOAD_SIZE_BYTES) {
        summary.skippedTooLarge += 1;
        console.log(
          `    skip too-large ${fmtBytes(st.size).padStart(9)} · ${fname} (over ${fmtBytes(MAX_UPLOAD_SIZE_BYTES)} blob limit)`,
        );
        continue;
      }
      summary.byCat[cat] += 1;

      if (DRY) {
        console.log(
          `    [DRY] ${cat.padEnd(9)} ${fmtBytes(st.size).padStart(9)} · ${fname}`,
        );
        summary.uploaded += 1;
        continue;
      }

      const buf = await readFile(filePath);
      const ext = path.extname(fname);
      const safe = safeFileName(fname);
      const pathname = `suppliers/${supplier.id}/${cat}/${crypto.randomUUID()}-${safe}`;
      const blob = await put(pathname, buf, {
        access: "public",
        contentType: mimeFor(ext),
        token: blobToken,
      });
      await sql.query(
        `INSERT INTO supplier_attachments
           (supplier_id, cat_id, name, size, mime_type, url, blob_pathname, uploader)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          supplier.id,
          cat,
          fname,
          st.size,
          mimeFor(ext),
          blob.url,
          blob.pathname,
          "system:import-supplier-docs",
        ],
      );
      summary.uploaded += 1;
      existing.add(key);
      if (summary.uploaded % 10 === 0) {
        console.log(
          `    +${summary.uploaded} uploaded (latest: ${cat}/${fname})`,
        );
      }
    } catch (e) {
      summary.errors += 1;
      console.error(
        `    ! failed ${path.basename(filePath)}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return summary;
}

async function main(): Promise<void> {
  console.log(
    `${DRY ? "[DRY RUN] " : ""}Importing supplier docs from:\n  ${ROOT}`,
  );
  if (ONLY) console.log(`  filter --only="${ONLY}"`);
  console.log();

  const subdirs = await readdir(ROOT, { withFileTypes: true });
  const folders = subdirs
    .filter(
      (d) =>
        d.isDirectory() &&
        !SKIP_DIRS.has(d.name.toLowerCase()) &&
        (ONLY ? d.name.toLowerCase().includes(ONLY) : true),
    )
    .map((d) => d.name)
    .sort();

  console.log(`Found ${folders.length} supplier folder(s)\n`);

  const all = await loadSuppliers();
  console.log(`Loaded ${all.length} suppliers from DB\n`);

  const summaries: Summary[] = [];
  for (const f of folders) {
    console.log(`── ${f} ──`);
    const s = await importSupplier(path.join(ROOT, f), f, all);
    summaries.push(s);
    const cats = Object.entries(s.byCat)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" · ");
    const verdict = s.matched
      ? "matched"
      : s.created
        ? "created"
        : "no-match (DRY)";
    console.log(
      `  ${verdict} · ${s.files} files · uploaded ${s.uploaded}` +
        (s.skippedExisting ? ` · skipped ${s.skippedExisting} already imported` : "") +
        (s.skippedTooLarge ? ` · skipped ${s.skippedTooLarge} too large` : "") +
        (s.errors ? ` · ${s.errors} errors` : "") +
        (cats ? `\n  by-cat: ${cats}` : ""),
    );
    console.log();
  }

  // Totals
  const total = summaries.reduce(
    (acc, s) => {
      acc.files += s.files;
      acc.uploaded += s.uploaded;
      acc.skipped += s.skippedExisting;
      acc.tooLarge += s.skippedTooLarge;
      acc.errors += s.errors;
      acc.matched += s.matched ? 1 : 0;
      acc.created += s.created ? 1 : 0;
      for (const k of Object.keys(s.byCat) as CatId[]) {
        acc.byCat[k] += s.byCat[k];
      }
      return acc;
    },
    {
      files: 0,
      uploaded: 0,
      skipped: 0,
      tooLarge: 0,
      errors: 0,
      matched: 0,
      created: 0,
      byCat: {
        specs: 0, quotes: 0, contracts: 0, certs: 0, tests: 0,
        catalogs: 0, invoices: 0, comms: 0, media: 0, other: 0,
      } as Record<CatId, number>,
    },
  );
  console.log("══════════════════════════════════════════");
  console.log(`SUMMARY${DRY ? " (DRY)" : ""}`);
  console.log(`  Suppliers — matched ${total.matched}, created ${total.created}`);
  console.log(
    `  Files     — ${total.files} found, ${total.uploaded} uploaded, ${total.skipped} skipped (dup), ${total.tooLarge} skipped (too large), ${total.errors} errors`,
  );
  console.log(`  Per-cat:`);
  for (const [k, n] of Object.entries(total.byCat)) {
    if (n > 0) console.log(`    ${k.padEnd(10)} ${n}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
