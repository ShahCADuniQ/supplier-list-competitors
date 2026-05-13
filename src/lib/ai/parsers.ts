import * as XLSX from "xlsx";

// pdf-parse v2 transitively imports pdfjs-dist, which references the
// browser-only `DOMMatrix` at module-evaluation time. A static top-level
// import therefore crashes Node with
//   `ReferenceError: DOMMatrix is not defined`
// the FIRST time anything in this file is imported — taking down every
// server route that pulls in `fetchWithTimeout` (the entire /competitors
// page tree). The fix has two parts:
//   1. Defer the pdf-parse import to inside `pdfBufferToText` (below) so
//      importing parsers.ts no longer evaluates pdfjs-dist.
//   2. Stub `globalThis.DOMMatrix` so when a PDF actually IS parsed, the
//      runtime call doesn't fail. Text extraction never touches matrix
//      math, so a no-op class is sufficient.
function ensureDomMatrixPolyfill(): void {
  const g = globalThis as unknown as { DOMMatrix?: unknown };
  if (typeof g.DOMMatrix !== "undefined") return;
  class DOMMatrixStub {}
  g.DOMMatrix = DOMMatrixStub;
}

/** Cap input size sent to the model so a 50-page catalog doesn't burn tokens. */
const MAX_TEXT_CHARS = 60_000;

export type ParsedSource = {
  /** Original filename or URL — included verbatim in the prompt for context. */
  label: string;
  /** Plain text representation (cleaned/extracted) the model will read. */
  text: string;
  /** Optional base64 image data for vision-capable inputs (images only). */
  imageDataUrl?: string;
};

/** Truncate text for the model. We add a marker so it knows it was cut. */
function clip(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + "\n\n…[content truncated]";
}

/**
 * fetch() with a hard timeout via AbortController. Default 12s — long enough
 * for CDNs that take a while to warm up, short enough that a hung connection
 * doesn't stall the whole deep-extract pipeline.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract text from a PDF buffer. Returns an empty string for scanned PDFs. */
export async function pdfBufferToText(buf: Buffer | Uint8Array): Promise<string> {
  ensureDomMatrixPolyfill();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return clip((result.text ?? "").trim());
  } catch (e) {
    console.error("pdf-parse failed", e);
    return "";
  }
}

/** Convert an Excel/CSV buffer to readable text. Joins all sheets with headers. */
export function xlsxBufferToText(buf: Buffer | Uint8Array, hint?: string): string {
  try {
    const wb = XLSX.read(buf, { type: "array" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) parts.push(`# Sheet: ${sheetName}\n${csv}`);
    }
    return clip(parts.join("\n\n"));
  } catch (e) {
    console.error("xlsx parse failed", e, hint);
    return "";
  }
}

/** Fetch a URL and crudely strip HTML to readable text. */
export async function fetchUrlAsText(url: string): Promise<string> {
  const { text } = await fetchUrlWithLinks(url);
  return text;
}

/**
 * Fetch a URL and return raw HTML + readable text + every anchor link.
 * Same fetch underpins fetchUrlAsText / fetchUrlWithLinks / extractDocumentLinks
 * — exposed separately so the deep crawler can do all three in one HTTP call.
 */
export async function fetchUrlFully(url: string): Promise<{
  html: string;
  text: string;
  links: Array<{ href: string; text: string }>;
}> {
  // Use a real browser UA — most enterprise lighting brand sites are behind
  // Cloudflare / Akamai / Imperva and reject custom UAs with 403/406.
  const res = await fetchWithTimeout(
    url,
    {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    12000,
  );
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) {
    return {
      html: "",
      text: `[Binary content at ${url} — content-type ${ct}]`,
      links: [],
    };
  }
  const html = await res.text();
  const links = extractLinks(html, url);
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { html, text: clip(stripped), links };
}

/**
 * Fetch a URL and return both readable text AND every anchor link with its
 * label (resolved against the page's URL). Used by the deep crawler to walk a
 * brand's website looking for product / category pages in a niche.
 */
export async function fetchUrlWithLinks(url: string): Promise<{
  text: string;
  links: Array<{ href: string; text: string }>;
}> {
  const res = await fetchWithTimeout(
    url,
    {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    12000,
  );
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) {
    return {
      text: `[Binary content at ${url} — content-type ${ct}]`,
      links: [],
    };
  }
  const html = await res.text();
  const links = extractLinks(html, url);
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { text: clip(stripped), links };
}

