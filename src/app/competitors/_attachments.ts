// Server-side helpers shared between server-action files in this folder.
// NOT marked "use server" so functions here are not auto-exposed as actions —
// they're imported by actions that already enforce auth at their boundary.

import { put } from "@vercel/blob";
import { sql, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  competitorAttachments,
  competitorProductAttachments,
  competitorProducts,
} from "@/db/schema";
import { fetchWithTimeout } from "@/lib/ai/parsers";

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION-FORWARD-COMPAT
//
// Migration 0018 added competitor_products.specs_analysis_hash. Until that
// migration has been applied to the live database, a naked
// `db.select().from(competitorProducts)` crashes because Drizzle issues
// `SELECT … "specs_analysis_hash" …`. This wrapper does the full select
// first and on the specific column-missing error falls back to the
// pre-0018 column set, stamping specsAnalysisHash=null onto each row so
// consumers still see the full Row shape.
// ─────────────────────────────────────────────────────────────────────────────

type ProductRow = typeof competitorProducts.$inferSelect;

export async function withProductHashFallback<T extends ProductRow[]>(
  fullQuery: () => Promise<T>,
  legacyQuery: () => Promise<Array<Omit<ProductRow, "specsAnalysisHash">>>,
): Promise<ProductRow[]> {
  try {
    return await fullQuery();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!/specs_analysis_hash/i.test(msg)) throw e;
    console.warn(
      "[competitors] specs_analysis_hash column missing — run `npm run db:apply` to apply migration 0018. Falling back to legacy column set.",
    );
    const rows = await legacyQuery();
    return rows.map((r) => ({ ...r, specsAnalysisHash: null }));
  }
}

/**
 * Explicit column selector for `competitor_products` minus the post-0018
 * specs_analysis_hash field. Pass this to `db.select(LEGACY_PRODUCT_COLS)`
 * inside a fallback branch.
 */
