// Direct HTML product scraper. Pulls structured product data straight out
// of the page HTML — JSON-LD schema.org/Product blocks, og:image meta tags,
// itemprop="image" links, etc. This is strictly better than asking
// Perplexity to "read the page" because:
//   1) The data is authored by the merchant for SEO and is therefore
//      reliably present on every modern e-commerce platform (PrestaShop,
//      Magento, WooCommerce, BigCommerce, Wix, Squarespace, ...).
//   2) It's deterministic — no LLM hallucination, no Perplexity rate limits.
//   3) It runs in ~1 second vs 10-40s for the AI pipeline.
//
// The extractor uses this as a primary source whenever it returns enough
// data; the AI pipeline is reserved for sites that don't surface
// structured data.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type HtmlProductScrape = {
  name: string | null;
  description: string | null;
  productCode: string | null; // SKU / MPN
  brand: string | null;
  // The single best image — og:image is usually the canonical product photo.
  thumbnailUrl: string | null;
  // Every distinct product image URL we could find on the page.
  imageUrls: string[];
  // The page URL itself (in case we follow a redirect).
  canonicalUrl: string | null;
};

// Decode HTML entities found in meta tag content / structured data values.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|li|h\d|div|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

// Promote a possibly-relative image URL to absolute using the page's origin.
function absolutise(href: string | null, base: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

// Pull every meta tag content for the given property/name. Some sites
// repeat og:image with different sizes — keep them all.
function findMetaAll(
  html: string,
  prop: string,
  attr: "property" | "name" = "property",
): string[] {
  const rx = new RegExp(
    `<meta\\s+[^>]*${attr}\\s*=\\s*["']${prop}["'][^>]*content\\s*=\\s*["']([^"']+)["']|<meta\\s+[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*${attr}\\s*=\\s*["']${prop}["']`,
    "gi",
  );
  const out: string[] = [];
  for (const m of html.matchAll(rx)) {
    const value = m[1] ?? m[2];
    if (value) out.push(decodeHtmlEntities(value.trim()));
  }
  return out;
}

function findMeta(
  html: string,
  prop: string,
  attr: "property" | "name" = "property",
): string | null {
  return findMetaAll(html, prop, attr)[0] ?? null;
}

// Walk every <script type="application/ld+json">...</script> block, parse
// each one, and return the first Product node we can find. Schema.org
// allows the script to contain a single object, an array of objects, or a
// graph object ({ "@graph": [...] }).
function findProductJsonLd(html: string): Record<string, unknown> | null {
  const rx =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = Array.from(html.matchAll(rx));
  for (const m of matches) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some sites embed JSON5-ish content; try a tolerant pass — strip
      // trailing commas inside arrays/objects.
      try {
        parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1"));
      } catch {
        continue;
      }
    }
    const product = findProductInJsonLd(parsed);
    if (product) return product;
  }
  return null;
}

function findProductInJsonLd(
  node: unknown,
): Record<string, unknown> | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findProductInJsonLd(item);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isProduct = (t: unknown): boolean => {
    if (t === "Product") return true;
    if (Array.isArray(t)) return t.some((x) => x === "Product");
    return false;
  };
  if (isProduct(type)) return obj;
  // Recurse into @graph and other nested containers.
  for (const key of Object.keys(obj)) {
    if (key === "@type") continue;
    const child = obj[key];
    if (child && typeof child === "object") {
      const hit = findProductInJsonLd(child);
      if (hit) return hit;
    }
  }
  return null;
}

// Flatten schema.org's `image` field — it can be a string, an ImageObject,
// or an array of either. Returns an array of distinct URLs.
function flattenImageField(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) out.push(...flattenImageField(v));
    return out;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === "string") return [obj.url];
    if (typeof obj.contentUrl === "string") return [obj.contentUrl];
  }
  return [];
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

// Walk every JSON-LD block looking for the page-publisher's organization /
// website name. Useful when there's no Product schema (manufacturer info
// pages, WordPress + Yoast sites, etc.) — the Organization or WebSite
// node still tells us the brand. Returns the first name we find.
function findOrganizationName(html: string): string | null {
  const rx =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of Array.from(html.matchAll(rx))) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1"));
      } catch {
        continue;
      }
    }
    const hit = findOrgInJsonLd(parsed);
    if (hit) return hit;
  }
  return null;
}

function findOrgInJsonLd(node: unknown): string | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findOrgInJsonLd(item);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isOrg = (t: unknown): boolean => {
    if (t === "Organization" || t === "WebSite") return true;
    if (Array.isArray(t)) return t.some((x) => x === "Organization" || x === "WebSite");
    return false;
  };
  if (isOrg(type)) {
    const name = asString(obj.name);
    if (name) return name;
  }
  for (const key of Object.keys(obj)) {
    if (key === "@type") continue;
    const child = obj[key];
    if (child && typeof child === "object") {
      const hit = findOrgInJsonLd(child);
      if (hit) return hit;
    }
  }
  return null;
}