/**
 * Pull product-image URLs out of a page's raw HTML.
 *
 * Strict whitelist policy — to avoid pulling banner / lifestyle / related-product
 * images, we ONLY accept images that match BOTH:
 *   1. og:image (the brand's hero shot — always the actual product), AND
 *   2. images that share the og:image's CDN directory prefix (i.e. live in the
 *      same /products/<sku>/ folder as the hero shot).
 *
 * If there's no og:image we fall back to a much narrower image bucket: only
 * <img> tags whose src contains a path segment matching the page's last URL
 * segment (e.g. for /linear-cove/lumenline-cove, only images whose path
 * includes "lumenline" or "lumenline-cove").
 */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const pageSlug = (base.pathname.split("/").filter(Boolean).pop() ?? "")
    .toLowerCase();

  const seen = new Set<string>();
  function tryAbsolute(raw: string | undefined | null): string | null {
    if (!raw) return null;
    const t = raw.trim();
    if (!t || t.startsWith("data:")) return null;
    let abs: URL;
    try {
      abs = new URL(t, base);
    } catch {
      return null;
    }
    if (abs.protocol !== "https:" && abs.protocol !== "http:") return null;
    const fullLower = abs.toString().toLowerCase();
    const path = abs.pathname.toLowerCase();
    if (path.endsWith(".svg")) return null;
    if (
      /\b(favicon|sprite|spinner|loading|placeholder|blank|logo|wordmark|monogram|nav-?icon|menu-?icon|social|share|fb_share|twitter_card|email_icon|skip|chevron|arrow|caret|hamburger|close|search-icon|footer|header|banner|hero-bg|page-bg|background|page-?header|cover|related|carousel-arrow|cookie)\b/.test(
        path,
      )
    ) return null;
    if (/[-_](thumb|thumbnail|small|tiny|mini|xs|icon|16x16|24x24|32x32|48x48|64x64|96x96|150x150)\b/.test(path)) return null;
    if (/\.(gif)$/i.test(path) && /\/(pixel|track|beacon|analytics)/i.test(fullLower)) return null;
    if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(fullLower)) return null;
    // Reject images explicitly resized small via URL query (Optimizely DAM,
    // Sitecore, Cloudinary, imgix patterns) — these are nav icons / logos /
    // thumbnails the page renders inline, not the product hero shot.
    const widthMatch = abs.search.match(/[?&](?:width|w|maxwidth|mw)=(\d+)/i);
    if (widthMatch) {
      const w = parseInt(widthMatch[1], 10);
      if (!isNaN(w) && w < 200) return null;
    }
    // Optimizely / Episerver "globalassets" carries BOTH brand chrome (logos,
    // header tiles) AND legitimate product images (e.g. iGuzzini's
    // /globalassets/products/{indoor|outdoor}/...). Only reject the chrome
    // sub-folders; let everything else through and let downstream slug /
    // gallery filtering pick the right hero.
    if (/\/globalassets\/(?:header|footer|nav|chrome|menu|brand|logos?)\//i.test(path)) {
      return null;
    }
    abs.hash = "";
    return abs.toString();
  }

  // 1) Pull og:image first — this anchors what counts as an "in-gallery" image.
  const ogRe = /<meta\b[^>]*property=["']og:image["'][^>]*content=(?:"([^"]+)"|'([^']+)')/gi;
  const ogTwitterRe = /<meta\b[^>]*name=["']twitter:image[^"']*["'][^>]*content=(?:"([^"]+)"|'([^']+)')/gi;
  let ogImage: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = ogRe.exec(html)) !== null) {
    const u = tryAbsolute(m[1] ?? m[2]);
    if (u) {
      ogImage = u;
      break;
    }
  }
  if (!ogImage) {
    while ((m = ogTwitterRe.exec(html)) !== null) {
      const u = tryAbsolute(m[1] ?? m[2]);
      if (u) {
        ogImage = u;
        break;
      }
    }
  }

  // Compute the og:image's directory prefix so we can keep gallery siblings.
  // For "https://media.lumenpulse.com/cdn/lumenline-cove/hero.jpg" the prefix
  // is "https://media.lumenpulse.com/cdn/lumenline-cove/".
  let ogDirPrefix = "";
  if (ogImage) {
    try {
      const u = new URL(ogImage);
      const lastSlash = u.pathname.lastIndexOf("/");
      if (lastSlash > 0) {
        u.pathname = u.pathname.slice(0, lastSlash + 1);
        u.search = "";
        u.hash = "";
        ogDirPrefix = u.toString();
      }
    } catch {
      // ignore
    }
  }

  // 2) Walk all <img> tags + <source srcset> + background-image and keep ONLY
  // images that pass the strict relevance test below.
  const candidates: string[] = [];
  function addCandidate(raw: string | undefined | null) {
    const u = tryAbsolute(raw);
    if (u) candidates.push(u);
  }

  const imgRe = /<img\b[^>]*?>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = [
      tag.match(/\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-lazy-src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-original=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-img-src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-large=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
      tag.match(/\bdata-zoom-image=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i),
    ];
    for (const c of attrs) {
      if (!c) continue;
      addCandidate(c[1] ?? c[2] ?? c[3]);
    }
    const srcset = tag.match(/\b(?:srcset|data-srcset|data-lazy-srcset)=(?:"([^"]+)"|'([^']+)')/i);
    if (srcset) {
      const raw = srcset[1] ?? srcset[2] ?? "";
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => {
          const tokens = p.split(/\s+/);
          const url = tokens[0];
          const desc = tokens[1] ?? "";
          const w = parseInt(desc, 10);
          return { url, width: isNaN(w) ? (desc === "2x" ? 2 : 1) : w };
        })
        .sort((a, b) => b.width - a.width);
      // Take the largest variant only, to avoid duplicates of the same image.
      if (parts[0]) addCandidate(parts[0].url);
    }
  }

  const sourceRe = /<source\b[^>]*?>/gi;
  while ((m = sourceRe.exec(html)) !== null) {
    const tag = m[0];
    const srcset = tag.match(/\bsrcset=(?:"([^"]+)"|'([^']+)')/i);
    if (!srcset) continue;
    const raw = srcset[1] ?? srcset[2] ?? "";
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts[0]) {
      const url = parts[0].split(/\s+/)[0];
      addCandidate(url);
    }
  }

  // STRICT FILTER: keep only candidates that are clearly product-gallery
  // images for this exact product page. Then rank by relevance to the page
  // slug so the most variant-specific image is FIRST (vision verifier only
  // sees the top few).
  const accepted: Array<{ url: string; score: number; rank: number }> = [];
  // Dedupe by stripped URL (no query string) — sites serve the same image at
  // multiple sizes via ?width= variants, no need to double-count for vision.
  const acceptedKey = new Set<string>();
  function baseKey(u: string): string {
    try {
      const x = new URL(u);
      x.search = "";
      x.hash = "";
      return x.toString().toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  }
  const slugTokens = pageSlug && pageSlug.length >= 4
    ? pageSlug.split(/[-_]/).filter((t) => t.length >= 4)
    : [];
  function scoreOf(url: string): number {
    const cl = url.toLowerCase();
    let s = 0;
    for (const t of slugTokens) if (cl.includes(t)) s += 2;
    // Bonus signal: legitimate product asset paths.
    if (/\/products?\//i.test(cl)) s += 1;
    if (/\/(media|gallery|hero|product-image)/i.test(cl)) s += 1;
    return s;
  }
  function tryAdd(u: string, rank: number) {
    const k = baseKey(u);
    if (acceptedKey.has(k)) return;
    acceptedKey.add(k);
    accepted.push({ url: u, score: scoreOf(u), rank });
  }

  if (ogImage) tryAdd(ogImage, 0);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (accepted.length >= 12) break;
    // Pass A: same gallery directory as og:image (e.g. /products/<sku>/*)
    if (ogDirPrefix && c.startsWith(ogDirPrefix)) {
      tryAdd(c, i + 1);
      continue;
    }
    // Pass B: URL path mentions the page slug — e.g. /linear-cove/ in the
    // image URL when we're on /linear-cove. Catches sites where og:image is
    // hosted on a different CDN than the rest of the gallery.
    if (slugTokens.length > 0) {
      const cl = c.toLowerCase();
      if (slugTokens.some((t) => cl.includes(t))) {
        tryAdd(c, i + 1);
        continue;
      }
    }
    // Otherwise — DROP. We'd rather have 1 correct image than 5 lifestyle/
    // banner shots from elsewhere on the page.
  }

  // Highest score first; ties broken by DOM order (rank).
  accepted.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return accepted.map((a) => a.url).slice(0, 10);
}

