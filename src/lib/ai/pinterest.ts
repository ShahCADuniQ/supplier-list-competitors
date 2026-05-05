// Pinterest image extractor — static-fetch only.
//
// URL-aware behaviour:
//   • Pin URL (`/pin/<id>/`)   → only the canonical pin image(s).
//                                Pinterest emits the main pin image as a
//                                <link rel="preload" as="image" href="…/736x/…">
//                                tag; we take only preloads at the LARGEST
//                                size present so we don't pull related-pin
//                                thumbnails that are also preloaded.
//   • Board / profile / other  → every pinimg.com image URL inlined in the
//                                static HTML, deduped to /originals/.
//
// Static fetch is fast (~300-400 ms) and avoids the related-pins / "more
// like this" feed that loads dynamically after JS hydration.

/**
 * Pinterest CDN URLs follow size-keyed paths: `/236x/...`, `/474x/...`,
 * `/736x/...`, `/1200x/...`, `/60x60/...`, `/45x45_RS/...`, etc. Rewrite
 * to `/originals/` for the canonical full-resolution copy.
 */
function pinterestOriginalUrl(u: string): string {
  return u.replace(
    /(https?:\/\/i\.pinimg\.com)\/\d+(?:x\d*|x)(?:_RS)?\//i,
    "$1/originals/",
  );
}

/** Reject Pinterest chrome / app-icon URLs that aren't pin photos. */
function isPinterestChromeUrl(u: string): boolean {
  if (/^https?:\/\/s\.pinimg\.com\//i.test(u)) return true;
  if (/\/webapp\//i.test(u)) return true;
  if (/\b(favicon|logo)\b/i.test(u)) return true;
  if (/\/upload\/.*board_thumbnail/i.test(u)) return true;
  return false;
}

/** Match a pin URL — `pinterest.com/pin/<numeric-id>/`. */
function isPinUrl(url: string): boolean {
  try {
    return /\/pin\/\d+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Pull `<link rel="preload" as="image" href="...">` URLs from a chunk of
 * HTML. Returns each href as-is (we filter / dedupe later).
 */
function preloadUrls(html: string): string[] {
  const out: string[] = [];
  const re =
    /<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/gi;
  for (const m of html.matchAll(re)) out.push(m[1]);
  // Some older variants put `as="image"` before `rel="preload"`, so scan that
  // ordering too.
  const re2 =
    /<link[^>]+as=["']image["'][^>]+rel=["']preload["'][^>]+href=["']([^"']+)["']/gi;
  for (const m of html.matchAll(re2)) out.push(m[1]);
  return out;
}

/**
 * From a list of Pinterest CDN URLs, find the largest size variant present.
 * Returns the size token (e.g. "736x", "1200x") or null if none match.
 */
function largestSizeToken(urls: string[]): string | null {
  let best: { token: string; px: number } | null = null;
  for (const u of urls) {
    const m = u.match(/\/i\.pinimg\.com\/(\d+)(x\d*|x)(?:_RS)?\//i);
    if (!m) continue;
    const px = parseInt(m[1], 10);
    if (isNaN(px)) continue;
    const token = `${m[1]}${m[2]}`;
    if (!best || px > best.px) best = { token, px };
  }
  return best?.token ?? null;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export type PinterestExtractResult = {
  images: string[];
  finalUrl: string;
  /** Discriminator so callers can show appropriate counts in toasts. */
  kind: "pin" | "board-or-profile";
};

export async function extractPinterestImagesViaBrowser(
  url: string,
): Promise<PinterestExtractResult> {
  // Static fetch with a real Safari UA — Pinterest serves a 900 KB+ HTML
  // body that already contains every preload / inlined pinimg URL we need.
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`Pinterest returned ${res.status} for ${url}`);
  }
  const finalUrl = res.url;
  const html = await res.text();

  if (isPinUrl(finalUrl)) {
    // ── PIN URL: only return the pin's actual canonical image(s). ──
    // Pinterest's <link rel="preload" as="image"> tags include the main pin
    // image at the LARGEST size (typically 736x or 1200x). Smaller preloads
    // (e.g. 75x75_RS) are nav thumbs / related items — drop them.
    const preloads = preloadUrls(html).filter((u) =>
      /^https?:\/\/i\.pinimg\.com\//i.test(u),
    );
    const largest = largestSizeToken(preloads);
    const canonical = preloads.filter((u) =>
      largest
        ? new RegExp(`/i\\.pinimg\\.com/${largest}/`, "i").test(u)
        : false,
    );
    const out = new Set<string>();
    for (const u of canonical) {
      if (isPinterestChromeUrl(u)) continue;
      out.add(pinterestOriginalUrl(u));
    }
    // Belt-and-suspenders: if for some reason no preload was at the largest
    // size, also accept any /originals/ URL that appears explicitly in the
    // static HTML — those are usually only emitted for the canonical pin.
    if (out.size === 0) {
      for (const m of html.matchAll(
        /https?:\/\/i\.pinimg\.com\/originals\/[^\s"'<>\\]+\.(?:jpe?g|png|webp|gif|avif)/gi,
      )) {
        if (!isPinterestChromeUrl(m[0])) out.add(m[0]);
      }
    }
    return { images: [...out], finalUrl, kind: "pin" };
  }

  // ── BOARD / PROFILE / OTHER: every inline pinimg URL. ──
  // Boards inline many pins (one per visible tile). The static HTML usually
  // contains 30-60 tiles per page — enough for a useful brainstorm pull.
  const out = new Set<string>();
  for (const m of html.matchAll(
    /https?:\/\/(?:i|s)\.pinimg\.com\/[^\s"'<>\\]+\.(?:jpe?g|png|webp|gif|avif)/gi,
  )) {
    const u = m[0];
    if (isPinterestChromeUrl(u)) continue;
    out.add(pinterestOriginalUrl(u));
  }
  return { images: [...out], finalUrl, kind: "board-or-profile" };
}