// Best-effort name + image picker from raw HTML when JSON-LD isn't there.
// Scans <link itemprop="image">, <img itemprop="image">, generic product
// image classes, and twitter:image meta as a fallback.
function findFallbackImages(html: string, base: string): string[] {
  const urls: string[] = [];

  // <link itemprop="image" href="...">
  for (const m of html.matchAll(
    /<link\s+[^>]*itemprop\s*=\s*["']image["'][^>]*href\s*=\s*["']([^"']+)["']/gi,
  )) {
    const abs = absolutise(m[1], base);
    if (abs) urls.push(abs);
  }
  // <img itemprop="image" src="...">
  for (const m of html.matchAll(
    /<img\s+[^>]*itemprop\s*=\s*["']image["'][^>]*src\s*=\s*["']([^"']+)["']/gi,
  )) {
    const abs = absolutise(m[1], base);
    if (abs) urls.push(abs);
  }
  // <link rel="image_src" href="...">
  for (const m of html.matchAll(
    /<link\s+[^>]*rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/gi,
  )) {
    const abs = absolutise(m[1], base);
    if (abs) urls.push(abs);
  }
  // twitter:image is sometimes the only one set.
  const tw = findMeta(html, "twitter:image", "name");
  if (tw) {
    const abs = absolutise(tw, base);
    if (abs) urls.push(abs);
  }
  return urls;
}

export async function scrapeHtmlProduct(
  url: string,
): Promise<HtmlProductScrape | null> {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let res: Response;
  try {
    res = await fetch(trimmed, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } catch (err) {
    console.warn(`[scrapeHtmlProduct] network error for ${trimmed}`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[scrapeHtmlProduct] HTTP ${res.status} for ${trimmed}`);
    return null;
  }
  const canonical = res.url || trimmed;
  let html: string;
  try {
    html = await res.text();
  } catch (err) {
    console.warn(`[scrapeHtmlProduct] body read failed for ${trimmed}`, err);
    return null;
  }
  if (!html) return null;

  // 1) Try the JSON-LD Product schema. It's the strongest signal.
  const product = findProductJsonLd(html);

  let name: string | null = null;
  let description: string | null = null;
  let productCode: string | null = null;
  let brand: string | null = null;
  const imageSet = new Set<string>();

  if (product) {
    name = asString(product.name);
    const rawDescription = asString(product.description);
    if (rawDescription) {
      description = stripHtml(rawDescription);
    }
    // Product code — try sku, then mpn, then model, then gtin13.
    productCode =
      asString(product.sku) ??
      asString(product.mpn) ??
      asString(product.model) ??
      asString(product.gtin13) ??
      asString(product.gtin12) ??
      asString(product.gtin) ??
      null;
    // Brand can be a string or { @type: "Brand", name: "..." }.
    if (typeof product.brand === "string") {
      brand = product.brand;
    } else if (product.brand && typeof product.brand === "object") {
      const b = product.brand as Record<string, unknown>;
      brand = asString(b.name);
    }
    for (const u of flattenImageField(product.image)) {
      const abs = absolutise(u, canonical);
      if (abs) imageSet.add(abs);
    }
  }

  // Brand fallback chain when JSON-LD Product didn't have it (or there's
  // no Product schema at all — e.g. WooCommerce/Yoast info pages).
  if (!brand) brand = findMeta(html, "og:site_name") ?? null;
  if (!brand) brand = findOrganizationName(html);

  // 2) og:image — this is almost always the canonical product hero photo
  //    on a product page. Add every og:image (some sites set multiple).
  for (const og of findMetaAll(html, "og:image")) {
    const abs = absolutise(og, canonical);
    if (abs) imageSet.add(abs);
  }

  // 3) og:title / og:description if JSON-LD didn't give us those.
  if (!name) {
    name =
      findMeta(html, "og:title") ??
      findMeta(html, "twitter:title", "name") ??
      // <title> tag — strip the suffix after a separator if there is one.
      (() => {
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return m ? decodeHtmlEntities(m[1].trim()) : null;
      })();
  }
  if (!description) {
    const meta =
      findMeta(html, "og:description") ??
      findMeta(html, "description", "name") ??
      findMeta(html, "twitter:description", "name");
    if (meta) description = decodeHtmlEntities(meta).trim();
  }

  // 4) Fallback image sources for sites without JSON-LD or og:image.
  for (const u of findFallbackImages(html, canonical)) {
    imageSet.add(u);
  }

  // De-duplicate by stripping query strings that only differ by image-size
  // params (PrestaShop and Magento often inline multiple cache-busting
  // thumbnails of the same picture). Keep the largest by URL length as a
  // crude heuristic — bigger query strings usually carry the size param.
  const images = Array.from(imageSet);
  if (!images.length && !name) return null;

  return {
    name,
    description,
    productCode,
    brand,
    thumbnailUrl: images[0] ?? null,
    imageUrls: images,
    canonicalUrl: canonical,
  };
}