/**
 * Pull every downloadable-document anchor out of a page's HTML. Filters by
 * file extension AND content-type-ish hints (data attributes etc.). Used by
 * the deep crawler so we don't depend on the AI to surface documents — every
 * spec PDF / IES / drawing / BIM file linked from the product page is fetched.
 *
 * Returns absolute URLs (resolved against baseUrl), deduped, with a guess at
 * the document kind so callers can attach with the right `kind` value.
 */
export type DocumentLink = {
  href: string;
  text: string;
  kind: "datasheet" | "ies" | "drawing" | "image" | "other";
};

const DOC_TEXT_PATTERNS: Array<{ regex: RegExp; kind: DocumentLink["kind"] }> = [
  { regex: /\b(spec(?:ification)?\s?sheet|cut\s?sheet|datasheet|tech\s?(?:nical)?\s?sheet|product\s?sheet|specsheet)\b/i, kind: "datasheet" },
  { regex: /\b(brochure|catalog(?:ue)?|family\s?brochure|leaflet)\b/i, kind: "datasheet" },
  { regex: /\b(installation|install\s?guide|installation\s?instructions?|instruction\s?sheets?|instructions?|user\s?guide|operating|warranty)\b/i, kind: "datasheet" },
  { regex: /\b(ies\s?file|photometric|ldt\s?file|ldt|ies)\b/i, kind: "ies" },
  { regex: /\b(bim|revit|rfa|family\s?file|3d\s?model|step|sketch\s?up|skp)\b/i, kind: "drawing" },
  { regex: /\b(drawing|cad|dwg|dxf|dimension(?:al)?\s?drawing|technical\s?drawing|line\s?drawing)\b/i, kind: "drawing" },
];

function kindFromPathExtension(path: string): DocumentLink["kind"] | null {
  if (path.endsWith(".pdf")) return "datasheet";
  if (path.endsWith(".ies") || path.endsWith(".ldt")) return "ies";
  if (
    path.endsWith(".dwg") || path.endsWith(".dxf") ||
    path.endsWith(".rfa") || path.endsWith(".rvt") ||
    path.endsWith(".skp") || path.endsWith(".step") ||
    path.endsWith(".stp") || path.endsWith(".obj") ||
    path.endsWith(".3ds")
  ) return "drawing";
  if (/\.(jpe?g|png|webp|gif)$/i.test(path)) return "image";
  return null;
}

