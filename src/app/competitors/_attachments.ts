// Server-side helpers shared between server-action files in this folder.
// NOT marked "use server" so functions here are not auto-exposed as actions —
// they're imported by actions that already enforce auth at their boundary.

import { put } from "@vercel/blob";
import { db } from "@/db";
import {
  competitorAttachments,
  competitorProductAttachments,
} from "@/db/schema";
import { fetchWithTimeout } from "@/lib/ai/parsers";

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
    if (/\b(install|installation|mount|hanging)\b/i.test(haystack))
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