export const LEGACY_PRODUCT_COLS = {
  id: competitorProducts.id,
  competitorId: competitorProducts.competitorId,
  name: competitorProducts.name,
  productCode: competitorProducts.productCode,
  productCategory: competitorProducts.productCategory,
  description: competitorProducts.description,
  imageUrls: competitorProducts.imageUrls,
  specs: competitorProducts.specs,
  sourceUrl: competitorProducts.sourceUrl,
  createdAt: competitorProducts.createdAt,
  updatedAt: competitorProducts.updatedAt,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEALING SCHEMA — idempotently apply migration 0018 on first call.
//
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is atomic + safe to repeat. Once
// per process we run it before doing any writes that touch the column. This
// removes the manual `npm run db:apply` step for the post-0018 column so
// that a fresh deploy doesn't blow up if someone forgets to run migrations.
// Also stamps the `__applied_migrations` ledger so a later manual run sees
// the migration already as applied.
//
// We DON'T do this for arbitrary migrations — only schema additions that
// match the deployed code's schema declarations. Destructive changes
// (column drops, type changes, table renames) still go through the manual
// migration runner. See feedback_migration_forward_compat.md in memory.
// ─────────────────────────────────────────────────────────────────────────────

let _schemaEnsured: Promise<boolean> | null = null;

export function ensureCompetitorProductsSchema(): Promise<boolean> {
  if (_schemaEnsured) return _schemaEnsured;
  _schemaEnsured = (async () => {
    try {
      // Migration ledger — created by scripts/apply-migrations.ts but we
      // need it here too so the auto-applied migration shows up if the
      // user later runs `npm run db:apply` manually.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS __applied_migrations (
          filename text PRIMARY KEY,
          applied_at timestamp DEFAULT now() NOT NULL
        )
      `);
      // Migration 0018: add specs_analysis_hash. Idempotent via IF NOT EXISTS.
      await db.execute(sql`
        ALTER TABLE "competitor_products"
        ADD COLUMN IF NOT EXISTS "specs_analysis_hash" text
      `);
      await db.execute(sql`
        INSERT INTO __applied_migrations (filename)
        VALUES ('0018_product_specs_analysis_hash.sql')
        ON CONFLICT DO NOTHING
      `);
      return true;
    } catch (e) {
      console.warn(
        "[competitors] auto-ensure schema failed — the INSERT/UPDATE compat helpers will catch column-missing errors as a fallback. Run `npm run db:apply` to apply migrations manually.",
        e,
      );
      return false;
    }
  })();
  return _schemaEnsured;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION-FORWARD-COMPAT — INSERT / UPDATE WRAPPERS
//
// Belt-and-suspenders for the auto-ensure above. Even if the ALTER fails
// (e.g. the DB role can't ALTER), these wrappers catch the resulting
// column-missing error on the actual write and fall back to a raw-SQL
// statement that omits the column. After a successful Drizzle write they
// cache that the column exists so subsequent calls skip the optimistic
// path's overhead.
// ─────────────────────────────────────────────────────────────────────────────

type ProductInsertValues = typeof competitorProducts.$inferInsert;

let _hashColumnPresent: boolean | null = null;

function isHashMissingError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /specs_analysis_hash/i.test(e.message);
}

async function rawInsertWithoutHash(
  values: ProductInsertValues,
): Promise<ProductRow> {
  // Explicit INSERT that omits specs_analysis_hash. text[] and jsonb get
  // explicit casts so the Neon HTTP driver doesn't choke on the params.
  const rows = (await db.execute(sql`
    INSERT INTO competitor_products (
      competitor_id, name, product_code, product_category, description,
      image_urls, specs, source_url
    ) VALUES (
      ${values.competitorId},
      ${values.name},
      ${values.productCode ?? null},
      ${values.productCategory ?? null},
      ${values.description ?? null},
      ${(values.imageUrls ?? []) as string[]}::text[],
      ${JSON.stringify(values.specs ?? {})}::jsonb,
      ${values.sourceUrl ?? null}
    )
    RETURNING
      id, competitor_id, name, product_code, product_category, description,
      image_urls, specs, source_url, created_at, updated_at
  `)) as unknown as Array<{
    id: number;
    competitor_id: number;
    name: string;
    product_code: string | null;
    product_category: string | null;
    description: string | null;
    image_urls: string[];
    specs: Record<string, string | string[]>;
    source_url: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>;
  const row = rows[0];
  if (!row) throw new Error("competitor_products INSERT returned no row");
  return {
    id: row.id,
    competitorId: row.competitor_id,
    name: row.name,
    productCode: row.product_code,
    productCategory: row.product_category,
    description: row.description,
    imageUrls: row.image_urls,
    specs: row.specs,
    sourceUrl: row.source_url,
    specsAnalysisHash: null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Insert into competitor_products with auto-fallback when migration 0018
 * hasn't been applied. Always prefer this over a raw
 * `db.insert(competitorProducts).values(…).returning()`.
 */
export async function insertCompetitorProductCompat(
  values: ProductInsertValues,
): Promise<ProductRow> {
  if (_hashColumnPresent === false) {
    return rawInsertWithoutHash(values);
  }
  try {
    const [row] = await db
      .insert(competitorProducts)
      .values(values)
      .returning();
    _hashColumnPresent = true;
    return row;
  } catch (e) {
    if (!isHashMissingError(e)) throw e;
    _hashColumnPresent = false;
    console.warn(
      "[competitors] specs_analysis_hash column missing on INSERT — falling back to legacy column set. Run `npm run db:apply` (or restart the server so the auto-ensure can retry).",
    );
    return rawInsertWithoutHash(values);
  }
}

/**
 * Update competitor_products with auto-fallback for `specsAnalysisHash`.
 * When migration 0018 isn't applied, the field is stripped from the UPDATE
 * (the row keeps the legacy schema; the hash-skip optimisation is just
 * temporarily disabled).
 */
export async function updateCompetitorProductCompat(
  id: number,
  values: Partial<ProductInsertValues>,
): Promise<void> {
  const stripHash = () => {
    const v: Partial<ProductInsertValues> = { ...values };
    delete (v as Record<string, unknown>).specsAnalysisHash;
    return v;
  };
  if (_hashColumnPresent === false && "specsAnalysisHash" in values) {
    const rest = stripHash();
    if (Object.keys(rest).length > 0) {
      await db
        .update(competitorProducts)
        .set(rest)
        .where(eq(competitorProducts.id, id));
    }
    return;
  }
  try {
    await db
      .update(competitorProducts)
      .set(values)
      .where(eq(competitorProducts.id, id));
    if ("specsAnalysisHash" in values) _hashColumnPresent = true;
  } catch (e) {
    if (!isHashMissingError(e)) throw e;
    _hashColumnPresent = false;
    console.warn(
      "[competitors] specs_analysis_hash column missing on UPDATE — stripping it. Run `npm run db:apply`.",
    );
    const rest = stripHash();
    if (Object.keys(rest).length > 0) {
      await db
        .update(competitorProducts)
        .set(rest)
        .where(eq(competitorProducts.id, id));
    }
  }
}

const MAX_BYTES = 25 * 1024 * 1024;

// Real-browser UA. Many CDN/WAF rules (Cloudflare, Akamai, Imperva) reject
// non-browser UAs with 403/406 — Lumenpulse hosts on a CDN that does this.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function safeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL DOCUMENT KINDS
//
// Stored in the `kind` column of competitor_product_attachments and
// competitor_attachments. The UI groups attachments by these labels so the
// user sees consistent buckets across every brand and product.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalKind =
  | "spec-sheet"      // PDF spec sheet / cut sheet / data sheet
  | "ies-photometric" // .ies / .ldt photometric files
  | "cad-drawing"     // DWG / DXF / dimensional drawings
  | "bim-revit"       // RFA / RVT / SKP / STEP / 3D model
  | "brochure"        // Family brochure / catalog
  | "installation"    // Install instructions / mounting guide
  | "warranty"        // Warranty document
  | "manual"          // Operating / user manual
  | "certification"   // Certifications / compliance docs
  | "image"           // High-res product photo
  | "other";          // Anything else

export const CANONICAL_KIND_LABELS: Record<CanonicalKind, string> = {
  "spec-sheet": "Spec sheet",
  "ies-photometric": "IES / photometric",
  "cad-drawing": "CAD drawing",
  "bim-revit": "BIM / Revit",
  "brochure": "Brochure",
  "installation": "Installation guide",
  "warranty": "Warranty",
  "manual": "Manual",
  "certification": "Certification",
  "image": "Image",
  "other": "Other",
};

export const CANONICAL_KIND_ORDER: CanonicalKind[] = [
  "spec-sheet",
  "ies-photometric",
  "cad-drawing",
  "bim-revit",
  "brochure",
  "installation",
  "manual",
  "warranty",
  "certification",
  "image",
  "other",
];

/**
 * Classify a document into one of the canonical kinds based on:
 * - URL extension and path keywords
 * - HTTP content-type
 * - An optional anchor text / human label (e.g. "Spec Sheet (PDF)")
 *
 * The label hint is the strongest signal — when a brand site labels the link
 * "Cut Sheet" or "BIM File", we trust that over the URL extension.
 */
export function classifyDocument(input: {
  url: string;
  contentType?: string;
  label?: string;
}): { kind: CanonicalKind; mime: string; ext: string } {
  const url = input.url.toLowerCase();
  const path = url.split("?")[0];
  const ct = (input.contentType ?? "").toLowerCase();
  const label = (input.label ?? "").toLowerCase();
  const haystack = `${path} ${label}`;

  // Extension lookup for mime/ext
  function ext(): string {
    const m = path.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
    return m?.[1] ?? "bin";
  }

  // ── Strongest signals — exact extension matches ──
  if (path.endsWith(".ies") || path.endsWith(".ldt") || ct.includes("photometric")) {
    return { kind: "ies-photometric", mime: "text/plain", ext: ext() };
  }
  if (
    path.endsWith(".rfa") || path.endsWith(".rvt") ||
    /\b(rfa|revit|bim)\b/i.test(haystack)
  ) {
    return { kind: "bim-revit", mime: "application/octet-stream", ext: ext() || "rfa" };
  }
  if (
    path.endsWith(".skp") || path.endsWith(".step") || path.endsWith(".stp") ||
    path.endsWith(".obj") || path.endsWith(".3ds") ||
    /\b(sketchup|skp|step|stp|3d.?model|3ds|obj)\b/i.test(haystack)
  ) {
    return { kind: "bim-revit", mime: "application/octet-stream", ext: ext() };
  }
  if (
    path.endsWith(".dwg") || path.endsWith(".dxf") ||
    /\b(dwg|dxf|cad|line\s?drawing|dimensional|technical\s?drawing)\b/i.test(haystack)
  ) {
    return { kind: "cad-drawing", mime: "application/octet-stream", ext: ext() || "dwg" };
  }
  if (path.endsWith(".zip") && /\b(bim|revit|3d|cad|family)\b/.test(haystack)) {
    return { kind: "bim-revit", mime: "application/zip", ext: "zip" };
  }
  if (path.endsWith(".zip") && /\b(drawing|dwg|dxf)\b/.test(haystack)) {
    return { kind: "cad-drawing", mime: "application/zip", ext: "zip" };
  }
  if (ct.startsWith("image/") || /\.(jpe?g|png|webp|gif|tiff?)(\?|$)/i.test(url)) {
    const m = url.match(/\.(jpe?g|png|webp|gif|tiff?)(?:\?|$)/i);
    return { kind: "image", mime: ct || "image/jpeg", ext: m?.[1].toLowerCase() ?? "jpg" };
  }

  // ── PDF — disambiguate by label/path keywords ──
  if (ct.includes("pdf") || path.endsWith(".pdf")) {
    if (/\b(install|installation|mount|hanging|instruction\s?sheets?|instructions?)\b/i.test(haystack))
      return { kind: "installation", mime: "application/pdf", ext: "pdf" };
    if (/\b(warranty|warrant)\b/i.test(haystack))
      return { kind: "warranty", mime: "application/pdf", ext: "pdf" };
    if (/\b(operating|operation|user\s?(?:manual|guide)|manual|owner)\b/i.test(haystack))
      return { kind: "manual", mime: "application/pdf", ext: "pdf" };
    if (/\b(brochure|catalog(?:ue)?|family|leaflet|line\s?card|portfolio)\b/i.test(haystack))
      return { kind: "brochure", mime: "application/pdf", ext: "pdf" };
    if (/\b(cert|certif|compliance|ul[\s_-]?listing|dlc|fcc|rohs|iec)\b/i.test(haystack))
      return { kind: "certification", mime: "application/pdf", ext: "pdf" };
    // Default PDF → spec sheet (most common case).
    return { kind: "spec-sheet", mime: "application/pdf", ext: "pdf" };
  }

  // Fallback for any other document.
  return {
    kind: "other",
    mime: ct || "application/octet-stream",
    ext: ext(),
  };
}

// Backwards-compat shim — older callers expect `{kind, mime, ext}` with no
// label. Kept so existing call sites don't need to change immediately.
function guessKindAndMime(
  url: string,
  contentType: string,
): { kind: string; mime: string; ext: string } {
  return classifyDocument({ url, contentType });
}

function looksLikeDocumentUrl(url: string): boolean {
  return /\.(pdf|ies|ldt|dwg|dxf|rfa|rvt|skp|step|stp|obj|3ds|zip)(\?|$)/i.test(url);
}

/**
 * Best-effort fetch + persist of a product specsheet/datasheet/IES/drawing as
 * a `competitor_product_attachments` row. Returns true if attached.
 *
 * Intentionally swallows errors — many sites block hot-link or redirect to
 * login, and we don't want a partial extraction to fail just because one
 * document is gated.
 *
 * IMPORTANT: we no longer issue HEAD first. Most CDNs/WAFs (Cloudflare,
 * Akamai) block HEAD with 403/405 even when the GET works. We just do a GET
 * with a browser UA and trust the URL extension as a heuristic.
 */
export async function attachProductDocument(
  productId: number,
  url: string,
  /** Optional human label (e.g. "Spec Sheet (PDF)") that improves kind
   *  classification. Pass when calling from a Perplexity-driven flow that
   *  already has the link's text. */
  label?: string,
): Promise<boolean> {
  try {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      console.warn("[attachProductDocument] not a valid http(s) URL:", u);
      return false;
    }

    const isLikelyDoc = looksLikeDocumentUrl(u);

    let res: Response;
    try {
      res = await fetchWithTimeout(
        u,
        {
          redirect: "follow",
          headers: {
            "User-Agent": BROWSER_UA,
            Accept:
              "application/pdf,application/octet-stream,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: new URL(u).origin + "/",
          },
        },
        15000,
      );
    } catch (err) {
      console.warn(`[attachProductDocument] network error/timeout: ${u}`, err);
      return false;
    }
    if (!res.ok) {
      console.warn(`[attachProductDocument] HTTP ${res.status} for ${u}`);
      return false;
    }

    let contentType = res.headers.get("content-type") ?? "";
    const lengthHeader = Number(res.headers.get("content-length") ?? "0");
    if (lengthHeader && lengthHeader > MAX_BYTES) {
      console.warn(`[attachProductDocument] too large (${lengthHeader}) for ${u}`);
      return false;
    }

    if (
      isLikelyDoc &&
      contentType.toLowerCase().includes("text/html")
    ) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const head4 = String.fromCharCode(...buf.slice(0, 4));
      if (head4 === "%PDF") {
        contentType = "application/pdf";
        const ok = await persistAttachment(productId, u, buf, contentType, lengthHeader, label);
        console.log(`[attachProductDocument] saved (HTML→PDF rescue): ${u}`);
        return ok;
      }
      console.warn(
        `[attachProductDocument] HTML returned for doc URL (gated?), skipping: ${u}`,
      );
      return false;
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) {
      console.warn(`[attachProductDocument] empty body for ${u}`);
      return false;
    }
    if (buf.length > MAX_BYTES) {
      console.warn(`[attachProductDocument] body too large for ${u}`);
      return false;
    }

    const ok = await persistAttachment(productId, u, buf, contentType, lengthHeader, label);
    if (ok) console.log(`[attachProductDocument] saved ${u} (${buf.length}B)`);
    return ok;
  } catch (e) {
    console.warn("[attachProductDocument] failed for", url, e);
    return false;
  }
}

async function persistAttachment(
  productId: number,
  url: string,
  buf: Uint8Array,
  contentTypeIn: string,
  lengthHeader: number,
  label?: string,
): Promise<boolean> {
  const length = lengthHeader || buf.length;
  const { kind, mime, ext } = classifyDocument({
    url,
    contentType: contentTypeIn,
    label,
  });
  const last = url.split("?")[0].split("#")[0].split("/").pop() ?? "document";
  const safe = safeFileName(last);
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(safe);
  const finalName = hasExt ? safe : `${safe}.${ext}`;
  const pathname = `competitors/products/${productId}/${crypto.randomUUID()}-${finalName}`;
  const body = Buffer.from(buf);
  const blob = await put(pathname, body, {
    access: "public",
    contentType: mime,
  });
  await db.insert(competitorProductAttachments).values({
    productId,
    name: finalName,
    size: length,
    mimeType: mime,
    kind,
    url: blob.url,
    blobPathname: blob.pathname,
  });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT IMAGE → BLOB
//
// Per the AI Project Master Guide §5.4 — escalate, don't skip. Source-CDN
// URLs are fragile (rate limits, geo blocks, link rot), so once we have an
// image URL from the AI / page scrape / Perplexity, we fetch the bytes
// ourselves and put them in Vercel Blob. The product row stores the blob
// URL, not the source URL. Returns null if the fetch fails so the caller
// can surface "couldn't grab this image" rather than dropping it silently.
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 12 * 1024 * 1024; // 12 MB per image — most product photos are <2 MB
const IMAGE_MIME_RX =
  /^image\/(jpeg|jpg|png|webp|gif|tiff|avif|svg\+xml)\s*(;|$)/i;
const IMAGE_EXT_RX = /\.(jpe?g|png|webp|gif|tiff?|avif|svg)(\?|#|$)/i;

function pickImageExt(url: string, mime: string): string {
  const mm = mime.toLowerCase();
  if (mm.includes("png")) return "png";
  if (mm.includes("webp")) return "webp";
  if (mm.includes("gif")) return "gif";
  if (mm.includes("avif")) return "avif";
  if (mm.includes("svg")) return "svg";
  if (mm.includes("tiff")) return "tif";
  if (mm.includes("jpeg") || mm.includes("jpg")) return "jpg";
  const m = url.toLowerCase().match(IMAGE_EXT_RX);
  return (m?.[1] === "jpeg" ? "jpg" : m?.[1]) ?? "jpg";
}

export type DownloadedImage = {
  blobUrl: string;
  blobPathname: string;
  size: number;
  mime: string;
  sourceUrl: string;
};

/**
 * Fetch a product image from its source URL and persist it to Vercel Blob.
 *
 * Uses the same browser-UA / Referer trick as attachProductDocument so CDN
 * WAFs (Cloudflare, Akamai) don't 403 the request. Returns null on:
 *   - non-2xx HTTP
 *   - non-image content type
 *   - empty body
 *   - body > IMAGE_MAX_BYTES
 *   - network/timeout failure
 *
 * Caller is expected to call this for every source URL it has and report
 * the count of failures in the completeness summary.
 */
export async function downloadProductImageToBlob(input: {
  /**
   * Directory prefix for the blob path. Typically a per-request UUID
   * (`competitors/product-images/<uuid>/`). Caller manages the prefix so
   * pre-save and post-save flows can both work.
   */
  pathPrefix: string;
  sourceUrl: string;
  /**
   * Override the Referer header. Pass the original product PAGE URL when
   * downloading from a hotlink-protected CDN (Shopify, BigCommerce, etc.) —
   * the CDN compares Referer against the brand's storefront, not the image
   * URL's own origin. Default uses the image URL's origin (good enough for
   * sites without hotlink protection).
   */
  refererOverride?: string;
}): Promise<DownloadedImage | null> {
  const u = input.sourceUrl.trim();
  if (!/^https?:\/\//i.test(u)) return null;

  // Compute Referer:
  //   - explicit override wins (storefront-origin for CDN images)
  //   - else fall back to the image URL's own origin
  //   - else last-resort Google (some sites accept ANY referer except none)
  const referer: string = (() => {
    if (input.refererOverride) {
      try {
        return new URL(input.refererOverride).origin + "/";
      } catch {
        // fall through
      }
    }
    try {
      return new URL(u).origin + "/";
    } catch {
      return "https://www.google.com/";
    }
  })();

  let res: Response;
  try {
    res = await fetchWithTimeout(
      u,
      {
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: referer,
        },
      },
      15_000,
    );
  } catch (err) {
    console.warn(`[downloadProductImageToBlob] network error: ${u}`, err);
    return null;
  }

  if (!res.ok) {
    console.warn(`[downloadProductImageToBlob] HTTP ${res.status} for ${u}`);
    return null;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (
    !IMAGE_MIME_RX.test(contentType) &&
    !IMAGE_EXT_RX.test(u)
  ) {
    // Server lied about content-type AND URL doesn't end in an image
    // extension — almost certainly an HTML page that intercepted the
    // request (login wall, CDN block). Don't write garbage to blob.
    console.warn(
      `[downloadProductImageToBlob] non-image content-type ${contentType} for ${u}`,
    );
    return null;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) {
    console.warn(`[downloadProductImageToBlob] empty body for ${u}`);
    return null;
  }
  if (buf.length > IMAGE_MAX_BYTES) {
    console.warn(
      `[downloadProductImageToBlob] body too large (${buf.length}) for ${u}`,
    );
    return null;
  }

  const ext = pickImageExt(u, contentType);
  const mime =
    contentType && IMAGE_MIME_RX.test(contentType)
      ? contentType.split(";")[0].trim()
      : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const prefix = input.pathPrefix.replace(/\/+$/, "");
  const pathname = `${prefix}/${crypto.randomUUID()}.${ext}`;

  try {
    const blob = await put(pathname, Buffer.from(buf), {
      access: "public",
      contentType: mime,
    });
    return {
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      size: buf.length,
      mime,
      sourceUrl: u,
    };
  } catch (err) {
    console.warn(`[downloadProductImageToBlob] blob put failed for ${u}`, err);
    return null;
  }
}

/**
 * Brand-level (not product-scoped) variant of attachProductDocument. Saves
 * the file to Vercel Blob and inserts a `competitor_attachments` row so the
 * brand's overview page in Benchmark / Brands tab can list it.
 */
export async function attachBrandDocument(
  competitorId: number,
  url: string,
  label?: string,
): Promise<boolean> {
  try {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      console.warn("[attachBrandDocument] not a valid http(s) URL:", u);
      return false;
    }
    const res = await fetchWithTimeout(
      u,
      {
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/pdf,application/octet-stream,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: new URL(u).origin + "/",
        },
      },
      15000,
    );
    if (!res.ok) {
      console.warn(`[attachBrandDocument] HTTP ${res.status} for ${u}`);
      return false;
    }
    let contentType = res.headers.get("content-type") ?? "";
    const lengthHeader = Number(res.headers.get("content-length") ?? "0");
    if (lengthHeader && lengthHeader > MAX_BYTES) {
      console.warn(`[attachBrandDocument] too large (${lengthHeader}) for ${u}`);
      return false;
    }
    const isLikelyDoc = looksLikeDocumentUrl(u);
    let buf = new Uint8Array(await res.arrayBuffer());
    if (isLikelyDoc && contentType.toLowerCase().includes("text/html")) {
      const head4 = String.fromCharCode(...buf.slice(0, 4));
      if (head4 === "%PDF") {
        contentType = "application/pdf";
      } else {
        console.warn(`[attachBrandDocument] doc URL returned HTML (gated?): ${u}`);
        return false;
      }
    }
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      console.warn(`[attachBrandDocument] empty or too large body for ${u}`);
      return false;
    }
    const length = lengthHeader || buf.length;
    const { kind, mime, ext } = classifyDocument({
      url: u,
      contentType,
      label,
    });
    const last = u.split("?")[0].split("#")[0].split("/").pop() ?? "document";
    const safe = safeFileName(last);
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(safe);
    // Prefix the stored name with the canonical kind so file lists in the UI
    // sort/group cleanly even though `competitor_attachments` has no `kind`
    // column.
    const finalName = hasExt ? safe : `${safe}.${ext}`;
    const namePrefix = label ? `[${kind}] ` : "";
    const pathname = `competitors/brand/${competitorId}/${crypto.randomUUID()}-${finalName}`;
    const body = Buffer.from(buf);
    const blob = await put(pathname, body, {
      access: "public",
      contentType: mime,
    });
    await db.insert(competitorAttachments).values({
      competitorId,
      name: namePrefix + finalName,
      size: length,
      mimeType: mime,
      url: blob.url,
      blobPathname: blob.pathname,
    });
    console.log(`[attachBrandDocument] saved ${finalName} (kind=${kind}, ${length}B) for brand ${competitorId}`);
    return true;
  } catch (e) {
    console.warn("[attachBrandDocument] failed for", url, e);
    return false;
  }
}

/**
 * Variant of attachProductDocument that ALSO returns the raw bytes, so the
 * caller can parse the PDF text and feed it into AI extraction. Same robust
 * fetch logic (no HEAD, browser UA, PDF magic-byte fallback) but the buffer
 * comes back instead of being thrown away.
 */
export async function fetchAndAttachProductDocument(
  productId: number,
  url: string,
): Promise<{ attached: boolean; bytes: Uint8Array | null; mime: string; ext: string; name: string }> {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    return { attached: false, bytes: null, mime: "", ext: "", name: "" };
  }
  try {
    const res = await fetchWithTimeout(
      u,
      {
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept:
            "application/pdf,application/octet-stream,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: new URL(u).origin + "/",
        },
      },
      15000,
    );
    if (!res.ok) {
      return { attached: false, bytes: null, mime: "", ext: "", name: "" };
    }
    let contentType = res.headers.get("content-type") ?? "";
    const lengthHeader = Number(res.headers.get("content-length") ?? "0");
    if (lengthHeader && lengthHeader > MAX_BYTES) {
      return { attached: false, bytes: null, mime: contentType, ext: "", name: "" };
    }
    const isLikelyDoc = looksLikeDocumentUrl(u);
    if (
      isLikelyDoc &&
      contentType.toLowerCase().includes("text/html")
    ) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const head4 = String.fromCharCode(...buf.slice(0, 4));
      if (head4 === "%PDF") {
        contentType = "application/pdf";
        const ok = await persistAttachment(productId, u, buf, contentType, lengthHeader);
        const meta = guessKindAndMime(u, contentType);
        return {
          attached: ok,
          bytes: buf,
          mime: meta.mime,
          ext: meta.ext,
          name: u.split("?")[0].split("#")[0].split("/").pop() ?? "doc",
        };
      }
      return { attached: false, bytes: null, mime: contentType, ext: "", name: "" };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return { attached: false, bytes: null, mime: contentType, ext: "", name: "" };
    }
    const ok = await persistAttachment(productId, u, buf, contentType, lengthHeader);
    const meta = guessKindAndMime(u, contentType);
    return {
      attached: ok,
      bytes: buf,
      mime: meta.mime,
      ext: meta.ext,
      name: u.split("?")[0].split("#")[0].split("/").pop() ?? "doc",
    };
  } catch (e) {
    console.warn("fetchAndAttachProductDocument failed for", u, e);
    return { attached: false, bytes: null, mime: "", ext: "", name: "" };
  }
}