export function extractDocumentLinks(
  html: string,
  baseUrl: string,
): DocumentLink[] {
  const out: DocumentLink[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }

  // Pass A: anchors. Matches BOTH by URL extension AND by anchor text.
  const aRe = /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") ||
        rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    abs.hash = "";
    const norm = abs.toString();
    const path = abs.pathname.toLowerCase();
    const text = m[4]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

    // Skip same-page navigation (the page that's being parsed).
    let kind = kindFromPathExtension(path);

    // Match by anchor text — catches /download/abc123 style URLs that don't
    // expose a PDF extension on the public URL.
    if (!kind && text) {
      for (const p of DOC_TEXT_PATTERNS) {
        if (p.regex.test(text)) {
          kind = p.kind;
          break;
        }
      }
      // Don't follow text-matched links that look like full HTML pages — only
      // download / file / asset / media-style routes.
      if (kind && !/(\/download|\/file|\/asset|\/media|\/uploads|\/wp-content|\/_files|\/cdn-cgi|\/get|\?download)/i.test(norm)) {
        kind = null;
      }
    }

    // Special case: ZIP archives are documents only when text suggests so.
    if (
      !kind &&
      path.endsWith(".zip") &&
      /(spec|cut[- ]?sheet|datasheet|drawing|ies|photometric|install|bim|revit)/i.test(text)
    ) {
      kind = "drawing";
    }

    if (!kind) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ href: norm, text, kind });
  }

  // Pass B: <link rel="alternate" type="application/pdf"> and similar.
  const linkRe = /<link\b[^>]*?>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const typeAttr = tag.match(/\btype=(?:"([^"]+)"|'([^']+)')/i);
    if (!typeAttr) continue;
    const t = (typeAttr[1] ?? typeAttr[2] ?? "").toLowerCase();
    if (!t.includes("pdf")) continue;
    const hrefAttr = tag.match(/\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (!hrefAttr) continue;
    const raw = hrefAttr[1] ?? hrefAttr[2] ?? hrefAttr[3] ?? "";
    let abs: URL;
    try {
      abs = new URL(raw, base);
    } catch {
      continue;
    }
    abs.hash = "";
    const norm = abs.toString();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ href: norm, text: "Linked PDF", kind: "datasheet" });
  }

  return out;
}

/**
 * STRICT MODE — given a brand's category landing page (e.g.
 * lumenpulse.com/products/linear-cove), return every anchor whose pathname is
 * a SUB-PATH of the category's pathname. No keyword-based fallbacks; we trust
 * that the category page upstream was vetted as in-niche, and that products
 * linked from it which live under its path are in-niche.
 *
 * Excludes navigational sub-paths (downloads / blog / search / etc.) and any
 * URL ending in a file extension.
 */
export function extractProductPageLinks(
  html: string,
  categoryUrl: string,
  // Kept for backwards compatibility; ignored in strict mode.
  _nicheKeywords: string[] = DEFAULT_NICHE_KEYWORDS,
): string[] {
  void _nicheKeywords;
  const out: string[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(categoryUrl);
  } catch {
    return [];
  }
  const host = base.host.replace(/^www\./, "");
  const catPath = base.pathname.replace(/\/+$/, "");
  if (!catPath) return [];

  function isExcludedPath(path: string, sub: string): boolean {
    if (/\.(pdf|ies|ldt|dwg|dxf|rfa|rvt|skp|step|stp|obj|3ds|zip|jpe?g|png|webp|gif|svg|mp4|webm)$/i.test(path)) {
      return true;
    }
    if (
      /\/(downloads?|resources?|documents?|files?|literature|spec[- ]?sheets?|datasheets?|cad|bim|photometrics?|news|press|blog|case-stud|contact|about|careers?|search|results|page\/\d+|tags?|filter|sort|compare|shop|cart|checkout|login|signin|signup|register|account|favorite|wishlist|admin|preview|video)(\/|$)/i.test(
        "/" + sub,
      )
    ) {
      return true;
    }
    return false;
  }

  const aRe = /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") ||
        rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (abs.host.replace(/^www\./, "") !== host) continue;
    abs.hash = "";
    abs.search = "";
    const path = abs.pathname.replace(/\/+$/, "");
    if (path === catPath) continue;
    if (path === "" || path === "/") continue;

    // STRICT: anchor must be a sub-path of the category URL.
    if (!path.startsWith(catPath + "/")) continue;
    const sub = path.slice(catPath.length + 1);
    if (!sub) continue;
    if (isExcludedPath(path, sub)) continue;

    const norm = abs.toString();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * Recursively walk a brand's sitemap (sitemap.xml, sitemap_index.xml, or any
 * sitemap discoverable from /robots.txt) and return every URL on the host.
 *
 * Sitemaps are the most-thorough way to enumerate every URL a brand publishes
 * — they're how Google, Bing, and Lumenpulse's own search rely on indexing
 * their own catalogs. If a sitemap exists, we use it as the source of truth
 * (then filter by niche keywords).
 *
 * Returns up to 5000 URLs deduped, plus the list of sitemap URLs we visited.
 */
