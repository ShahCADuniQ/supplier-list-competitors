// Trial-run the extraction primitives against a single product URL.
// Mirrors what aiAddProductFromInput does at fetch + parse time without
// touching the database or hitting OpenAI. Reports what would be captured.
//
// Usage: npx tsx --env-file=.env scripts/trial-extract-product.ts <url>

import {
  fetchUrlFully,
  extractImageUrls,
  extractDocumentLinks,
  extractEmbeddedDocuments,
} from "../src/lib/ai/parsers";
import { renderPageHtml } from "../src/lib/ai/render";

const url = process.argv[2];
if (!url) {
  console.error(
    "Usage: npx tsx --env-file=.env scripts/trial-extract-product.ts <url>",
  );
  process.exit(1);
}

function pickMeta(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*(?:property|name)=["']${prop}["'][^>]*content=(?:"([^"]+)"|'([^']+)')`,
    "i",
  );
  const m = html.match(re);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

async function main() {
  console.log(`\n=== TRIAL EXTRACTION ===`);
  console.log(`URL: ${url}\n`);

  let html = "";
  let text = "";
  let links: Array<{ href: string; text: string }> = [];

  const t0 = Date.now();
  try {
    const r = await fetchUrlFully(url);
    html = r.html;
    text = r.text;
    links = r.links;
    console.log(`Static fetch OK in ${Date.now() - t0}ms`);
    console.log(`  html length: ${html.length}`);
    console.log(`  text length: ${text.length}`);
    console.log(`  anchor links: ${links.length}`);
  } catch (e) {
    console.warn(
      `Static fetch failed (${e instanceof Error ? e.message : e}); falling back to headless render.`,
    );
  }

  if (text.length < 200) {
    console.log(
      `\nText body is short (${text.length} chars) — running headless render fallback.`,
    );
    const t1 = Date.now();
    try {
      const rendered = await renderPageHtml(url, {
        waitUntil: "networkidle",
        timeoutMs: 30_000,
        blockResources: false,
        scrollPasses: 2,
        clickToReveal: true,
      });
      if (rendered.html) {
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
          .trim();
        // Re-extract anchor links from the rendered HTML.
        const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        const baseHref = url;
        const collected: Array<{ href: string; text: string }> = [];
        let lm: RegExpExecArray | null;
        while ((lm = linkRe.exec(html)) !== null) {
          try {
            const abs = new URL(lm[1], baseHref).toString();
            const txt = lm[2]
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            collected.push({ href: abs, text: txt });
          } catch {
            // skip
          }
        }
        links = collected;
        console.log(
          `Headless render OK in ${Date.now() - t1}ms — html ${html.length}, text ${text.length}, links ${links.length}`,
        );
      } else {
        console.error(`Headless render returned empty HTML.`);
        return;
      }
    } catch (e) {
      console.error(`Headless render FAILED:`, e instanceof Error ? e.message : e);
      return;
    }
  }

  // ── Page metadata (what AI would title/describe the product with) ──
  const ogTitle =
    pickMeta(html, "og:title") || pickMeta(html, "twitter:title");
  const ogDesc =
    pickMeta(html, "og:description") || pickMeta(html, "twitter:description");
  const pageTitle = (() => {
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    return m ? m[1].trim().replace(/\s+/g, " ") : null;
  })();
  console.log(`\n--- Page metadata ---`);
  console.log(`  <title>     : ${pageTitle ?? "[none]"}`);
  console.log(`  og:title    : ${ogTitle ?? "[none]"}`);
  console.log(`  og:desc     : ${ogDesc ? ogDesc.slice(0, 240) : "[none]"}`);

  // ── Images ──
  const images = extractImageUrls(html, url);
  console.log(`\n--- Images extracted (${images.length}) ---`);
  for (const i of images.slice(0, 30)) console.log(`  ${i}`);
  if (images.length > 30) console.log(`  … +${images.length - 30} more`);

  // ── Document links (PDF / IES / DWG / etc) ──
  const docs = extractDocumentLinks(html, url);
  console.log(`\n--- Document links extracted (${docs.length}) ---`);
  for (const d of docs.slice(0, 50)) {
    console.log(`  [${d.kind}] ${(d.text || "(no label)").slice(0, 50).padEnd(50)} → ${d.href}`);
  }
  if (docs.length > 50) console.log(`  … +${docs.length - 50} more`);

  // ── Embedded documents (iframes / object tags / data: PDFs) ──
  const embedded = extractEmbeddedDocuments(html);
  console.log(`\n--- Embedded documents (${embedded.length}) ---`);
  for (const e of embedded.slice(0, 20)) {
    console.log(`  ${e.url}`);
  }

  // ── Anchor links overview ──
  const productishLinks = links.filter((l) =>
    /\.(pdf|ies|ldt|dwg|step|stp|iges|igs|skp|rfa|jpg|jpeg|png|webp)(\?|$)/i.test(
      l.href,
    ),
  );
  console.log(`\n--- Anchor links with file extensions (${productishLinks.length}) ---`);
  for (const l of productishLinks.slice(0, 30)) {
    console.log(`  ${l.text.slice(0, 60).padEnd(60)} → ${l.href}`);
  }

  // ── Sample of stripped text for AI context ──
  console.log(`\n--- Page text (first 2000 chars of ${text.length}) ---`);
  console.log(text.slice(0, 2000));

  console.log(`\n=== Done in ${Date.now() - t0}ms ===\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
