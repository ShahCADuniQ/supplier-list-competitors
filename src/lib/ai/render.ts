// Headless-browser HTML rendering for JS-rendered SPA brand sites.
//
// Some brand sites (SuperModular, many Vue/React/Angular catalogs) only
// expose product data after JavaScript has executed — the static HTML
// returned by `fetch` is empty. Playwright drives a real Chromium instance
// so the page can render, then we serialize the DOM back to HTML and feed
// it through our existing parsers.
//
// Usage notes:
//   • Playwright is loaded via dynamic import so the bundle never includes
//     Chromium binaries server-side.
//   • A SINGLE persistent browser is shared across calls inside one process —
//     spinning up Chromium for every render is ~1.5s of overhead we'd rather
//     amortize. The browser is closed when the Node process exits.
//   • Every call has a hard wallclock timeout (default 25s) so a hung page
//     can't stall the whole pipeline.
//   • Resource-blocking is enabled by default — no images, fonts, media,
//     analytics, ads — to render product lists faster (~3-8s typical).

import type { Browser, BrowserContext, Page } from "playwright";

let browserPromise: Promise<Browser> | null = null;

/**
 * Lazy-singleton Chromium launcher. Subsequent calls reuse the same browser.
 * Crashes / disconnects reset the singleton so the next call retries.
 */
async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = (async () => {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    b.once("disconnected", () => {
      browserPromise = null;
    });
    return b;
  })();
  return browserPromise;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export type RenderOptions = {
  /** Hard wallclock limit (ms) for the whole render. Default 25_000. */
  timeoutMs?: number;
  /** Wait for `networkidle` (default) or `load` (faster). */
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  /**
   * Optional CSS selector — once present, we know the page is "ready". Useful
   * for category pages where we want to wait until product cards render.
   */
  waitForSelector?: string;
  /** Block heavy resources (images/fonts/media) for speed. Default true. */
  blockResources?: boolean;
  /**
   * Scroll the page to the bottom up to N times (with a settle pause between
   * scrolls) to trigger lazy-loaded / intersection-observer-driven content
   * on infinite-scroll product grids. Default 0 (disabled).
   */
  scrollPasses?: number;
  /**
   * After scrolling, click any "Load more" / "Show all" / "View all" /
   * "+ more" button and accept cookie banners — the kind of click-to-reveal
   * UI that hides products behind a single button. Default false.
   */
  clickToReveal?: boolean;
};

export type RenderResult = {
  html: string;
  finalUrl: string;
  status: number;
  timings: { totalMs: number };
};

/**
 * Render a URL through Chromium and return the post-JS HTML. Caller can pass
 * the result through extractProductPageLinks / extractDocumentLinks etc.
 *
 * Returns an empty `html` string and `status: 0` if the render failed (timeout,
 * navigation error, etc.) — the caller decides whether to fall back further.
 */
/**
 * Heuristic — does this rendered HTML look like a bot-challenge interstitial
 * (Cloudflare "Just a moment...", Akamai/Imperva CAPTCHA wall) rather than
 * the real page? When TRUE, the caller should retry without resource blocking
 * — these challenges run JS that needs stylesheets/cookie scripts to execute.
 */
function looksLikeBotChallenge(html: string): boolean {
  if (!html) return true;
  // Cloudflare's challenge page is consistently small (< 60 KB) and contains
  // these signatures.
  if (html.length > 80_000) return false;
  const sig = [
    "Just a moment",
    "Performing security verification",
    "challenges.cloudflare.com",
    "cf-browser-verification",
    "Checking if the site connection is secure",
    "Please enable JS and disable any ad blocker",
    "/cdn-cgi/challenge-platform/",
    "Imperva",
    "Distil Networks",
    "_Incapsula_Resource",
    "AkamaiBot",
  ];
  return sig.some((s) => html.includes(s));
}

export async function renderPageHtml(
  url: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const r = await renderPageHtmlInner(url, options);
  // If we got a bot-challenge interstitial AND we were blocking resources,
  // retry once with resources unblocked. Cloudflare/Akamai's JS challenges
  // need stylesheets and tracking-script subrequests to complete.
  if (
    r.html &&
    looksLikeBotChallenge(r.html) &&
    (options.blockResources ?? true)
  ) {
    console.warn(
      `[renderPageHtml] bot-challenge interstitial detected for ${url}; retrying with resources unblocked`,
    );
    const retry = await renderPageHtmlInner(url, {
      ...options,
      blockResources: false,
      // Give the challenge JS a bit more wallclock to redirect.
      timeoutMs: Math.max(options.timeoutMs ?? 25_000, 35_000),
    });
    if (retry.html && !looksLikeBotChallenge(retry.html)) return retry;
    return retry.html ? retry : r;
  }
  return r;
}