export async function crawlSitemapUrls(
  rootUrl: string,
  options: { wallclockMs?: number; maxSitemaps?: number } = {},
): Promise<{
  urls: string[];
  sitemapsVisited: string[];
}> {
  const wallclockMs = options.wallclockMs ?? 30_000;
  const maxSitemaps = options.maxSitemaps ?? 12;
  const startedAt = Date.now();

  const out = new Set<string>();
  const visited = new Set<string>();
  let host: string;
  let origin: string;
  try {
    const u = new URL(rootUrl);
    host = u.host.replace(/^www\./, "");
    origin = u.origin;
  } catch {
    return { urls: [], sitemapsVisited: [] };
  }

  // Discover candidate sitemap URLs.
  const candidates = new Set<string>();
  candidates.add(`${origin}/sitemap.xml`);
  candidates.add(`${origin}/sitemap_index.xml`);
  candidates.add(`${origin}/sitemap-index.xml`);
  candidates.add(`${origin}/sitemaps.xml`);
  candidates.add(`${origin}/wp-sitemap.xml`);
  // Try /robots.txt for additional sitemap hints (with timeout).
  try {
    const r = await fetchWithTimeout(
      `${origin}/robots.txt`,
      {
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA },
      },
      6000,
    );
    if (r.ok) {
      const txt = await r.text();
      const sitemapLines = txt.match(/(?:^|\n)\s*sitemap:\s*(\S+)/gi);
      if (sitemapLines) {
        for (const line of sitemapLines) {
          const m = line.match(/sitemap:\s*(\S+)/i);
          if (m) {
            try {
              const su = new URL(m[1].trim(), origin);
              if (su.host.replace(/^www\./, "") === host) {
                candidates.add(su.toString());
              }
            } catch {
              // skip
            }
          }
        }
      }
    }
  } catch {
    // robots.txt missing or timed out, no problem
  }

  const queue = [...candidates];
  while (queue.length && visited.size < maxSitemaps) {
    if (Date.now() - startedAt > wallclockMs) {
      console.warn(`[crawlSitemapUrls] wallclock budget hit (${wallclockMs}ms), stopping`);
      break;
    }
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    try {
      const r = await fetchWithTimeout(
        sitemapUrl,
        {
          redirect: "follow",
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "application/xml, text/xml, */*",
          },
        },
        8000,
      );
      if (!r.ok) continue;
      const xml = await r.text();
      // Sitemap-index file: <sitemap><loc>...</loc></sitemap>
      const sitemapLocs: string[] = [];
      const sitemapRe = /<sitemap\b[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi;
      let mm: RegExpExecArray | null;
      while ((mm = sitemapRe.exec(xml)) !== null) {
        sitemapLocs.push(mm[1].trim());
      }
      // Push nested sitemaps onto the queue.
      for (const u of sitemapLocs) {
        try {
          const su = new URL(u);
          if (su.host.replace(/^www\./, "") !== host) continue;
          if (!visited.has(su.toString())) queue.push(su.toString());
        } catch {
          // skip
        }
      }
      // URL entries: <url><loc>...</loc></url>
      const urlRe = /<url\b[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi;
      while ((mm = urlRe.exec(xml)) !== null) {
        const raw = mm[1].trim();
        try {
          const u = new URL(raw);
          if (u.host.replace(/^www\./, "") !== host) continue;
          // Skip non-page assets explicitly.
          if (/\.(pdf|ies|ldt|dwg|dxf|jpe?g|png|gif|webp|mp4|webm|zip|xml)$/i.test(u.pathname)) continue;
          u.hash = "";
          // Strip tracking params but keep meaningful query strings.
          ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach(
            (k) => u.searchParams.delete(k),
          );
          out.add(u.toString());
          if (out.size >= 5000) break;
        } catch {
          // skip
        }
      }
      if (out.size >= 5000) break;
    } catch {
      // sitemap missing / invalid — try next candidate
    }
  }
  return { urls: [...out], sitemapsVisited: [...visited] };
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const DEFAULT_NICHE_KEYWORDS = [
  "linear",
  "cove",
  "grazing",
  "graze",
  "wallwash",
  "wall-wash",
  "wash",
  "asymmetric",
  "symmetric",
  "indirect",
  "direct",
  "pendant",
  "suspended",
  "recessed",
  "slot",
  "surface",
  "wall",
  "system",
  "inground",
  "underwater",
  "facade",
  "lumenline",
  "lumenfacade",
  "lumencove",
  "lumenfocus",
  "lumenfacet",
  "lumenframe",
  "lumenbasic",
  "lumenarc",
];

/**
 * Extract document URLs from JSON blobs embedded in a page's HTML.
 *
 * Many SPA-style brand sites (Lumenpulse, Cooper, Acuity Visual Lighting,
 * Brightgreen, etc.) inject the rendered product data directly into the
 * page as an HTML-entity-encoded JSON blob — e.g. on Lumenpulse the page
 * contains a structure like:
 *
 *   [{"id":1,"category":"Specification Sheets","files":[
 *      {"id":"5242:t22545","title":"Short Specsheet - Metric",
 *       "file":{"url":"https://...pdf","extension":"pdf",...},
 *       "file_type":"pdf","file_size":367701, ...
 *      }, ...
 *   ]}, ...]
 *
 * This function extracts every `(category, title, url, extension)` tuple
 * from such blobs. Returns an empty array if no recognizable structure is
 * found — callers can fall back to the anchor-based parser.
 */
export type EmbeddedDocument = {
  category: string;
  title: string;
  url: string;
  ext: string;
  size: number;
};

export function extractEmbeddedDocuments(html: string): EmbeddedDocument[] {
  // HTML-decode entities that the JSON blob is wrapped in.
  const decoded = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");

  const out: EmbeddedDocument[] = [];
  const seen = new Set<string>();

  // Match each `"category":"<name>","files":[ ... ]` and bracket-balance
  // walk the array.
  const catRe = /"category"\s*:\s*"([^"]+)"\s*,\s*"files"\s*:\s*(\[)/g;
  let cm: RegExpExecArray | null;
  while ((cm = catRe.exec(decoded)) !== null) {
    const arrStart = cm.index + cm[0].length - 1;
    let depth = 0;
    let i = arrStart;
    let inString = false;
    let escape = false;
    for (; i < decoded.length; i++) {
      const c = decoded[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { i++; break; } }
    }
    const filesJson = decoded.slice(arrStart, i);
    let files: unknown;
    try {
      files = JSON.parse(filesJson);
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const f of files as Array<Record<string, unknown>>) {
      const fileNode = (f.file ?? {}) as Record<string, unknown>;
      const url =
        (typeof fileNode.url === "string" ? fileNode.url : "") ||
        (typeof f.url === "string" ? (f.url as string) : "") ||
        "";
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const title = String(f.title ?? f.name ?? "").trim();
      const ext =
        String(fileNode.extension ?? f.file_type ?? "").trim().toLowerCase() ||
        (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
      const size = Number(f.file_size ?? fileNode.size ?? 0) || 0;
      out.push({
        category: cm[1].trim(),
        title,
        url,
        ext,
        size,
      });
    }
  }

  return out;
}

/**
 * Find sub-page links labeled "Downloads" / "Resources" / "Documents" / "Files"
 * inside a product page so the deep crawler can follow them and harvest more
 * documents. Many enterprise lighting brands hide PDFs behind a "Downloads"
 * accordion that loads via JS, but the link to the standalone Downloads page
 * is usually still in the static HTML.
 */
export function extractDownloadSubpageLinks(
  html: string,
  baseUrl: string,
  sameHostOnly = true,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const aRe = /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref) continue;
    if (rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (sameHostOnly && abs.host.replace(/^www\./, "") !== base.host.replace(/^www\./, "")) continue;
    const text = m[4]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (
      !/^(downloads?|resources?|documents?|files|literature|spec\s?sheets?|data\s?sheets?|photometrics?|technical(?:\s?(?:downloads?|files|documents?))?|cad(?:\s?files)?|bim(?:\s?files)?)$/i.test(
        text,
      )
    ) continue;
    abs.hash = "";
    const norm = abs.toString();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function extractLinks(
  html: string,
  baseUrl: string,
): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const seen = new Set<string>();
  // Match <a ... href="..."> ...inner... </a>. Greedy enough to capture nested
  // text but cheap to compute.
  const re = /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref) continue;
    if (rawHref.startsWith("#") || rawHref.startsWith("javascript:") ||
        rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) continue;
    let abs: string;
    try {
      abs = new URL(rawHref, base).toString();
    } catch {
      continue;
    }
    // Strip fragment and trailing slashes for de-dup
    const u = new URL(abs);
    u.hash = "";
    const norm = u.toString().replace(/\/+$/, "");
    if (seen.has(norm)) continue;
    seen.add(norm);
    const text = m[4]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    out.push({ href: abs, text });
  }
  return out;
}

export function isPdf(mime: string, name: string): boolean {
  return mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}
export function isSpreadsheet(mime: string, name: string): boolean {
  const n = name.toLowerCase();
  return (
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv") || n.endsWith(".tsv")
  );
}
export function isImage(mime: string, name: string): boolean {
  return mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/**
 * Take a raw uploaded file (or already-fetched URL bytes) and convert it into
 * something the model can ingest: text, or a vision image.
 */
export async function parseFile(
  buf: Buffer | Uint8Array,
  mime: string,
  name: string,
): Promise<ParsedSource> {
  if (isPdf(mime, name)) {
    return { label: name, text: await pdfBufferToText(buf) };
  }
  if (isSpreadsheet(mime, name)) {
    return { label: name, text: xlsxBufferToText(buf, name) };
  }
  if (isImage(mime, name)) {
    const b64 = Buffer.from(buf).toString("base64");
    const dataUrl = `data:${mime || "image/png"};base64,${b64}`;
    return { label: name, text: "[image attached]", imageDataUrl: dataUrl };
  }
  // Plain-ish text file
  const text = clip(Buffer.from(buf).toString("utf8"));
  return { label: name, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional document-discovery extractors for doc-extractor resilience.
// All three are pure HTML→URL functions: no I/O, no AI. They run AFTER the
// existing embedded-JSON + anchor-scrape passes and are cheap, so we can
// stack them defensively. iGuzzini-class sites with tab-hidden docs benefit
// most. Lumenpulse/Axis/etc. who already surface docs via embedded JSON or
// plain anchors won't change behaviour (extractors return [] or duplicates
// the caller dedupes).
// ─────────────────────────────────────────────────────────────────────────────

const DOC_EXTENSION_RX =
  /\.(pdf|ies|ldt|dwg|dxf|rfa|rvt|skp|step|stp|obj|3ds|zip|csv|xlsx?)(?:\?|#|$)/i;

/**
 * Extract document URLs from any `<script type="application/ld+json">` block.
 * Common shapes:
 *  - Product schema with `manualUrl`, `documentation`, `installationManual`,
 *    `additionalProperty` containing URL values.
 *  - Custom keys like `downloads`, `documents`, `files`, `assets`, `pdf`
 *    appearing anywhere in the JSON tree.
 * Strategy: recursively walk the parsed JSON-LD and collect every string
 * that looks like an absolute URL with a known doc extension.
 */
export function extractJsonLdDocuments(
  html: string,
): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  const re =
    /<script\b[^>]*?type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJsonForDocUrls(parsed, "", (url, label) => {
      const u = url.trim();
      if (seen.has(u)) return;
      seen.add(u);
      out.push({ url: u, label });
    });
  }
  return out;
}

function walkJsonForDocUrls(
  node: unknown,
  pathKey: string,
  emit: (url: string, label: string) => void,
): void {
  if (node == null) return;
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node) && DOC_EXTENSION_RX.test(node)) {
      emit(node, pathKey || "JSON-LD asset");
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForDocUrls(item, pathKey, emit);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walkJsonForDocUrls(v, pathKey ? `${pathKey}.${k}` : k, emit);
    }
  }
}