async function renderPageHtmlInner(
  url: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const startedAt = Date.now();
  const timeout = options.timeoutMs ?? 25_000;
  const blockResources = options.blockResources ?? true;
  const waitUntil = options.waitUntil ?? "networkidle";

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ignoreHTTPSErrors: true,
    });

    if (blockResources) {
      await context.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "font" || t === "media" || t === "stylesheet") {
          return route.abort();
        }
        const u = route.request().url();
        if (
          /(google-analytics|googletagmanager|doubleclick|hotjar|segment|mixpanel|fullstory|optimizely|cloudflareinsights|cdn\.cookielaw)/i.test(
            u,
          )
        ) {
          return route.abort();
        }
        return route.continue();
      });
    }

    page = await context.newPage();
    let status = 0;
    page.on("response", (res) => {
      if (res.url() === url || res.url() === url + "/") {
        status = res.status();
      }
    });

    const navResp = await page.goto(url, { waitUntil, timeout });
    if (navResp) status = navResp.status();

    if (options.waitForSelector) {
      // Soft-wait — a missing selector shouldn't fail the whole render.
      await page
        .waitForSelector(options.waitForSelector, { timeout: 6000 })
        .catch(() => undefined);
    }

    // Give Vue/React a moment to finish hydrating after networkidle resolves.
    await page.waitForTimeout(400);

    // Click-to-reveal: dismiss cookie banners + click any "load more" /
    // "show all" / "view all products" buttons. We do this BEFORE scrolling
    // so newly-revealed content participates in the scroll-stabilization
    // anchor-count check below.
    if (options.clickToReveal) {
      try {
        // Cookie banners — common idents across OneTrust, Cookiebot, custom.
        await page.evaluate(() => {
          const sel = [
            "#onetrust-accept-btn-handler",
            "#CybotCookiebotDialogBodyLevelButtonAccept",
            "button[aria-label*='accept' i]",
            "button[id*='accept' i]",
          ].join(",");
          const el = document.querySelector(sel) as HTMLButtonElement | null;
          if (el) el.click();
        });
        await page.waitForTimeout(400);
      } catch {
        // Best-effort
      }
      // Click reveal buttons in a loop — pages often have multiple
      // ("show 12 more" → "show 12 more" → ... ) until the list is exhausted.
      for (let pass = 0; pass < 6; pass++) {
        const clicked = await page.evaluate(() => {
          const TEXT_RE =
            /(load|show|view|see|browse)[\s-]*(all|more|additional|further)|(\+\s*\d+|more products|all products|tout afficher|tous les produits|alle anzeigen|mostrar todo|carica altri|altri prodotti)/i;
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              "button, a[role=button], a[href='#'], [role=button], .btn, .button, [class*='load-more'], [class*='show-more'], [class*='view-all'], [data-loadmore]",
            ),
          );
          for (const el of candidates) {
            const txt = (el.textContent || "").trim();
            if (txt.length === 0 || txt.length > 80) continue;
            if (!TEXT_RE.test(txt)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            (el as HTMLElement).click();
            return txt;
          }
          return null;
        });
        if (!clicked) break;
        await page.waitForTimeout(900);
      }
      // Open accordion / details elements that hide product children.
      try {
        await page.evaluate(() => {
          for (const d of Array.from(document.querySelectorAll("details"))) {
            (d as HTMLDetailsElement).open = true;
          }
          // ARIA-collapsed expanders — flip aria-expanded to true and click.
          for (const el of Array.from(
            document.querySelectorAll<HTMLElement>("[aria-expanded='false']"),
          )) {
            try { el.click(); } catch { /* ignore */ }
          }
        });
        await page.waitForTimeout(400);
      } catch {
        // ignore
      }
    }

    // Optional scroll passes for lazy-loaded grids. Stop early when the
    // anchor count stabilises (no new content appeared between scrolls).
    if (options.scrollPasses && options.scrollPasses > 0) {
      let prevCount = -1;
      for (let i = 0; i < options.scrollPasses; i++) {
        const count = await page
          .$$eval("a[href]", (els) => els.length)
          .catch(() => 0);
        if (i > 0 && count === prevCount) break;
        prevCount = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
      }
    }

    const html = await page.content();
    const finalUrl = page.url();
    return {
      html,
      finalUrl,
      status,
      timings: { totalMs: Date.now() - startedAt },
    };
  } catch (e) {
    console.warn(`[renderPageHtml] failed for ${url}:`, e);
    return {
      html: "",
      finalUrl: url,
      status: 0,
      timings: { totalMs: Date.now() - startedAt },
    };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (context) await context.close().catch(() => undefined);
  }
}

/**
 * Convenience helper — renders the URL and returns true if the rendered HTML
 * is "meaningful" (= dramatically larger than the raw fetched HTML, or
 * contains anchors / data the static fetch missed). Used by callers to decide
 * whether to swap in the rendered HTML for further parsing.
 */
export async function renderIfBetterThanStatic(
  url: string,
  staticHtml: string,
  options: RenderOptions = {},
): Promise<RenderResult | null> {
  const r = await renderPageHtml(url, options);
  if (!r.html) return null;
  // A rendered page should expose product anchors that the static page missed.
  // If the rendered HTML is shorter than what we already have, it's probably
  // a worse copy (login redirect, error page) — skip.
  if (r.html.length < staticHtml.length * 0.6) {
    console.warn(
      `[renderPageHtml] rendered HTML is shorter than static (${r.html.length} vs ${staticHtml.length}), discarding`,
    );
    return null;
  }
  return r;
}