/**
 * Extract absolute document URLs embedded in any inline `<script>` blob.
 * Many enterprise sites (iGuzzini, ERCO, others) inject product asset data
 * into `window.__INITIAL_STATE__`, `__NEXT_DATA__`, `__NUXT__`, or a custom
 * global as a JSON string. The URLs are there but not in a parseable JSON-LD
 * block — a regex over script content surfaces them.
 *
 * The regex looks for `https://…` strings ending in a known document
 * extension and rejects obvious image-CDN spam. Returns deduped URLs.
 */
export function extractInlineScriptDocumentUrls(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Pull every <script>…</script> body. We intentionally skip
  // type="application/ld+json" (handled separately) but match the rest.
  const scriptRe =
    /<script\b(?![^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  // URLs ending in a known doc extension. Captures the full URL via a
  // tightly-bounded character set so we don't grab the rest of the JS line.
  const urlRe =
    /https?:\/\/[\w.\-/%?&=:@~,!*+#]+?\.(?:pdf|ies|ldt|dwg|dxf|rfa|rvt|skp|step|stp|obj|3ds|zip|csv|xlsx?)(?:\?[\w.\-/%?&=:@~,!*+#]*)?/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    const body = sm[1];
    if (!body) continue;
    // JSON strings often have backslash escapes — convert \/ → / and
    // / → / before scanning so escaped URLs aren't missed.
    const clean = body
      .replace(/\\\//g, "/")
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\u0026/g, "&");
    let um: RegExpExecArray | null;
    while ((um = urlRe.exec(clean)) !== null) {
      const u = um[0]
        // Strip trailing punctuation that the regex may have grabbed.
        .replace(/[",;)]+$/, "");
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Download button" extractor — handles the iGuzzini / ERCO / XAL pattern
// where the anchor text is just "DOWNLOAD" (generic verb) and the actual
// document label lives in a SIBLING element, often grouped under a section
// heading. The plain anchor scrape in `extractDocumentLinks` misses these
// because:
//   1. The URL frequently has NO file extension (e.g. /download/abc123).
//   2. The anchor text alone ("DOWNLOAD") doesn't match doc text patterns.
// We rescue them by walking back through the surrounding HTML to find the
// nearest preceding non-anchor text element (the row's title) and the
// nearest preceding heading (the section). Combined → label + section.
// ─────────────────────────────────────────────────────────────────────────────

// Anchor text that's "just a download verb" — these are the buttons whose
// container text holds the real label.
const DOWNLOAD_VERB_RX =
  /^\s*(?:[↓⇓⬇]|download|télécharger|telecharger|scarica|descargar|herunterladen|baixar|下载|ダウンロード|загрузить|загрузка|tải xuống|pdf|get(?:[\s-]?(?:file|download|pdf))?|view(?:[\s-]?(?:pdf|file))?|open[\s-]?pdf)\s*$/i;

// URL patterns we trust as asset/file routes even without a known extension.
const ASSET_URL_RX =
  /(?:\/download|\/file|\/asset|\/media|\/uploads|\/wp-content|\/cdn-cgi|\/get|\/dl|\/files|\/documents|\/datasheets?|\/spec-sheets?|\/cut-sheets?|\?download|\?file|\?asset|\?dl)/i;

/**
 * Walk back through `prefix` (the HTML chunk immediately preceding an
 * anchor) and return the nearest non-anchor text content. This is the
 * row's descriptive label when the page uses a "label + DOWNLOAD button"
 * layout. Returns "" if no plausible label was found.
 */
function nearestPrecedingLabel(prefix: string): string {
  // Strip out any <a>...</a> content fully — we don't want anchor text from
  // an earlier row to leak in. Replace with a boundary marker so the chunk
  // split below still respects row separation.
  let clean = prefix.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "│");
  // Strip <script>, <style>, <noscript>, <svg> bodies entirely.
  clean = clean
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  // Treat block-level tag boundaries as chunk separators so the row's
  // label stays distinct from preceding rows / section headers.
  clean = clean.replace(
    /<\/?(?:tr|td|th|li|dl|dt|dd|h[1-6]|div|section|article|p|header|footer|nav|main|tbody|thead|tfoot|table|ul|ol|details|summary|figure|figcaption)\b[^>]*>/gi,
    "│",
  );
  // Strip remaining inline tags (span, strong, em, i, b, etc.).
  clean = clean.replace(/<[^>]+>/g, " ");
  // Decode common entities.
  clean = clean
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, " ");

  // Split on the boundary marker and walk backwards for the first chunk that
  // looks like a real label. Skip empty chunks, chunks that are just a
  // download verb, and chunks that are too long (those are paragraphs of
  // marketing copy, not labels).
  const chunks = clean.split("│");
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i].replace(/\s+/g, " ").trim();
    if (!c) continue;
    if (c.length < 3) continue;
    if (c.length > 200) continue;
    if (DOWNLOAD_VERB_RX.test(c)) continue;
    return c;
  }
  return "";
}

/**
 * Walk back through `prefix` to find the nearest `<h1>-<h6>` heading. Used
 * to give a label its section context — e.g. an anchor whose row says "IES"
 * sitting under a "PHOTOMETRIC DATA" heading should be classified as ies.
 */
function nearestPrecedingHeading(prefix: string): string {
  const re = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let last = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) {
    const txt = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (txt && txt.length < 120) last = txt;
  }
  return last;
}

/**
 * Find every "Download" button on the page where the descriptive label sits
 * in a sibling element. Returns DocumentLinks with the rescued label so the
 * classifier downstream picks the right `kind` (spec-sheet, IES, drawing…).
 *
 * Complements `extractDocumentLinks`: that one matches anchors by anchor
 * text + URL extension. This one matches anchors whose text is too generic
 * to recognise on its own but whose surrounding HTML reveals the label.
 */
export function extractDownloadButtonLinks(
  html: string,
  baseUrl: string,
): DocumentLink[] {
  const out: DocumentLink[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }

  const aRe =
    /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref) continue;
    if (
      rawHref.startsWith("#") ||
      rawHref.startsWith("javascript:") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("tel:")
    ) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    abs.hash = "";
    const norm = abs.toString();
    if (seen.has(norm)) continue;

    // Anchor's raw text (inner HTML stripped to text).
    const anchorText = m[4]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Two gates — keep ONLY if BOTH triggered:
    //  (a) anchor text is just a "download" verb (no useful info on its own)
    //  (b) URL points to the same host OR has an asset-route hint
    // The combination keeps noise out (random "Download our app" CTAs on
    // unrelated hosts) while catching the real product downloads.
    const isGenericDownload = DOWNLOAD_VERB_RX.test(anchorText);
    if (!isGenericDownload) continue;

    const sameHost =
      abs.host.replace(/^www\./, "") === base.host.replace(/^www\./, "");
    const looksLikeAsset = ASSET_URL_RX.test(norm);
    const hasDocExt = !!kindFromPathExtension(abs.pathname.toLowerCase());
    if (!sameHost && !looksLikeAsset && !hasDocExt) continue;

    // Recover the label from surrounding HTML.
    const prefixStart = Math.max(0, m.index - 1200);
    const prefix = html.slice(prefixStart, m.index);
    const rowLabel = nearestPrecedingLabel(prefix);
    if (!rowLabel) {
      // No nearby label means we can't tell what this file is. Skip rather
      // than store an unhelpful "DOWNLOAD" entry — the AI rung will see it
      // separately via the anchor pool.
      continue;
    }
    // Section heading (search a bit further back) for kind classification.
    const headingPrefix = html.slice(Math.max(0, m.index - 4000), m.index);
    const section = nearestPrecedingHeading(headingPrefix);

    // Classify by URL extension if present; otherwise by the label, then
    // by the section heading as a last resort. Order matters: extension is
    // ground truth; label is usually more specific than section.
    let kind: DocumentLink["kind"] | null = kindFromPathExtension(
      abs.pathname.toLowerCase(),
    );
    if (!kind) {
      const haystack = `${section} | ${rowLabel}`;
      for (const p of DOC_TEXT_PATTERNS) {
        if (p.regex.test(haystack)) {
          kind = p.kind;
          break;
        }
      }
    }
    if (!kind) kind = "other";

    // Build a display label that includes the section so downstream UIs
    // group these properly (e.g. "PHOTOMETRIC DATA — IES").
    const label = section
      ? `${section.replace(/[\s·]+/g, " ").trim()} — ${rowLabel}`.slice(
          0,
          200,
        )
      : rowLabel.slice(0, 200);

    seen.add(norm);
    out.push({ href: norm, text: label, kind });
  }
  return out;
}

/**
 * Generate alternative tab-URL variants for a product page that didn't
 * surface any documents on the default tab. Many enterprise lighting sites
 * use either URL fragments (`#downloads`) or query params (`?tab=downloads`)
 * to switch tabs. We try a few common ones — anything beyond this list is
 * unlikely to be standard.
 *
 * Returns URLs that DIFFER from the input (no duplicates, no the-same-URL).
 * Caller is expected to fetch/render each one and re-run the doc extractors.
 */
export function alternateTabUrls(productUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(productUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>([productUrl]);
  const fragments = [
    "downloads",
    "documentation",
    "documents",
    "technical-data",
    "technical",
    "specs",
    "tech-data",
    "resources",
    "files",
    "downloads-and-files",
  ];
  for (const frag of fragments) {
    const u = new URL(base.toString());
    u.hash = frag;
    const s = u.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  // Also try `?tab=` query variants for SPAs that read state from query.
  for (const frag of ["downloads", "documentation", "tech-data", "resources"]) {
    const u = new URL(base.toString());
    u.hash = "";
    u.searchParams.set("tab", frag);
    const s = u.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
