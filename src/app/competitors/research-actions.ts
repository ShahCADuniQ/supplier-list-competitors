"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  competitorCollections,
  competitors,
  competitorProducts,
} from "@/db/schema";
import {
  extractCompetitor,
  extractSingleProduct,
  verifyProductMatchesNiche,
  type CompetitorProductExtraction,
} from "@/lib/ai/extract";
import {
  fetchUrlFully,
  fetchUrlWithLinks,
  extractDocumentLinks,
  extractDownloadSubpageLinks,
  extractEmbeddedDocuments,
  extractImageUrls,
  extractProductPageLinks,
  crawlSitemapUrls,
} from "@/lib/ai/parsers";
import { renderPageHtml } from "@/lib/ai/render";
import { categoryLabelToKind } from "./_kinds";
import { AI_MODEL, openaiClient } from "@/lib/ai/openai";
import {
  perplexityChat,
  hasPerplexityKey,
} from "@/lib/ai/perplexity";
import { requireCompetitorEditor } from "@/lib/permissions";
import {
  attachProductDocument,
  attachBrandDocument,
} from "./_attachments";
import { refreshProductSpecsFromFiles } from "./add-actions";

// ─────────────────────────────────────────────────────────────────────────────
// AI TOP-BRANDS RESEARCH — uses GPT-4o + web search to find leading brands in
// the niche named by the collection, then runs the existing extractor on each
// brand's website to populate full profiles + product catalogs (with PDF
// specsheet attachments). Returns a per-brand log so the UI can show progress.
// ─────────────────────────────────────────────────────────────────────────────

const TIER_KEYS = ["mass", "mid", "spec", "premium"] as const;
type TierKey = (typeof TIER_KEYS)[number];
function asTierKey(v: unknown): TierKey {
  return TIER_KEYS.includes(v as TierKey) ? (v as TierKey) : "mid";
}

// Use the model with web search grounding. Falls back to AI_MODEL if unset.
const RESEARCH_MODEL =
  process.env.OPENAI_RESEARCH_MODEL || process.env.OPENAI_MODEL || "gpt-4o";

const RESEARCH_PROMPT = (
  collectionName: string,
  description: string,
  count: number,
  excludeNames: string[],
) => `You are researching the top ${count} brands/manufacturers in this product niche so a competitor-analysis tool can populate them automatically.

Niche: ${collectionName}${description ? ` — ${description}` : ""}

Use the web_search tool to find the most relevant, currently-active brands. Prefer:
- North American + global market leaders that compete in this niche.
- A spread across tiers (mass / mid / spec / premium) where possible.
- Brands with public catalogs/websites (so a follow-up extraction can populate products).

Skip these brands (already on the board): ${excludeNames.length ? excludeNames.join(", ") : "(none)"}.

For each brand return: name, official website (https://…), parent (or "Private"), country (with city if known, e.g. "USA (NY)"), tierKey ("mass" | "mid" | "spec" | "premium"), tier (free-form short label), segment (1-3 short tags, comma separated), productLines (comma-separated lines if known), notes (1-2 sentence positioning).

Respond with ONLY valid JSON in this exact shape:
{ "brands": [
  { "name": string, "website": string, "parent": string, "country": string,
    "tierKey": "mass"|"mid"|"spec"|"premium", "tier": string, "segment": string,
    "productLines": string, "notes": string }
] }

No prose, no code fences, no commentary — JSON object only. Aim for exactly ${count} brands.`;

export type ResearchedBrand = {
  name: string;
  website: string;
  parent: string;
  country: string;
  tierKey: TierKey;
  tier: string;
  segment: string;
  productLines: string;
  notes: string;
};

function tryParseBrands(raw: string): ResearchedBrand[] {
  // Be forgiving — some models still wrap with ```json fences even when told not to.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { brands?: unknown };
    if (!Array.isArray(parsed.brands)) return [];
    return parsed.brands
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
      .map((b) => ({
        name: String(b.name ?? "").trim(),
        website: String(b.website ?? "").trim(),
        parent: String(b.parent ?? "").trim(),
        country: String(b.country ?? "").trim(),
        tierKey: asTierKey(b.tierKey),
        tier: String(b.tier ?? "").trim(),
        segment: String(b.segment ?? "").trim(),
        productLines: String(b.productLines ?? "").trim(),
        notes: String(b.notes ?? "").trim(),
      }))
      .filter((b) => b.name);
  } catch {
    return [];
  }
}

export async function aiResearchTopBrands(input: {
  collectionId: number;
  count?: number;
}): Promise<{ found: ResearchedBrand[] }> {
  await requireCompetitorEditor();
  const count = Math.max(3, Math.min(input.count ?? 8, 15));

  const [coll] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, input.collectionId))
    .limit(1);
  if (!coll) throw new Error("Collection not found");

  const existing = await db
    .select({ name: competitors.name })
    .from(competitors)
    .where(eq(competitors.collectionId, input.collectionId));

  const prompt = RESEARCH_PROMPT(
    coll.name,
    coll.description ?? "",
    count,
    existing.map((b) => b.name),
  );

  let raw = "";

  // Prefer Perplexity if configured — its sonar-pro model has live web
  // indexing and gives much more current/accurate brand lists than GPT alone.
  if (hasPerplexityKey()) {
    try {
      const r = await perplexityChat<string>({
        systemPrompt: "Return only valid JSON matching the requested shape. No prose.",
        userPrompt: prompt,
      });
      raw = r.content;
    } catch (e) {
      console.warn("Perplexity research failed, falling back to OpenAI:", e);
    }
  }

  // Fallback path: OpenAI Responses API with web_search_preview tool, then
  // plain chat completion if that's not enabled on the account.
  if (!raw) {
    const client = openaiClient();
    try {
      const resp = await client.responses.create({
        model: RESEARCH_MODEL,
        tools: [{ type: "web_search_preview" }],
        input: prompt,
      });
      raw = (resp as unknown as { output_text?: string }).output_text ?? "";
    } catch (e) {
      console.warn("Responses API web_search failed, falling back:", e);
      const fallback = await client.chat.completions.create({
        model: RESEARCH_MODEL,
        messages: [
          { role: "system", content: "Return only valid JSON." },
          { role: "user", content: prompt },
        ],
      });
      raw = fallback.choices[0]?.message?.content ?? "";
    }
  }
  const brands = tryParseBrands(raw);
  return { found: brands };
}

/**
 * Persist a researched brand and immediately run the extractor against its
 * website to fill in full profile + products + specsheets. Called by the
 * client per-brand so progress is visible.
 *
 * Returns the new competitor id and inserted product count.
 */
export async function aiPopulateResearchedBrand(input: {
  collectionId: number;
  brand: ResearchedBrand;
  // When true, skip the website extraction and just create the brand row.
  // Useful when the model returned a website that 404s — we still want the row.
  shallow?: boolean;
}): Promise<{ competitorId: number; productsInserted: number; productsAttempted: number }> {
  const profile = await requireCompetitorEditor();
  const b = input.brand;
  if (!b.name) throw new Error("Brand needs a name");

  // Insert the bare row first so it shows up immediately in the UI even if
  // the website extraction fails.
  const [row] = await db
    .insert(competitors)
    .values({
      collectionId: input.collectionId,
      name: b.name,
      website: b.website || null,
      parent: b.parent || null,
      tierKey: asTierKey(b.tierKey),
      tier: b.tier || null,
      segment: b.segment || null,
      country: b.country || null,
      productLines: b.productLines || null,
      channel: null,
      notes: b.notes || null,
      capabilities: [],
    })
    .returning();
  revalidatePath("/competitors");

  if (input.shallow || !b.website) {
    return { competitorId: row.id, productsInserted: 0, productsAttempted: 0 };
  }

  // Extract from the brand's website to fill products. Don't fail the whole
  // operation if the site is unreachable — we still keep the row.
  let extracted: Awaited<ReturnType<typeof extractCompetitor>> | null = null;
  try {
    extracted = await extractCompetitor({ url: b.website });
  } catch (e) {
    console.warn(`extractCompetitor failed for ${b.website}:`, e);
  }
  if (!extracted) {
    return { competitorId: row.id, productsInserted: 0, productsAttempted: 0 };
  }

  // Refine the brand row with anything new from the extractor (don't blank
  // out fields we already populated from research).
  const refined = {
    website: row.website || extracted.website || null,
    parent: row.parent || extracted.parent || null,
    tierKey: row.tierKey,
    tier: row.tier || extracted.tier || null,
    segment: row.segment || extracted.segment || null,
    country: row.country || extracted.country || null,
    productLines: row.productLines || extracted.productLines || null,
    channel: extracted.channel || null,
    notes: row.notes || extracted.notes || null,
    capabilities: extracted.capabilities ?? [],
    updatedAt: new Date(),
  };
  await db.update(competitors).set(refined).where(eq(competitors.id, row.id));

  // Persist products via the existing pipeline (with specsheet PDF fetch).
  const { aiPersistProducts } = await import("./ai-actions");
  const products = extracted.products ?? [];
  const result = await aiPersistProducts({
    competitorId: row.id,
    products,
  });
  void profile; // (kept for symmetry — not stored on competitors)
  revalidatePath("/competitors");
  return {
    competitorId: row.id,
    productsInserted: result.inserted,
    productsAttempted: products.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAR — bulk-delete every competitor in a collection. Cascade also removes
// products and attachments.
// ─────────────────────────────────────────────────────────────────────────────

export async function clearCollectionBrands(
  collectionId: number,
): Promise<{ deleted: number }> {
  await requireCompetitorEditor();
  const rows = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.collectionId, collectionId));
  if (!rows.length) return { deleted: 0 };
  await db.delete(competitors).where(eq(competitors.collectionId, collectionId));
  revalidatePath("/competitors");
  return { deleted: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// MORE PRODUCT IMAGES — given a brand + category, web-search additional
// representative product photos. Returns absolute URLs only — the client
// decides whether to add them to ideation or display in benchmark.
// ─────────────────────────────────────────────────────────────────────────────

export async function aiFindProductImages(input: {
  collectionId: number;
  query?: string;
  count?: number;
}): Promise<{ images: Array<{ url: string; caption: string }> }> {
  await requireCompetitorEditor();
  const count = Math.max(3, Math.min(input.count ?? 8, 16));

  const [coll] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, input.collectionId))
    .limit(1);
  if (!coll) throw new Error("Collection not found");

  // Pull the most populous category as a default search term if none given.
  const products = await db
    .select()
    .from(competitorProducts)
    .innerJoin(competitors, eq(competitors.id, competitorProducts.competitorId))
    .where(eq(competitors.collectionId, input.collectionId))
    .limit(60);
  const cats = new Map<string, number>();
  for (const r of products) {
    const c = r.competitor_products?.productCategory ?? "";
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1);
  }
  const topCat = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const query = input.query?.trim() ||
    `${topCat ?? coll.name} reference photos in real installations and product photography`;

  const prompt = `You are gathering ${count} reference product photos for a competitor analysis board.

Niche: ${coll.name}${coll.description ? ` — ${coll.description}` : ""}
Search focus: ${query}

Find direct image URLs (jpg/png/webp) showing real products in this niche. Prefer:
- Photos hosted on a manufacturer's site or a major commerce/spec site (not Pinterest collages, not Instagram).
- A mix of installation photos, product renderings, and detail shots (mounting, end caps, optics).

Respond with ONLY valid JSON in this shape:
{ "images": [
  { "url": string, "caption": string }   // url MUST be a direct https://… image link
] }

Aim for exactly ${count} entries. Do not include URLs that 404 or that are clearly thumbnails (< 200px wide).`;

  let raw = "";
  if (hasPerplexityKey()) {
    try {
      const r = await perplexityChat<string>({
        systemPrompt: "Return only valid JSON matching the requested shape.",
        userPrompt: prompt,
      });
      raw = r.content;
    } catch (e) {
      console.warn("Perplexity image search failed, falling back:", e);
    }
  }
  if (!raw) {
    const client = openaiClient();
    try {
      const resp = await client.responses.create({
        model: RESEARCH_MODEL,
        tools: [{ type: "web_search_preview" }],
        input: prompt,
      });
      raw = (resp as unknown as { output_text?: string }).output_text ?? "";
    } catch (e) {
      console.warn("aiFindProductImages web_search failed:", e);
      return { images: [] };
    }
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { images: [] };
  try {
    const parsed = JSON.parse(m[0]) as { images?: unknown };
    if (!Array.isArray(parsed.images)) return { images: [] };
    return {
      images: parsed.images
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => ({
          url: String(i.url ?? "").trim(),
          caption: String(i.caption ?? "").trim(),
        }))
        .filter(
          (i) =>
            /^https?:\/\//i.test(i.url) &&
            /\.(jpe?g|png|webp|gif)(\?|$)/i.test(i.url),
        ),
    };
  } catch {
    return { images: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEEP BRAND EXTRACTION — given a brand website URL, walks the site looking
// for product pages in the active collection's niche, then runs the niche-aware
// extractor against each. End-to-end:
//
//   1. Fetch homepage → harvest anchors.
//   2. Ask the model to pick the in-niche category & product page URLs.
//   3. Fetch each picked page (concurrency capped). Treat them as one bundled
//      "extraction context" so the model can dedupe products across pages.
//   4. Run extractor with niche filter ON.
//   5. Persist products + auto-fetch every specsheet/document attachment.
//
// Designed to be re-runnable: deduping by name+productCode happens elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

const URL_PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    urls: {
      type: "array",
      items: { type: "string" },
      description:
        "Absolute URLs from the provided list that look like in-niche product / category pages. Up to 25.",
    },
    notes: { type: "string" },
  },
  required: ["urls", "notes"],
} as const;

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

function dedupeByPath(
  urls: string[],
  cap: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      u.hash = "";
      // Strip common query noise.
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach(
        (k) => u.searchParams.delete(k),
      );
      const key = `${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u.toString());
      if (out.length >= cap) break;
    } catch {
      // skip bad URL
    }
  }
  return out;
}

async function pickNicheUrls(input: {
  rootUrl: string;
  niche: string;
  links: Array<{ href: string; text: string }>;
}): Promise<string[]> {
  // Same-host only and obviously navigable HTML — no PDFs (those come per
  // product later) and no fragment-only links.
  const candidates = input.links
    .filter((l) => sameHost(l.href, input.rootUrl))
    .filter((l) => !/\.(pdf|zip|jpe?g|png|webp|gif|mp4|webm)(\?|$)/i.test(l.href))
    .slice(0, 250); // hard cap before the model sees them

  const list = candidates
    .map((l, i) => `${i + 1}. ${l.text || "(no text)"} → ${l.href}`)
    .join("\n");

  const prompt = `From this anchor list on a brand website, pick the URLs that are likely IN-NICHE category pages, family pages, or product pages for the niche "${input.niche}".

Strict rules:
- Niche means the kind of luminaire/light family (e.g. "Linear Lighting" → linear pendants, recessed slots, surface linears, suspended linears, cove tape; SKIP downlights, recessed cans, exterior bollards, decorative pendants, accessories pages).
- Prefer deeper paths like "/products/<family>" or "/products/<family>/<sku>" over the homepage / about pages.
- Skip privacy, careers, news, blog, login, retailer-locator, contact pages.
- Up to 25 URLs. If unsure, include — we'll filter later.

Anchors:
${list}

Respond with JSON: { "urls": string[], "notes": string }.`;

  const client = openaiClient();
  const resp = await client.chat.completions.create({
    model: AI_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: "Return only JSON. No commentary." },
      { role: "user", content: prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "url_picks", strict: true, schema: URL_PICK_SCHEMA },
    },
  });
  const raw = resp.choices[0]?.message?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { urls?: unknown };
    const list = Array.isArray(parsed.urls) ? parsed.urls : [];
    return dedupeByPath(
      list
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .filter((u) => sameHost(u, input.rootUrl)),
      25,
    );
  } catch {
    return [];
  }
}

export type DeepExtractProgress =
  | { stage: "discover"; rootUrl: string }
  | { stage: "picked"; count: number }
  | { stage: "fetched"; done: number; total: number; lastUrl: string }
  | { stage: "extracting" }
  | { stage: "saved"; products: number; specsheets: number; brandId: number };

export type DeepExtractResult = {
  brandId: number;
  brandName: string;
  pagesPicked: number;
  pagesFetched: number;
  productsInserted: number;
  specsheetsAttached: number;
  documentsAttached: number;
  brandFilesAttached: number;
  fetchErrors: Array<{ url: string; error: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY-PAGE DISCOVERY — uses Perplexity ONLY to identify the niche-relevant
// category landing pages on the brand's site. We then fetch each one and
// deterministically harvest every product anchor from its HTML — no AI
// hallucination possible because the parser only emits anchors that actually
// exist on the page and live under the category URL's path.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_PAGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brandName: { type: "string" },
    parent: { type: "string" },
    country: { type: "string" },
    notes: { type: "string" },
    categoryUrls: {
      type: "array",
      description:
        "URLs of every category landing page on the brand's site that lists products in the specified niche. These should be /products/<category>-style index pages, NOT individual product pages.",
      items: { type: "string" },
    },
  },
  required: ["brandName", "parent", "country", "notes", "categoryUrls"],
} as const;

type CategoryPageDiscovery = {
  brandName: string;
  parent: string;
  country: string;
  notes: string;
  categoryUrls: string[];
};

async function discoverNicheCategoryPages(input: {
  rootUrl: string;
  niche: string;
  brandHint?: string;
}): Promise<CategoryPageDiscovery> {
  const host = new URL(input.rootUrl).host.replace(/^www\./, "");
  const rules = nicheRules(input.niche);
  const userPrompt = `On ${host}, identify ONLY the category landing pages that EXACTLY match the collection name "${input.niche}".

${input.brandHint ? `Brand display name: "${input.brandHint}".` : ""}

ABSOLUTE RULES — read carefully:

1. The collection name is "${input.niche}". Decompose it into its semantic parts and require ALL of them to apply.
   For "${input.niche}" the relevant concepts INCLUDE: ${rules.positive.slice(0, 12).join(", ")}.
   The relevant concepts EXCLUDE (negative — must NOT appear in the URL or page topic):
   ${rules.negative.length > 0 ? rules.negative.slice(0, 12).join(", ") : "(no specific exclusions)"}

2. A category landing page is a URL that LISTS multiple distinct products in the niche, e.g.:
     https://${host}/products/<niche-category>
     https://${host}/products/<niche>/<sub-category>
   NOT a single product detail page, NOT a downloads/resources/blog/contact page.

3. EXAMPLE — if the brand has 3 sub-categories matching "${input.niche}", return EXACTLY 3 URLs.
   If the brand has 0 matching sub-categories, return AN EMPTY ARRAY. Do NOT include outdoor / exterior / underwater / facade / inground / decorative / downlight / spot / track / tape categories when the niche doesn't include those concepts.

4. Walk the brand's main product navigation. If you're unsure whether a category page matches, OMIT IT. Less is more. We strictly prefer 3 correct categories over 5 mixed ones.

Return JSON:
{
  "brandName": string,
  "parent": string,
  "country": string,
  "notes": string,
  "categoryUrls": string[]   // ONLY in-niche category landing pages
}

Each URL must be on https://${host}.`;

  const r = await perplexityChat<CategoryPageDiscovery>({
    systemPrompt:
      "You are a careful product-research agent. Be CONSERVATIVE — only return category pages that clearly match the user's collection. Return only valid JSON.",
    userPrompt,
    schema: CATEGORY_PAGES_SCHEMA,
    schemaName: "category_pages",
    searchDomains: [host],
    maxTokens: 3000,
  });

  // Filter to same-host URLs only.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of r.content.categoryUrls ?? []) {
    if (typeof raw !== "string") continue;
    const u = normalizeProductUrl(raw.trim(), host);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
  }

  return {
    brandName: r.content.brandName ?? "",
    parent: r.content.parent ?? "",
    country: r.content.country ?? "",
    notes: r.content.notes ?? "",
    categoryUrls: urls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERPLEXITY-POWERED PRODUCT DISCOVERY (legacy — used as fallback when the
// category-page crawl returns 0 categories)
//
// Two-pass discovery so brand families with 5+ variants don't get reduced to
// just the family name:
//
//   Pass 1: ask Perplexity to enumerate every PRODUCT FAMILY in the niche,
//           plus every individual VARIANT URL it can already see.
//   Pass 2: for each family that has fewer variants than expected, ask
//           Perplexity to drill into that family and list all variants.
//
// We rely on `search_domain_filter` so Perplexity stays on the brand's site,
// and fall back to the brand-supplied homepage anchor crawl if Perplexity
// returns zero products (rare — usually means the brand site is gated).
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brandName: { type: "string" },
    brandTagline: { type: "string" },
    parent: { type: "string" },
    country: { type: "string" },
    families: {
      type: "array",
      description:
        "Top-level product families in this niche (e.g. 'Lumenline', 'Lumenfacade'). Even if you can't enumerate every variant, list every family you can find on the site.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          familyPageUrl: { type: "string" },
          expectedVariantCount: {
            type: "integer",
            description:
              "Best guess at how many distinct variants this family has on the brand's site (e.g. Pendant Indirect, Pendant Direct, Recessed, Surface, Wall = 5). 0 if you don't know.",
          },
        },
        required: ["name", "familyPageUrl", "expectedVariantCount"],
      },
    },
    products: {
      type: "array",
      description:
        "Every individual product VARIANT you can directly identify with its own product page on the site (not the family overview page). EXHAUSTIVE — if a family has 5 variants, list all 5 separately.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          family: { type: "string" },
          name: { type: "string" },
          productPageUrl: { type: "string" },
          shortDescription: { type: "string" },
        },
        required: ["family", "name", "productPageUrl", "shortDescription"],
      },
    },
    notes: { type: "string" },
  },
  required: [
    "brandName",
    "brandTagline",
    "parent",
    "country",
    "families",
    "products",
    "notes",
  ],
} as const;

const FAMILY_VARIANTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          productPageUrl: { type: "string" },
          shortDescription: { type: "string" },
        },
        required: ["name", "productPageUrl", "shortDescription"],
      },
    },
  },
  required: ["variants"],
} as const;

type DiscoveredProduct = {
  family: string;
  name: string;
  productPageUrl: string;
  shortDescription: string;
};

type ProductDiscovery = {
  brandName: string;
  brandTagline: string;
  parent: string;
  country: string;
  families: Array<{
    name: string;
    familyPageUrl: string;
    expectedVariantCount: number;
  }>;
  products: DiscoveredProduct[];
  notes: string;
};

function normalizeProductUrl(rawUrl: string, host: string): string | null {
  try {
    if (!/^https?:\/\//i.test(rawUrl)) return null;
    const u = new URL(rawUrl);
    if (u.host.replace(/^www\./, "") !== host) return null;
    u.hash = "";
    // Strip common tracking params.
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach(
      (k) => u.searchParams.delete(k),
    );
    return u.toString();
  } catch {
    return null;
  }
}

async function discoverBrandProductsViaPerplexity(input: {
  rootUrl: string;
  niche: string;
  brandHint?: string;
}): Promise<ProductDiscovery> {
  const host = new URL(input.rootUrl).host.replace(/^www\./, "");

  const PASS1_PROMPT = `Enumerate EVERY "${input.niche}" product on ${host}.

${input.brandHint ? `Brand: "${input.brandHint}".` : ""}

CRITICAL — many brands group products into "families" (e.g. for ${host} that might be Lumenline, Lumenfacade, Lumencove…). Each family has multiple distinct VARIANTS, each on its own product page (e.g. "Lumenline Pendant Indirect", "Lumenline Pendant Direct", "Lumenline Recessed", "Lumenline Surface", "Lumenline Wall"). I need ALL the variants, not just the family overview pages.

For "${input.niche}" specifically: include linear pendants, recessed slot/cove, surface linears, suspended linears, wallwash, asymmetric, indirect, direct, sconce/wall — anything that's a linear-form luminaire. EXCLUDE downlights, recessed cans that aren't linear, exterior bollards/floods that aren't linear, decorative chandeliers, accessories pages, blog posts, news.

Search the brand's site index, the sitemap if available (${host}/sitemap.xml), product navigation menus, and any /products/ or /catalog/ trees.

Return JSON with TWO arrays:
- "families": every top-level product family in the niche, with a guess at how many variants each has.
- "products": every individual variant you can directly identify with a unique product page URL — be EXHAUSTIVE. If a family has 5 variants, list all 5 separately.

Each variant URL must:
- Start with https://${host}
- Be a unique product/variant page (not just /products/family-name overview)
- Use the canonical URL Lumenpulse / the brand actually publishes (no UTM params)

Also return brandName, brandTagline (1 line), parent, country, notes.`;

  const r = await perplexityChat<ProductDiscovery>({
    systemPrompt:
      "You are a comprehensive product-research agent. Be exhaustive. Return only valid JSON matching the requested schema.",
    userPrompt: PASS1_PROMPT,
    schema: PRODUCT_DISCOVERY_SCHEMA,
    schemaName: "product_discovery",
    searchDomains: [host],
    maxTokens: 8000,
  });

  // ── Normalize Pass-1 results ──
  const seenUrl = new Set<string>();
  const products: DiscoveredProduct[] = [];
  for (const p of r.content.products ?? []) {
    const url = normalizeProductUrl((p.productPageUrl ?? "").trim(), host);
    const name = (p.name ?? "").trim();
    if (!url || !name) continue;
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    products.push({
      family: (p.family ?? "").trim(),
      name,
      productPageUrl: url,
      shortDescription: (p.shortDescription ?? "").trim(),
    });
  }
  // Track variants-per-family so Pass 2 only fires for under-served families.
  function countByFamily(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of products) {
      const k = p.family.toLowerCase();
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }

  // ── Pass 2: for any family where Perplexity expected N variants but we got
  // fewer than N (or zero), drill in for that family explicitly. Capped at 6
  // family follow-ups so a brand with 30 families doesn't burn 30 calls. ──
  const families = (r.content.families ?? []).filter((f) => f.name.trim());
  const counts = countByFamily();
  const followups = families
    .filter((f) => {
      const have = counts.get(f.name.toLowerCase()) ?? 0;
      const expected = Math.max(0, Math.min(f.expectedVariantCount ?? 0, 20));
      // Drill into every family with > 1 expected variant. We always want full
      // coverage even if Pass-1 already gave us "enough" — it lies sometimes.
      return expected >= 2 && have < expected + 2;
    })
    // No cap. Lumenpulse has ~10 families; running 10 follow-up calls is
    // worth it for full coverage.
    .slice(0, 20);

  for (const f of followups) {
    try {
      const driller = await perplexityChat<{
        variants: Array<{
          name: string;
          productPageUrl: string;
          shortDescription: string;
        }>;
      }>({
        systemPrompt: "Return only valid JSON. Be exhaustive — list every variant.",
        userPrompt: `On ${host}, the "${f.name}" family in the "${input.niche}" niche has multiple distinct variants, each on its own product page (configurations like Pendant Indirect, Pendant Direct, Recessed, Surface, Wall, Cove, Asymmetric, Symmetric, Wallwash, Up/Down, Direct/Indirect, Inground, Underwater, Linear, Spot, etc.).

List EVERY variant you can find for the "${f.name}" family on ${host}. For each variant return:
- name (e.g. "${f.name} Pendant Indirect")
- productPageUrl (canonical URL on ${host})
- shortDescription (1 sentence)

Family overview/landing page: ${f.familyPageUrl || "(unknown)"}

Search the brand's product pages, sitemap (${host}/sitemap.xml if it exists), and the family's overview page. Include sub-variants like wattage- or length-specific SKUs when each has its own product page.

If you find 12 variants, return 12. Do not stop at 5.`,
        schema: FAMILY_VARIANTS_SCHEMA,
        schemaName: "family_variants",
        searchDomains: [host],
        maxTokens: 4000,
      });
      for (const v of driller.content.variants ?? []) {
        const url = normalizeProductUrl((v.productPageUrl ?? "").trim(), host);
        const name = (v.name ?? "").trim();
        if (!url || !name) continue;
        if (seenUrl.has(url)) continue;
        seenUrl.add(url);
        products.push({
          family: f.name,
          name,
          productPageUrl: url,
          shortDescription: (v.shortDescription ?? "").trim(),
        });
      }
    } catch (e) {
      console.warn(`Pass-2 drill-in failed for family ${f.name}:`, e);
    }
  }

  // ── Pass 3: explicit sitemap probe. Many brands publish all product URLs in
  //    /sitemap.xml — Perplexity is great at parsing them, but only if asked
  //    directly. Only do this if Pass-1 + Pass-2 gave us fewer than 20
  //    products (heuristic for "discovery missed something"). ──
  if (products.length < 20) {
    try {
      const sitemapPass = await perplexityChat<{
        productUrls: Array<{ url: string; name: string }>;
      }>({
        systemPrompt: "Return only valid JSON.",
        userPrompt: `Fetch the sitemap at https://${host}/sitemap.xml (or https://${host}/sitemap_index.xml or any sitemap discoverable at the root of ${host}).

From the sitemap entries, return EVERY URL on ${host} that's a "${input.niche}" product page (a single-product page, not a category overview).

Schema: { "productUrls": [{ "url": string, "name": string }] }

Even if the sitemap has 100 URLs, return all the in-niche ones. Do not summarize.`,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            productUrls: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  url: { type: "string" },
                  name: { type: "string" },
                },
                required: ["url", "name"],
              },
            },
          },
          required: ["productUrls"],
        },
        searchDomains: [host],
        maxTokens: 6000,
      });
      for (const v of sitemapPass.content.productUrls ?? []) {
        const url = normalizeProductUrl((v.url ?? "").trim(), host);
        const name = (v.name ?? "").trim();
        if (!url || !name) continue;
        if (seenUrl.has(url)) continue;
        seenUrl.add(url);
        products.push({
          family: "",
          name,
          productPageUrl: url,
          shortDescription: "",
        });
      }
    } catch (e) {
      console.warn("Sitemap pass failed:", e);
    }
  }

  return {
    brandName: r.content.brandName,
    brandTagline: r.content.brandTagline,
    parent: r.content.parent,
    country: r.content.country,
    families,
    products,
    notes: r.content.notes,
  };
}

/**
 * The main entry point used by the UI.
 *
 * Flow:
 *   1. Use Perplexity to find every in-niche CATEGORY LANDING PAGE on the
 *      brand's site (e.g. /products/linear-cove, /linear-grazing, /linear-system).
 *      Perplexity is good at navigation, not enumeration.
 *   2. Fetch each category landing page and DETERMINISTICALLY parse all
 *      product anchors from its HTML — no AI involvement, so no hallucinated
 *      URLs and no missed variants.
 *   3. Per discovered product URL (parallelized):
 *      a. Fetch the product page HTML once.
 *      b. Harvest images (only og:image + same-CDN-directory siblings).
 *      c. Harvest every spec/IES/CAD anchor + follow Downloads sub-pages.
 *      d. Download the spec PDF, parse its text, feed both HTML text + PDF
 *         text into extractSingleProduct.
 *      e. Persist + attach remaining docs.
 *   4. Return totals.
 *
 * If Perplexity returns no categories OR is unavailable, falls back to the
 * legacy "homepage anchors → AI picks" flow.
 */
export async function aiDeepExtractBrand(input: {
  collectionId: number;
  website: string;
  brandName?: string;
  /** Soft hint only — no longer used to truncate product enumeration. Kept
   *  for backward compatibility with existing UI calls. */
  maxProducts?: number;
}): Promise<DeepExtractResult> {
  await requireCompetitorEditor();

  const rootUrl = input.website.trim();
  if (!/^https?:\/\//i.test(rootUrl)) {
    throw new Error("Provide an https:// URL");
  }
  // No artificial cap. We process every URL we discover. Keep a hard ceiling
  // of 500 ONLY as a runaway-loop guard.
  const productCap = 500;
  void input.maxProducts;

  // ── Hard wallclock budget. The whole deep extract — discovery + brand
  // files + per-product processing — must finish within this window so the
  // browser doesn't disconnect and the user actually gets a result back. We
  // bail mid-loop if we hit it, returning whatever's been saved so far.
  const startedAt = Date.now();
  const WALLCLOCK_BUDGET_MS = 4 * 60 * 1000; // 4 minutes
  const budgetExpired = () => Date.now() - startedAt > WALLCLOCK_BUDGET_MS;

  const [coll] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, input.collectionId))
    .limit(1);
  if (!coll) throw new Error("Collection not found");
  const niche = coll.name;

  // ── STEP 0 — CREATE BRAND ROW IMMEDIATELY ──
  // This is the single most important change: even if every later step times
  // out or fails, the brand exists in the UI from the first second of the
  // operation. We backfill profile fields after discovery completes.
  const initialBrandName =
    input.brandName?.trim() || hostnameLabel(rootUrl);
  const [brandRow] = await db
    .insert(competitors)
    .values({
      collectionId: input.collectionId,
      name: initialBrandName,
      website: rootUrl,
      parent: null,
      tierKey: "spec",
      tier: null,
      segment: null,
      country: null,
      productLines: null,
      channel: null,
      notes: null,
      capabilities: [],
    })
    .returning();
  console.log(`[deep-extract] created brand row id=${brandRow.id} (${initialBrandName})`);
  revalidatePath("/competitors");

  const fetchErrors: Array<{ url: string; error: string }> = [];

  // Step 1a — Perplexity finds the niche-relevant category landing pages.
  let categoryDiscovery: CategoryPageDiscovery | null = null;
  if (hasPerplexityKey()) {
    try {
      categoryDiscovery = await discoverNicheCategoryPages({
        rootUrl,
        niche,
        brandHint: input.brandName,
      });
    } catch (e) {
      console.warn("Category discovery failed:", e);
    }
  }

  // SITEMAP-FIRST DISCOVERY ──
  // Live testing against lumenpulse.com proved that:
  //   1. Their site is a JS SPA — static homepage HTML has 0 product links
  //   2. Perplexity returns only ~5 products for indoor linear (out of 30+)
  //   3. The brand's sitemap-lumenpulse.xml lists every product URL
  // So we walk the sitemap (with index → sub-sitemap recursion), then apply
  // strict positive+negative keyword filtering from the collection name.
  const rules = nicheRules(niche);
  console.log(
    `[deep-extract] niche rules positive=[${rules.positive.slice(0, 8).join(",")}…] negative=[${rules.negative.slice(0, 8).join(",")}…]`,
  );

  // OPTIONAL — Perplexity category seed (kept for non-sitemap-friendly brands).
  const allCategoryUrls = new Set<string>();
  for (const u of categoryDiscovery?.categoryUrls ?? []) {
    try {
      const path = new URL(u).pathname;
      if (!passesNicheFilter(path, "", rules)) continue;
    } catch {
      continue;
    }
    allCategoryUrls.add(u);
  }

  const productUrls = new Set<string>();
  const productNames = new Map<string, string>();

  const nicheTokensCached = rules.positive;

  // Walk each category page. We also recurse one level if a category page
  // looks like an INDEX of sub-categories rather than products (heuristic:
  // it has many same-host sub-paths but no product-like anchors itself).
  async function walkCategory(catUrl: string, depth: number) {
    try {
      const cat = await fetchUrlFully(catUrl);
      const links = extractProductPageLinks(cat.html, catUrl, nicheTokensCached);
      // Apply niche filter to each candidate so a category page that mixes
      // products (e.g. an "All Products" index) yields only in-niche items.
      const filtered = links.filter((u) => {
        try {
          return passesNicheFilter(new URL(u).pathname, "", rules);
        } catch {
          return false;
        }
      });
      if (filtered.length > 0) {
        for (const u of filtered) productUrls.add(u);
        return;
      }
      // No product anchors found at this depth — try one level deeper. Find
      // anchors that look like sub-categories (same-host, deeper path,
      // matching niche keyword in URL or text).
      if (depth >= 2) return;
      const nicheTokens = nicheKeywordTokens(niche);
      const subCats = new Set<string>();
      for (const link of cat.links) {
        try {
          const u = new URL(link.href);
          if (u.host.replace(/^www\./, "") !== new URL(catUrl).host.replace(/^www\./, "")) continue;
          const cp = new URL(catUrl).pathname.replace(/\/+$/, "");
          const lp = u.pathname.replace(/\/+$/, "");
          if (!lp.startsWith(cp + "/") || lp === cp) continue;
          if (/\.(pdf|ies|ldt|dwg|dxf|jpe?g|png|gif|webp|mp4|zip)$/i.test(lp)) continue;
          if (/\/(downloads?|resources?|documents?|files?|news|contact|about)\b/i.test(lp)) continue;
          const text = (link.text || "").toLowerCase();
          if (!nicheTokens.some((tok) => lp.toLowerCase().includes(tok) || text.includes(tok))) continue;
          u.hash = "";
          u.search = "";
          subCats.add(u.toString());
        } catch {
          // skip
        }
      }
      // Limit recursion fan-out to avoid runaway crawls.
      const subList = [...subCats].slice(0, 6);
      for (const subUrl of subList) {
        await walkCategory(subUrl, depth + 1);
      }
    } catch (e) {
      console.warn("Category page fetch failed:", catUrl, e);
      fetchErrors.push({
        url: catUrl,
        error: e instanceof Error ? e.message : "fetch failed",
      });
    }
  }

  if (allCategoryUrls.size > 0) {
    for (const catUrl of [...allCategoryUrls].slice(0, 30)) {
      await walkCategory(catUrl, 1);
    }
    console.log(
      `[deep-extract] after category walk: ${productUrls.size} product URLs from ${allCategoryUrls.size} categories`,
    );
  }

  // ── PRIMARY DISCOVERY: brand sitemap ──
  // Walk the brand's sitemap (recurse through sitemap-index → sub-sitemaps).
  // For every URL the sitemap publishes that's a product page (path matches
  // /products/<id>/<slug>) AND passes the strict niche filter, add it as a
  // product. This is the most-reliable source for SPAs (Lumenpulse,
  // Lumenfacade, etc.) where homepage HTML is empty.
  if (!budgetExpired()) {
    try {
      const { urls: sitemapUrls, sitemapsVisited } = await crawlSitemapUrls(
        rootUrl,
        { wallclockMs: 30_000, maxSitemaps: 16 },
      );
      console.log(
        `[deep-extract] sitemap: ${sitemapUrls.length} URLs across ${sitemapsVisited.length} sitemap files`,
      );
      let added = 0;
      let rejected = 0;
      const productPathRegex = /\/products?\/(\d+\/)?[a-z0-9-]+\/?$/i;
      for (const u of sitemapUrls) {
        // Only consider URLs that are individual product pages. We accept
        // the common patterns: /products/<id>/<slug>, /products/<slug>,
        // /product/<slug>. Sites that don't match these are still processed
        // by the category-walk path above.
        const lower = u.toLowerCase();
        if (!productPathRegex.test(lower)) continue;
        // Niche filter — must pass the positive AND negative checks.
        if (!passesNicheFilter(lower, "", rules)) {
          rejected++;
          continue;
        }
        if (productUrls.has(u)) continue;
        productUrls.add(u);
        added++;
      }
      console.log(
        `[deep-extract] sitemap: added ${added} in-niche product URLs (${rejected} off-niche rejected)`,
      );

      // Fallback: brands like Axis Lighting use opaque SKU-style slugs
      // (e.g. /products/tacet) that don't contain niche keywords like
      // "linear" or "cove". When the strict positive-keyword filter
      // rejects every URL but plenty exist, retry with a negatives-only
      // pass so SKU slugs still come through. Lumenpulse-style sites
      // (whose slugs DO contain "lumenline"/"lumencove") never trigger
      // this branch because their strict pass already finds matches.
      if (added === 0 && rejected > 0) {
        console.log(
          `[deep-extract] sitemap: strict niche filter rejected all ${rejected} URLs — falling back to negatives-only filter`,
        );
        let fallbackAdded = 0;
        let fallbackBlocked = 0;
        for (const u of sitemapUrls) {
          const lower = u.toLowerCase();
          if (!productPathRegex.test(lower)) continue;
          let blocked = false;
          for (const n of rules.negative) {
            if (n && lower.includes(n)) {
              blocked = true;
              break;
            }
          }
          if (blocked) {
            fallbackBlocked++;
            continue;
          }
          if (productUrls.has(u)) continue;
          productUrls.add(u);
          fallbackAdded++;
        }
        console.log(
          `[deep-extract] sitemap fallback: added ${fallbackAdded} URLs (${fallbackBlocked} blocked by negatives)`,
        );
      }
    } catch (e) {
      console.warn("[deep-extract] sitemap crawl failed:", e);
    }
  }

  // ── PERPLEXITY product-URL enumeration (third source) ──
  // Some brand sites publish products only via JS-rendered pages — the sitemap
  // doesn't list them and the category page HTML is empty (e.g. SuperModular).
  // For those we ask Perplexity directly for product URLs and harvest BOTH
  // the structured response AND the search-results citations (Perplexity
  // often visits product pages but only includes a few in the JSON answer).
  if (!budgetExpired() && productUrls.size < 5 && hasPerplexityKey()) {
    try {
      const host = new URL(rootUrl).host.replace(/^www\./, "");
      const userPrompt = `Search ${host} for every individual product page URL in the "${niche}" niche.

Niche filter — only include products that match the collection name "${niche}". Use these positive concepts: ${rules.positive.slice(0, 12).join(", ")}.${rules.negative.length > 0 ? ` Strictly EXCLUDE anything containing: ${rules.negative.slice(0, 10).join(", ")}.` : ""}

Be exhaustive. Run multiple targeted searches if needed (e.g. by product family). Return EVERY individual product page URL you can find — typically dozens or hundreds. Each URL must be on https://${host} or its locale variants (e.g. /en-us/products/<slug>--p-<id>/, /products/<id>/<slug>, etc.).

Return JSON: { "productUrls": string[] }`;
      const r = await perplexityChat<{ productUrls: string[] }>({
        systemPrompt: "Return only valid JSON. Be exhaustive — list every product URL you can find.",
        userPrompt,
        schema: {
          type: "object",
          properties: { productUrls: { type: "array", items: { type: "string" } } },
          required: ["productUrls"],
          additionalProperties: false,
        },
        schemaName: "product_urls",
        searchDomains: [host],
        maxTokens: 6000,
      });

      // Combine structured response + citations + search_results — Perplexity
      // visits more URLs than it includes in the structured JSON, and the
      // citations field is often the more-complete list.
      const candidates = new Set<string>();
      for (const u of r.content.productUrls ?? []) candidates.add(u);
      for (const u of r.citations ?? []) candidates.add(u);
      for (const sr of r.searchResults ?? []) {
        if (sr.url) candidates.add(sr.url);
      }

      const isNonProductPath = (pathname: string) =>
        /\/(news|press|blog|case-stud|stories|projects?|contact|about|careers?|search|login|wishlist|services|dealers|support|signin|register|account)\b/i.test(
          pathname,
        );
      const looksLikeProductPath = (pathname: string) =>
        /--[ps]-?\d+\/?$/i.test(pathname) ||
        /\/products?\/\d+\/[a-z0-9-]+\/?$/i.test(pathname) ||
        /\/products?\/[a-z0-9-]+\/?$/i.test(pathname);

      let added = 0;
      let rejected = 0;
      const fallbackPool: URL[] = [];
      for (const raw of candidates) {
        if (!raw || !/^https?:\/\//i.test(raw)) continue;
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          continue;
        }
        if (parsed.host.replace(/^www\./, "") !== host) continue;
        // Reject obvious non-product URLs early so they don't pollute the
        // fallback pool either.
        const segs = parsed.pathname.split("/").filter(Boolean);
        if (segs.length < 2) continue;
        if (isNonProductPath(parsed.pathname)) continue;
        if (!looksLikeProductPath(parsed.pathname)) continue;
        // Niche filter — must pass.
        if (!passesNicheFilter(parsed.pathname.toLowerCase(), "", rules)) {
          rejected++;
          fallbackPool.push(parsed);
          continue;
        }
        parsed.hash = "";
        const norm = parsed.toString();
        if (productUrls.has(norm)) continue;
        productUrls.add(norm);
        added++;
      }
      console.log(
        `[deep-extract] Perplexity URL enum: added ${added} (${rejected} rejected by niche filter)`,
      );

      // Fallback for SKU-style slugs (Axis: /products/tacet) — same logic
      // as the sitemap pass. If the strict filter zeroed everything out,
      // re-admit candidates that only fail the positive-keyword check,
      // still rejecting any URL that hits a negative keyword.
      if (added === 0 && fallbackPool.length > 0) {
        console.log(
          `[deep-extract] Perplexity URL enum: strict filter rejected all ${fallbackPool.length} on-host product URLs — falling back to negatives-only filter`,
        );
        let fallbackAdded = 0;
        let fallbackBlocked = 0;
        for (const parsed of fallbackPool) {
          const lower = parsed.pathname.toLowerCase();
          let blocked = false;
          for (const n of rules.negative) {
            if (n && lower.includes(n)) {
              blocked = true;
              break;
            }
          }
          if (blocked) {
            fallbackBlocked++;
            continue;
          }
          parsed.hash = "";
          const norm = parsed.toString();
          if (productUrls.has(norm)) continue;
          productUrls.add(norm);
          fallbackAdded++;
        }
        console.log(
          `[deep-extract] Perplexity URL enum fallback: added ${fallbackAdded} (${fallbackBlocked} blocked by negatives)`,
        );
      }
    } catch (e) {
      console.warn("[deep-extract] Perplexity URL enumeration failed:", e);
    }
  }

  // ── Perplexity-based family-URL filter for cases where the URL slug
  //    doesn't include any niche keyword (SuperModular: Pista / Straw /
  //    SLD25 / etc. are linear products but their slugs don't say "linear").
  //    Given a candidate family URL list, ask Perplexity which match the
  //    user's collection. Conservative — return ONLY confirmed matches.
  async function filterFamiliesViaPerplexity(
    urls: string[],
    nicheLabel: string,
  ): Promise<string[]> {
    if (!hasPerplexityKey() || urls.length === 0) return urls;
    try {
      const userPrompt = `From the URL list below, return ONLY the URLs that are product families/categories matching the niche "${nicheLabel}". The URLs are family pages on a brand's website. The slug after /products/ may be a brand name or product family name (not necessarily containing the niche keyword) — judge based on what the family is, not just the URL text.

For "${nicheLabel}" specifically, INCLUDE families that produce: linear pendants, linear cove/grazing/wallwash, linear suspended/recessed/surface, light strips, profile-mounted linear LEDs, linear track lights when they're a continuous-length design.
EXCLUDE: round/square downlights, spotlights, decorative pendants, accessories, drivers, controls, mounting parts.

URLs:
${urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Return JSON: { "matchingUrls": string[] } — the subset of URLs that match the niche. Be conservative; if unsure, omit.`;
      const r = await perplexityChat<{ matchingUrls: string[] }>({
        systemPrompt: "Return only valid JSON. Be conservative — only include URLs you're confident match the niche.",
        userPrompt,
        schema: {
          type: "object",
          properties: { matchingUrls: { type: "array", items: { type: "string" } } },
          required: ["matchingUrls"],
          additionalProperties: false,
        },
        schemaName: "matching_families",
        maxTokens: 2000,
      });
      const matching = new Set(r.content.matchingUrls ?? []);
      const filtered = urls.filter((u) => matching.has(u));
      console.log(
        `[deep-extract] Perplexity family filter: kept ${filtered.length} of ${urls.length}`,
      );
      return filtered;
    } catch (e) {
      console.warn("[deep-extract] Perplexity family filter failed:", e);
      return urls;
    }
  }

  // ── Perplexity-based binary classifier: given a mixed list of on-host URLs
  //    we know nothing about (slug filter rejected, no `/products/` marker),
  //    ask Perplexity which are product DETAIL pages and which are family /
  //    category pages within the user's niche. Returns disjoint sets so the
  //    caller can render families with trust and add products directly.
  async function classifyCandidateUrlsViaPerplexity(
    urls: string[],
    nicheLabel: string,
  ): Promise<{ products: string[]; families: string[] }> {
    if (!hasPerplexityKey() || urls.length === 0) {
      return { products: [], families: [] };
    }
    const userPrompt = `You are sorting URLs from a lighting brand's website. The user collects products in the niche: "${nicheLabel}".

Classify each URL into exactly one of:
  - "product": a product detail page for ONE specific SKU / variant matching the niche (e.g. "Linealuce Recessed 28W 3000K", "Agora Distance 8 RGBW").
  - "family": a family/series/category overview page that LISTS products matching the niche (e.g. "Linealuce family", "Indoor linear lighting category").
  - "other": navigation / about / news / non-niche product / accessories / blog / unrelated.

CRITICAL rules:
  - Only return URLs you're confident match the niche "${nicheLabel}". When unsure, classify as "other".
  - Categories about OUTDOOR products are "other" if niche says indoor/interior, and vice-versa.
  - Generic catalog index pages (e.g. just "/products/", "/all-products/") are "other".

URLs:
${urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Return JSON: { "products": string[], "families": string[] } — only URLs you confidently classified. Omit URLs that are "other".`;
    const r = await perplexityChat<{ products: string[]; families: string[] }>({
      systemPrompt:
        "Return only valid JSON. Be strict — only include URLs you're highly confident match the niche.",
      userPrompt,
      schema: {
        type: "object",
        properties: {
          products: { type: "array", items: { type: "string" } },
          families: { type: "array", items: { type: "string" } },
        },
        required: ["products", "families"],
        additionalProperties: false,
      },
      schemaName: "candidate_classification",
      maxTokens: 3000,
    });
    const valid = new Set(urls);
    const products = (r.content.products ?? []).filter((u) => valid.has(u));
    const families = (r.content.families ?? []).filter((u) => valid.has(u));
    return { products, families };
  }

  // ── HEADLESS-BROWSER fallback (fourth source) ──
  // For brand sites that render their product list entirely client-side
  // (SuperModular, Vue/React/Angular catalogs), no static fetch finds anything.
  // We launch Chromium, render the rootUrl + Perplexity-supplied categories,
  // collect every link, then RECURSIVELY follow links that look like
  // category/family pages (path includes /products/<slug>--sf-<id> or
  // /products/<slug>) up to depth 2 — that's how SuperModular exposes its
  // 12 linear products under /en-us/products/linear-lighting--sf-128044/.
  if (!budgetExpired() && productUrls.size < 5) {
    try {
      const host = new URL(rootUrl).host.replace(/^www\./, "");
      const visited = new Set<string>();

      // Common non-product path segments that show up on every brand site.
      // Used to reject early before more expensive checks.
      const NOISE_PATH_RE =
        /\/(news|press|blog|case-stud|stories|projects?|contact|about(?:-us)?|career|careers|search|login|wishlist|services?|dealers?|support|signin|sign-?up|register|account|cookie|privacy|legal|terms|sitemap|inspiration|gallery|references?|where-to-buy|locator|distributor|partner|certifications?|warranty|whistleblowing|newsletter|sustainability|locations?|history|company|team|press-?room|media-?center|downloads?|design-?services?)\b/i;
      // A second pattern that matches anywhere within the LAST slug — catches
      // pages with composed slugs like "iguzzini-newsletter-registration-form/"
      // that wouldn't trigger the "starts-with-/" pattern above. These slugs
      // tend to contain words that mean "this is a form / signup / account
      // page", not a product page.
      const NON_PRODUCT_SLUG_RE =
        /\b(newsletter|register|registration|registrate|registrazione|registrierung|inscription|abonn|signup|sign-?up|subscribe|subscription|abonnement|abonnement-newsletter|formular|formulaire|preferences|cookie-policy|cookie-settings|consent|disclaimer|impressum|cmpref)\b/i;

      // Strip locale prefix (/en/, /us/, /en-us/, /ca/, etc.) and return
      // the path "after locale". Returns the original path if no locale is
      // detected.
      function stripLocale(path: string): string {
        const m = path.match(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/i);
        return m ? path.slice(m[0].length) : path;
      }

      // Slug looks like a product/family content slug (not a generic word).
      // Accepts: multi-word hyphenated slugs ("laser-blade", "agora-integral-10"),
      //          single content words 4+ chars ("agora", "linealuce").
      // Rejects: very short, all-numeric, generic dictionary words, file-y.
      const GENERIC_SLUGS = new Set([
        "products", "product", "family", "families", "range", "ranges",
        "series", "catalog", "catalogue", "downloads", "download",
        "solutions", "solution", "lighting", "indoor", "outdoor",
        "interior", "exterior", "applications", "application", "all",
      ]);
      function isContentSlug(slug: string): boolean {
        const s = slug.toLowerCase();
        if (s.length < 4) return false;
        if (GENERIC_SLUGS.has(s)) return false;
        if (/^\d+$/.test(s)) return false;
        if (/\.(html?|aspx?|php|jsp)$/i.test(s)) return false;
        // Must contain at least one letter run of 3+ chars.
        return /[a-z]{3,}/i.test(s);
      }

      // Count hyphenated content tokens in a slug. Used to distinguish
      // multi-word product variants ("linealuce-47-recessed") from single-
      // word family / category names ("linealuce", "agora").
      function slugTokenCount(slug: string): number {
        return slug
          .split(/[-_]/)
          .filter((t) => t.length >= 3 && /[a-z]/i.test(t))
          .length;
      }

      function isProductLike(path: string): boolean {
        if (/\/products?\/?$/i.test(path)) return false;
        if (NOISE_PATH_RE.test(path)) return false;
        if (NON_PRODUCT_SLUG_RE.test(path)) return false;
        // Marker-based (modern catalog software): unambiguous product page.
        if (/--p-\d+/i.test(path)) return true;
        if (/\/products?\/\d+\/[a-z0-9-]+\/?$/i.test(path)) return true;
        if (/\/products?\/[a-z0-9-]+\/?$/i.test(path) && !/--sf-\d+/i.test(path)) {
          return true;
        }
        // Generic: 1 segment after locale, MULTI-TOKEN slug (iGuzzini-style:
        // `/ca/agora-integral-10/`, `/en/laser-blade-original-5-cells/`).
        // Single-token slugs like `/ca/agora/` are families — they go through
        // isFamilyLike instead. Caller still applies the niche filter unless
        // the family is in a trusted (Perplexity-confirmed) context.
        const tail = stripLocale(path);
        const segs = tail.split("/").filter(Boolean);
        if (
          segs.length === 1 &&
          isContentSlug(segs[0]) &&
          slugTokenCount(segs[0]) >= 2
        ) {
          return true;
        }
        return false;
      }
      function isFamilyLike(path: string): boolean {
        // Marker-based: unambiguous family/sub-family.
        if (/--s?f-\d+/i.test(path)) return true;
        if (/\/products?\/[a-z][a-z0-9-]+\/?$/i.test(path) && !/--p-\d+/i.test(path)) {
          return true;
        }
        if (NOISE_PATH_RE.test(path)) return false;
        if (NON_PRODUCT_SLUG_RE.test(path)) return false;
        // Generic: any 1-segment-after-locale content slug (single OR multi
        // token). Multi-token slugs are also product-like; the harvester
        // dispatches to product first via isProductLike. This means
        // `/ca/linealuce/` reaches here as a family candidate while
        // `/ca/linealuce-47-recessed/` is already routed to products.
        const tail = stripLocale(path);
        const segs = tail.split("/").filter(Boolean);
        if (segs.length === 1 && isContentSlug(segs[0])) return true;
        return false;
      }

      // Pool of every on-host non-noise URL we've seen across all renders.
      // Used as a last-resort rescue: if slug-based niche filtering rejects
      // everything (brand sites whose URL slugs don't contain niche keywords,
      // e.g. iGuzzini's `/ca/agora/`, `/ca/linealuce/`), we send this pool
      // to Perplexity for product-page classification.
      const candidatePool = new Set<string>();

      // Extract the meaningful slug-tokens from a path: take the last segment
      // (after locale) and split on -/_, keeping content tokens (3+ chars,
      // contains a letter). This is what we compare across parent/child URLs
      // to decide if a child genuinely belongs to the parent family.
      function slugTokensOf(url: string): Set<string> {
        try {
          const u = new URL(url);
          const tail = stripLocale(u.pathname);
          const segs = tail.split("/").filter(Boolean);
          if (!segs.length) return new Set();
          const last = segs[segs.length - 1].toLowerCase();
          return new Set(
            last
              .split(/[-_]/)
              .filter((t) => t.length >= 4 && /[a-z]/i.test(t)),
          );
        } catch {
          return new Set();
        }
      }

      // Collect anchors from a single rendered page, splitting into product
      // URLs (return) and family URLs (also returned for recursion).
      async function harvest(
        target: string,
        opts: { scroll?: boolean; trusted?: boolean } = {},
      ): Promise<{
        productHrefs: string[];
        familyHrefs: string[];
      }> {
        if (visited.has(target)) return { productHrefs: [], familyHrefs: [] };
        visited.add(target);
        const r = await renderPageHtml(target, {
          waitUntil: "networkidle",
          timeoutMs: 30_000,
          blockResources: true,
          // Always scroll family / category pages — they have lazy grids.
          // 6 passes is enough for most catalogs; the anchor-count
          // stabilization check stops sooner if the grid is short.
          scrollPasses: 6,
          // Click "Load more" / "Show all" / accordion-expand UI to surface
          // hidden products before we harvest anchors.
          clickToReveal: true,
        });
        if (!r.html || r.status === 0) {
          console.warn(`[deep-extract] render failed: ${target}`);
          return { productHrefs: [], familyHrefs: [] };
        }
        console.log(
          `[deep-extract] rendered ${target} → ${r.html.length}B in ${r.timings.totalMs}ms`,
        );
        // Tokens of the page we're harvesting from — used as the "parent"
        // signature when checking if a discovered child URL belongs to this
        // family (vs. being sidebar / footer nav).
        const parentTokens = slugTokensOf(target);
        const productHrefs: string[] = [];
        const familyHrefs: string[] = [];
        const anchorRe =
          /<a\b[^>]*?href=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
        let m: RegExpExecArray | null;
        const seenHere = new Set<string>();
        while ((m = anchorRe.exec(r.html)) !== null) {
          const raw = (m[1] ?? m[2] ?? "").trim();
          if (!raw || raw.startsWith("#")) continue;
          let abs: URL;
          try {
            abs = new URL(raw, target);
          } catch {
            continue;
          }
          if (abs.host.replace(/^www\./, "") !== host) continue;
          abs.hash = "";
          abs.search = "";
          const norm = abs.toString();
          if (seenHere.has(norm)) continue;
          seenHere.add(norm);
          const path = abs.pathname;
          const lowerPath = path.toLowerCase();
          // ALWAYS reject negative keywords (exterior / outdoor / facade etc.).
          let hasNegative = false;
          for (const n of rules.negative) {
            if (lowerPath.includes(n)) { hasNegative = true; break; }
          }
          if (hasNegative) continue;

          // Add to the global candidate pool (any on-host content URL) so the
          // Perplexity-rescue step has something to classify even when slug-
          // based filtering rejects every candidate.
          if (!NOISE_PATH_RE.test(path) && !NON_PRODUCT_SLUG_RE.test(path)) {
            const tail = stripLocale(path);
            const segs = tail.split("/").filter(Boolean);
            if (segs.length >= 1 && segs.length <= 3 && isContentSlug(segs[segs.length - 1])) {
              candidatePool.add(norm);
            }
          }

          if (isProductLike(path)) {
            // TRUSTED context: product is on a Perplexity-confirmed in-niche
            // family or category page. We accept everything that passes the
            // negative filter and let the per-product vision verifier
            // (verifyProductMatchesNiche, run during processOne) reject
            // off-niche items by looking at the actual product image. This
            // is essential for category pages like /ca/eclairage-interieur/
            // that aggregate multiple brand families — children there don't
            // share a slug-token with the parent (e.g. iN60, Libera,
            // Filorail vs. parent "eclairage-interieur") but ARE legitimate
            // indoor linear products that vision can recognise.
            if (opts.trusted) {
              productHrefs.push(norm);
            } else if (passesNicheFilter(lowerPath, "", rules)) {
              productHrefs.push(norm);
            }
            // NOTE: we no longer require the child to share a slug-token
            // with the parent or contain a positive niche keyword — vision
            // is the ground truth and will catch any off-niche leakage.
            void parentTokens;
          } else if (isFamilyLike(path)) {
            familyHrefs.push(norm);
          }
        }
        console.log(
          `[deep-extract] from ${target}: ${productHrefs.length} product, ${familyHrefs.length} family candidates${opts.trusted ? " (trusted)" : ""}`,
        );
        return { productHrefs, familyHrefs };
      }

      // Seed targets — root URL + Perplexity-supplied category URLs.
      const seedTargets = [rootUrl, ...[...allCategoryUrls].slice(0, 4)];
      // Plus well-known catalog-index paths (which often have lazy-loaded
      // grids of every brand family — we render these with scroll on).
      const indexTargets = new Set<string>();
      try {
        const origin = new URL(rootUrl).origin;
        const path = new URL(rootUrl).pathname;
        // Locale-aware product index — match the locale of rootUrl.
        const localeMatch = path.match(/^\/[a-z]{2}(?:-[a-z]{2})?\//i);
        const locale = localeMatch ? localeMatch[0] : "/en-us/";
        indexTargets.add(`${origin}${locale}products/`);
        indexTargets.add(`${origin}/en-us/products/`);
        indexTargets.add(`${origin}/en/products/`);
        indexTargets.add(`${origin}/products/`);
      } catch {
        // ignore
      }

      const familyQueue = new Set<string>();
      let renderedAdded = 0;

      // Depth 0a — seeds (no scroll, fast).
      for (const target of seedTargets) {
        if (budgetExpired()) break;
        const { productHrefs, familyHrefs } = await harvest(target);
        for (const u of productHrefs) {
          if (productUrls.has(u)) continue;
          productUrls.add(u);
          renderedAdded++;
        }
        for (const u of familyHrefs) familyQueue.add(u);
      }

      // Depth 0b — catalog index pages WITH scroll, since their grids are
      // typically lazy-loaded.
      for (const target of indexTargets) {
        if (budgetExpired()) break;
        const { productHrefs, familyHrefs } = await harvest(target, { scroll: true });
        for (const u of productHrefs) {
          if (productUrls.has(u)) continue;
          productUrls.add(u);
          renderedAdded++;
        }
        for (const u of familyHrefs) familyQueue.add(u);
      }

      // Family filtering — when slugs are brand-named (Pista, Straw, SLD25),
      // the niche-keyword filter rejects all of them. Ask Perplexity which
      // ones actually match the user's collection so we don't render every
      // family page on the brand's catalog. Also remember which families came
      // back trusted so we can skip the positive-keyword filter on their
      // products (brand-named slugs like "ledstrip" / "MP 3.1" don't contain
      // "linear" but are linear products by virtue of the family).
      let familyList = [...familyQueue];
      const trustedFamilies = new Set<string>();
      if (familyList.length > 12) {
        familyList = await filterFamiliesViaPerplexity(familyList, niche);
        for (const u of familyList) trustedFamilies.add(u);
      } else {
        // Small list: every family already passed the slug-based niche filter
        // when it entered the queue, so trust them all. This lets brand-named
        // product slugs inside (e.g. "ledstrip", "MP 3.1") survive.
        for (const u of familyList) trustedFamilies.add(u);
      }
      familyList = familyList.slice(0, 15);
      console.log(
        `[deep-extract] depth-1: rendering ${familyList.length} in-niche family pages (trusted=${trustedFamilies.size})`,
      );

      // Depth 1 — follow family links to find products inside each family.
      for (const target of familyList) {
        if (budgetExpired()) break;
        const trusted = trustedFamilies.has(target);
        const { productHrefs, familyHrefs } = await harvest(target, { trusted });
        for (const u of productHrefs) {
          if (productUrls.has(u)) continue;
          productUrls.add(u);
          renderedAdded++;
        }
        for (const u of familyHrefs) {
          familyQueue.add(u);
          // Sub-families discovered inside a trusted family inherit trust.
          if (trusted) trustedFamilies.add(u);
        }
      }

      // Depth 2 — newly-discovered family pages. Prefer trusted families
      // (sub-families discovered inside a Perplexity-confirmed parent) over
      // untrusted ones, so noise families from the root catalog don't
      // exhaust the cap before the in-niche sub-families get processed.
      const unvisited = [...familyQueue].filter((u) => !visited.has(u));
      const trustedNext = unvisited.filter((u) => trustedFamilies.has(u));
      const untrustedNext = unvisited.filter((u) => !trustedFamilies.has(u));
      const depth2 = [...trustedNext, ...untrustedNext].slice(0, 8);
      if (depth2.length > 0 && !budgetExpired()) {
        console.log(
          `[deep-extract] depth-2: rendering ${depth2.length} more family pages (${trustedNext.length} trusted)`,
        );
        for (const target of depth2) {
          if (budgetExpired()) break;
          const trusted = trustedFamilies.has(target);
          const { productHrefs, familyHrefs } = await harvest(target, { trusted });
          for (const u of productHrefs) {
            if (productUrls.has(u)) continue;
            productUrls.add(u);
            renderedAdded++;
          }
          for (const u of familyHrefs) {
            if (trusted && !trustedFamilies.has(u)) {
              trustedFamilies.add(u);
              familyQueue.add(u);
            }
          }
        }
      }

      // ── PERPLEXITY RESCUE ──
      // For brand sites whose URLs don't carry niche keywords or `/products/`
      // markers (iGuzzini-style: `/ca/agora/`, `/ca/linealuce/`), the slug
      // filter rejects every candidate. Hand the unfiltered candidate pool
      // to Perplexity and ask which are product detail pages vs family pages
      // for our niche. We invoke this whenever the strict pipeline came up
      // short, regardless of niche-keyword density.
      if (
        !budgetExpired() &&
        productUrls.size < 5 &&
        candidatePool.size > 0 &&
        hasPerplexityKey()
      ) {
        const visitedPaths = new Set<string>();
        for (const u of visited) {
          try { visitedPaths.add(new URL(u).toString()); } catch {}
        }
        // Don't re-classify URLs we already know are family / visited /
        // already-product. Cap at 80 to keep the prompt under Perplexity's
        // context budget.
        const toClassify = [...candidatePool]
          .filter((u) => !productUrls.has(u))
          .slice(0, 80);
        if (toClassify.length > 0) {
          console.log(
            `[deep-extract] Perplexity rescue: classifying ${toClassify.length} candidates`,
          );
          try {
            const classification = await classifyCandidateUrlsViaPerplexity(
              toClassify,
              niche,
            );
            const newProducts = classification.products.filter(
              (u) => !productUrls.has(u),
            );
            for (const u of newProducts) {
              productUrls.add(u);
              renderedAdded++;
            }
            console.log(
              `[deep-extract] Perplexity rescue: +${newProducts.length} products, +${classification.families.length} families`,
            );
            // Render Perplexity-confirmed family pages with trusted=true so
            // brand-named product slugs inside survive the niche filter.
            const newFamilies = classification.families.filter(
              (u) => !visitedPaths.has(u),
            );
            for (const fam of newFamilies.slice(0, 12)) {
              if (budgetExpired()) break;
              trustedFamilies.add(fam);
              const { productHrefs, familyHrefs } = await harvest(fam, {
                trusted: true,
              });
              for (const u of productHrefs) {
                if (productUrls.has(u)) continue;
                productUrls.add(u);
                renderedAdded++;
              }
              for (const u of familyHrefs) {
                if (!trustedFamilies.has(u)) trustedFamilies.add(u);
                familyQueue.add(u);
              }
            }
            // One more pass: any sub-families discovered inside the rescue
            // pass should also be rendered.
            const rescueDepth2 = [...familyQueue]
              .filter((u) => !visited.has(u) && trustedFamilies.has(u))
              .slice(0, 6);
            for (const fam of rescueDepth2) {
              if (budgetExpired()) break;
              const { productHrefs } = await harvest(fam, { trusted: true });
              for (const u of productHrefs) {
                if (productUrls.has(u)) continue;
                productUrls.add(u);
                renderedAdded++;
              }
            }
          } catch (e) {
            console.warn("[deep-extract] Perplexity rescue failed:", e);
          }
        }
      }

      console.log(
        `[deep-extract] headless rendering added ${renderedAdded} product URLs`,
      );
    } catch (e) {
      console.warn("[deep-extract] headless render fallback failed:", e);
    }
  }

  // Perplexity-based final validator — given the entire list of product URLs
  // discovered by every prior step, return ONLY the URLs that match the
  // niche. Conservative: when in doubt the URL is dropped, not kept.
  async function validateProductUrlsViaPerplexity(
    urls: string[],
    nicheLabel: string,
  ): Promise<string[]> {
    if (urls.length === 0) return [];
    // Process in batches of 60 — keeps each prompt comfortably under budget.
    const BATCH = 60;
    const kept: string[] = [];
    for (let i = 0; i < urls.length; i += BATCH) {
      const slice = urls.slice(i, i + BATCH);
      const userPrompt = `You are validating discovered product URLs for the user's collection niche: "${nicheLabel}".

Return ONLY the URLs that are product detail pages MATCHING the niche. Drop:
  - Pages whose product is OUTSIDE the niche scope (e.g. outdoor when niche says indoor, exterior projector / bollard / facade / underwater / garden / pole light when niche is indoor linear).
  - Pages in a different language category that's clearly outdoor (e.g. French "extérieur"/"jardin"/"applique-extérieur"/"projecteur-pour-extérieur"; Italian "esterno"/"giardino"/"facciata"; German "außen"/"fassade"/"garten"; Spanish "exterior"/"fachada"/"jardín").
  - Generic category / overview pages that LIST products but aren't a single SKU detail page.
  - Forms / newsletter / signup / about pages.
  - Accessories, drivers, controls, mounting hardware (unless niche is specifically about those).

Be CONSERVATIVE — when uncertain, omit the URL.

Niche: "${nicheLabel}"

URLs:
${slice.map((u, idx) => `${idx + 1}. ${u}`).join("\n")}

Return JSON: { "matchingUrls": string[] } — only URLs you're confident match.`;
      try {
        const r = await perplexityChat<{ matchingUrls: string[] }>({
          systemPrompt:
            "Return only valid JSON. Be strict — only include URLs you're highly confident match the user's exact niche.",
          userPrompt,
          schema: {
            type: "object",
            properties: {
              matchingUrls: { type: "array", items: { type: "string" } },
            },
            required: ["matchingUrls"],
            additionalProperties: false,
          },
          schemaName: "validate_product_urls",
          maxTokens: 3000,
        });
        const valid = new Set(slice);
        for (const u of r.content.matchingUrls ?? []) {
          if (valid.has(u)) kept.push(u);
        }
      } catch (e) {
        console.warn("[deep-extract] validation batch failed:", e);
        // On batch failure, KEEP the slice — better to over-include than
        // drop everything when Perplexity is flaky.
        for (const u of slice) kept.push(u);
      }
    }
    return kept;
  }

  if (productUrls.size === 0) {
    console.warn(
      `[deep-extract] no in-niche product URLs found for "${niche}" on ${rootUrl}.`,
    );
  }

  // ── FINAL VALIDATION ──
  // For brand sites where the URL slug doesn't carry niche signal (iGuzzini
  // FR/IT/DE/ES catalogs, brand-named SKUs) discovery picks up some pages
  // that look product-shaped but are actually outdoor / accessory / category
  // pages. Hand the whole productUrls set to Perplexity for one final pass
  // and keep ONLY the URLs it confirms match the user's niche.
  if (
    productUrls.size > 8 &&
    hasPerplexityKey() &&
    !budgetExpired()
  ) {
    try {
      const before = productUrls.size;
      const list = [...productUrls];
      const confirmed = await validateProductUrlsViaPerplexity(list, niche);
      if (confirmed.length > 0 && confirmed.length < before) {
        const keep = new Set(confirmed);
        for (const u of list) if (!keep.has(u)) productUrls.delete(u);
        console.log(
          `[deep-extract] final Perplexity validation: kept ${productUrls.size}/${before}`,
        );
      } else if (confirmed.length === 0) {
        console.warn(
          `[deep-extract] Perplexity returned empty validation — keeping discovered list as-is`,
        );
      }
    } catch (e) {
      console.warn("[deep-extract] final Perplexity validation failed:", e);
    }
  }

  const picks: Array<{ url: string; name: string }> = [...productUrls]
    .slice(0, productCap)
    .map((u) => ({ url: u, name: productNames.get(u) ?? "" }));
  console.log(
    `[deep-extract] processing ${picks.length} product URLs (cap=${productCap})`,
  );

  // Step 2 — backfill brand-row profile fields from discovery results.
  const finalBrandName =
    (input.brandName?.trim() ||
      categoryDiscovery?.brandName?.trim() ||
      initialBrandName).trim();
  const profileUpdate: Record<string, unknown> = { updatedAt: new Date() };
  if (finalBrandName !== initialBrandName) profileUpdate.name = finalBrandName;
  if (categoryDiscovery?.parent) profileUpdate.parent = categoryDiscovery.parent;
  if (categoryDiscovery?.country) profileUpdate.country = categoryDiscovery.country;
  if (categoryDiscovery?.notes) profileUpdate.notes = categoryDiscovery.notes;
  if (Object.keys(profileUpdate).length > 1) {
    await db
      .update(competitors)
      .set(profileUpdate)
      .where(eq(competitors.id, brandRow.id));
    console.log(`[deep-extract] backfilled brand profile for ${finalBrandName}`);
  }
  revalidatePath("/competitors");

  // Step 2.5 — brand-level file harvest is now LAZY.
  // The user clicks "Extract Brand Files" on the brand row in Benchmark to
  // run aiExtractBrandFiles(competitorId) — saves time on initial extraction.
  const brandFilesAttached = 0;

  // Step 3 — per-product fetch + extract + persist + attach.
  let productsInserted = 0;
  let specsheetsAttached = 0;
  let documentsAttached = 0;

  const queue = [...picks];
  // 6-way concurrency on per-product processing. Each product = 1 page fetch +
  // 1 spec-PDF prefetch + 1 AI call + a parallel doc-download pool. With pool=6
  // a 30-product brand finishes in ~3-4 minutes instead of 10+.
  const POOL = 6;

  async function processOne(pick: { url: string; name: string }) {
    console.log(`[deep-extract] processing ${pick.url}`);
    let page: { html: string; text: string };
    try {
      const r = await fetchUrlFully(pick.url);
      page = { html: r.html, text: r.text };
    } catch (e) {
      console.warn(`[deep-extract] page fetch failed: ${pick.url}`, e);
      fetchErrors.push({
        url: pick.url,
        error: e instanceof Error ? e.message : "fetch failed",
      });
      return;
    }

    // ── Run AI extraction from page TEXT ONLY. Documents are extracted
    // lazily later (user clicks "Extract Documents" on the product card).
    // This makes initial deep-extract dramatically faster — no PDF downloads,
    // no PDF parses during the hot path.
    let extracted: Awaited<ReturnType<typeof extractSingleProduct>> | null = null;
    try {
      extracted = await extractSingleProduct({
        pageText: page.text,
        pageUrl: pick.url,
        niche,
        hintName: pick.name || undefined,
      });
    } catch (e) {
      console.warn("extractSingleProduct failed, falling back to stub:", pick.url, e);
      fetchErrors.push({
        url: pick.url,
        error: `extract failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
      // Do NOT return — fall through with a stub product.
    }

    // Always build a product object — extracted if available, otherwise a stub.
    const p = extracted?.product;
    let name = (p?.name || pick.name || "").trim();
    if (!name) {
      // Last resort: derive a name from the URL slug so we still record this
      // product and the user can edit it later.
      try {
        const slug = new URL(pick.url).pathname
          .split("/")
          .filter(Boolean)
          .pop() ?? "";
        name = slug
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase())
          .trim();
      } catch {
        // ignore
      }
    }
    if (!name) name = "Untitled product";

    // ── Images: try static, then ALWAYS render the page if static came up
    // empty. SPA brand sites (iGuzzini, SuperModular) only expose real product
    // images post-JS, so we can't skip the render here — the vision verifier
    // depends on having a real image to look at.
    let htmlImages = extractImageUrls(page.html, pick.url);
    if (htmlImages.length === 0) {
      try {
        const rendered = await renderPageHtml(pick.url, {
          waitUntil: "networkidle",
          timeoutMs: 25_000,
          blockResources: true,
          scrollPasses: 3,
          clickToReveal: true,
        });
        if (rendered.html) {
          const renderedImages = extractImageUrls(rendered.html, pick.url);
          if (renderedImages.length > 0) {
            htmlImages = renderedImages;
            console.log(
              `[deep-extract] rendered ${pick.url} → ${renderedImages.length} images`,
            );
          }
        }
      } catch (e) {
        console.warn(`[deep-extract] image render fallback failed: ${pick.url}`, e);
      }
    }

    // ── VISION VERIFICATION (mandatory gate) ──
    // Every candidate product is checked by GPT-4o vision against the niche.
    // URL slugs lie (iGuzzini's "Laser Blade" looks linear from the slug but
    // is a multi-cell downlight grid in the image). The verifier sees the
    // actual product photo and rejects mismatches. When no image was
    // extractable we still send a text-only verification — better than
    // letting a likely-wrong product through.
    if (niche) {
      try {
        const verdict = await verifyProductMatchesNiche({
          niche,
          productName: name,
          productDescription: p?.description ?? "",
          pageText: page.text?.slice(0, 1500),
          pageUrl: pick.url,
          imageUrls: htmlImages,
        });
        console.log(
          `[deep-extract] verify ${pick.url} → ${verdict.matches ? "✓" : "✗"} (${verdict.confidence}, "${verdict.productType}") ${verdict.reason}`,
        );
        if (!verdict.matches) {
          // Skip — don't persist a product that vision confirms is off-niche.
          fetchErrors.push({
            url: pick.url,
            error: `niche-rejected: ${verdict.productType} — ${verdict.reason}`,
          });
          return;
        }
      } catch (e) {
        console.warn(
          `[deep-extract] vision verification failed for ${pick.url} — keeping product as fallback`,
          e,
        );
      }
    }

    // Persist product row.
    let productId: number;
    try {
      const [row] = await db
        .insert(competitorProducts)
        .values({
          competitorId: brandRow.id,
          name,
          productCode: p?.productCode || null,
          productCategory: p?.productCategory || null,
          description: p?.description || null,
          imageUrls: htmlImages,
          sourceUrl: p?.sourceUrl || pick.url,
          specs: (p?.specs ?? {}) as unknown as Record<string, string | string[]>,
        })
        .returning({ id: competitorProducts.id });
      productId = row.id;
      productsInserted++;
    } catch (e) {
      console.warn("Failed to insert product", name, e);
      return;
    }

    // No file downloads here — they're lazy now (extracted on demand from
    // the product card via aiExtractProductFiles).
    void productId;
  }

  async function worker() {
    while (queue.length) {
      if (budgetExpired()) {
        console.warn(
          `[deep-extract] budget hit, ${queue.length} URLs left unprocessed`,
        );
        return;
      }
      const item = queue.shift();
      if (!item) return;
      await processOne(item);
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  revalidatePath("/competitors");
  console.log(
    `[deep-extract] DONE: ${productsInserted} products, ${specsheetsAttached} spec PDFs, ${documentsAttached} other docs, ${brandFilesAttached} brand files, ${fetchErrors.length} errors`,
  );
  return {
    brandId: brandRow.id,
    brandName: finalBrandName,
    pagesPicked: picks.length,
    pagesFetched: picks.length - fetchErrors.length,
    productsInserted,
    specsheetsAttached,
    documentsAttached,
    brandFilesAttached,
    fetchErrors,
  };
}

/**
 * Niche-driven URL/text matching rules. Each token in the collection name
 * expands to a set of POSITIVE keywords (must match at least one) and a set
 * of NEGATIVE keywords (must not match any) so we can deterministically
 * filter URLs without relying on the AI's judgment.
 *
 * Example — "Indoor Linear Light":
 *   positive: indoor, interior, linear, cove, grazing, wash, system,
 *             pendant, recessed, slot, suspended, surface, asymmetric…
 *   negative: outdoor, exterior, facade, underwater, inground, bollard,
 *             garden, parking, downlight, spot…
 */
type NicheRules = {
  positive: string[];
  negative: string[];
};

// Generic words that show up in every niche name and would massively over-
// match if used as positive keywords ("light" in "Indoor Linear Light"
// matches "downlight", "spotlight", "highlight", etc.). Excluded from
// positive expansion.
const NICHE_STOP_WORDS = new Set<string>([
  "light", "lights", "lighting", "luminaire", "luminaires", "fixture",
  "fixtures", "products", "product", "system", "systems", "collection",
  "category", "type", "types",
]);

function nicheRules(niche: string): NicheRules {
  const base = (niche || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !NICHE_STOP_WORDS.has(t));

  // Positive expansions — TIGHT vocabulary tested against Lumenpulse's
  // sitemap. We explicitly avoid generic words like "direct", "indirect",
  // "slot" because they match cylinder lights, downlights, etc. Brand-
  // specific positives ("lumenline", "lumencove") are listed because their
  // slugs don't contain a generic "linear" / "cove" substring (lumenline
  // contains "line" but not "linear").
  const positiveExpansions: Record<string, string[]> = {
    // Linear-niche positives — tight, multilingual. Includes equivalents in
    // FR / IT / DE / ES so brands that publish in those languages still match.
    // Brand-specific tokens ("lumenline", "lumencove", "linealuce") are
    // listed because their slugs don't contain a literal "linear" substring.
    linear: [
      "linear", "cove", "grazing", "graze",
      // FR / IT / DE / ES
      "lineaire", "linéaire", "lineari", "lineare", "linealuce",
      "systemes-lineaires", "systèmes-linéaires", "appareils-lineaires",
      "appareils-linéaires", "lineal", "linealen", "linear-light",
      "underscore", "ledtube", "ledstrip", "ledline", "ledstripe",
      "tape", "strip", "ruban-led", "bandes-led", "bande-led", "striscia-led",
      "lichtband", "lichtlinie", "tira-led",
      // brand-specific linear-family names commonly used
      "lumenline", "lumencove",
    ],
    indoor: [
      "indoor", "interior", "interieur", "intérieur", "interno",
      "innen", "innenraum", "innenbereich",
    ],
    outdoor: [
      "outdoor", "exterior", "landscape", "facade", "façade", "bollard",
      "inground", "in-ground", "underwater", "fountain", "pool",
      "lumenfacade", "lumenbeam", "lumenrun", "lumenarc", "lumendual",
      "lumenstone",
    ],
    architectural: ["architectural", "spec", "linear", "cove"],
    downlight: ["downlight", "recessed-can", "round-can"],
    pendant: ["pendant", "suspended"],
    recessed: ["recessed", "slot"],
    track: ["track", "magnetic", "magneto", "rail"],
    spot: ["spot", "spotlight", "accent"],
    decorative: ["decorative", "chandelier", "sconce"],
    tape: ["tape", "strip", "cove"],
    facade: ["facade", "façade", "exterior", "wallwash", "graze"],
  };

  // For each token, OPPOSITE concepts go in the negative list. Negative wins
  // over positive in passesNicheFilter, so adding outdoor brand-specific
  // prefixes here keeps "lumenfacade" / "lumenbeam" out of an "Indoor Linear"
  // collection even though those URLs might contain "linear" generically.
  const oppositeOf: Record<string, string[]> = {
    indoor: [
      // EN
      "outdoor", "exterior", "landscape", "facade", "façade", "bollard",
      "inground", "in-ground", "underwater", "fountain", "pool", "garden",
      "parking", "weather",
      // FR (iGuzzini / Erco French — extérieur, jardin, façade, extérieure)
      "exterieur", "extérieur", "exterieure", "extérieure", "exterieurs",
      "extérieurs", "exterieures", "extérieures", "outdoor-",
      "jardin", "facade-exterieure", "facades-exterieures",
      "applique-exterieur", "appliques-exterieur", "appliques-exterieures",
      "plafonnier-exterieur", "plafonniers-exterieur",
      "lampadaire", "lampadaires", "borne", "bornes",
      "encastres-au-sol", "encastre-au-sol", "encastre-jardin",
      "projecteur-exterieur", "projecteurs-exterieur",
      "projecteurs-pour-exterieur", "projecteur-pour-exterieur",
      "mural-exterieur", "muraux-exterieurs",
      "sur-mat", "systemes-sur-mat", "système-sur-mât",
      // IT
      "esterno", "esterni", "esterna", "esterne",
      "giardino", "giardini", "facciata", "facciate",
      "applique-da-esterno", "plafoniere-esterno", "lampione",
      "paletto", "paletti", "incasso-a-terra",
      // DE
      "aussen", "außen", "aussenleuchte", "außenleuchte",
      "fassade", "fassaden", "garten", "gartenleuchte",
      "wegeleuchte", "pollerleuchte", "scheinwerfer",
      // ES
      "exterior-es", "exteriores", "fachada", "fachadas",
      "luminaria-exterior", "luminarias-exterior", "jardin-es",
      "balizas",
      // Lumenpulse outdoor brand families
      "lumenfacade", "lumenbeam", "lumenrun", "lumenarc", "lumendual",
      "lumenstone", "lumenport", "lumenpoint",
    ],
    interior: [
      "exterior", "outdoor", "facade", "underwater", "lumenfacade",
      "lumenbeam", "lumenrun",
      "exterieur", "extérieur", "esterno", "aussen", "außen", "fassade",
      "jardin", "giardino", "garten",
    ],
    outdoor: ["indoor", "interior", "ceiling", "downlight",
      "interieur", "intérieur", "interno", "innen"],
    exterior: ["indoor", "interior", "interieur", "intérieur", "interno", "innen"],
    linear: [
      "downlight", "spotlight", "recessed-can", "decorative", "chandelier",
      "sconce", "track-head", "accent-spot",
    ],
    downlight: ["linear", "pendant", "track"],
    pendant: ["downlight", "track"],
    track: ["linear", "pendant", "downlight"],
  };

  // Scope tokens describe WHERE the product is used (indoor / outdoor /
  // exterior / interior). They should only contribute to NEGATIVE keywords
  // (rejecting the opposite scope), never to positive — otherwise URLs that
  // happen to contain the literal word "indoor" anywhere (e.g. a data
  // bridge labelled "indoor") sneak through. Form-factor tokens (linear,
  // downlight, pendant, etc.) contribute to BOTH positive and negative as
  // appropriate.
  const SCOPE_TOKENS = new Set(["indoor", "interior", "outdoor", "exterior"]);

  const positive = new Set<string>();
  const negative = new Set<string>();
  for (const t of base) {
    if (!SCOPE_TOKENS.has(t)) {
      // Add the literal niche token (but not scope-only tokens).
      positive.add(t);
      for (const e of positiveExpansions[t] ?? []) positive.add(e);
    }
    for (const o of oppositeOf[t] ?? []) negative.add(o);
  }
  // Anything in negative must not also be in positive — the user's explicit
  // form-factor tokens win.
  for (const t of base) negative.delete(t);
  for (const p of positive) negative.delete(p);

  return {
    positive: [...positive].filter((t) => t.length >= 4),
    negative: [...negative].filter((t) => t.length >= 4),
  };
}

/** Backwards-compat shim: the existing call sites just want the positive list. */
function nicheKeywordTokens(niche: string): string[] {
  return nicheRules(niche).positive;
}

/**
 * Test whether a URL passes the niche filter:
 *   - Path/text must contain at least one positive keyword (or no positives)
 *   - Path/text must NOT contain any negative keyword
 *
 * Returns true when the URL is in-niche.
 */
function passesNicheFilter(
  pathOrUrl: string,
  text: string,
  rules: NicheRules,
): boolean {
  const haystack = `${pathOrUrl} ${text}`.toLowerCase();
  // Reject if any negative keyword is present.
  for (const n of rules.negative) {
    if (haystack.includes(n)) return false;
  }
  // Accept if any positive keyword is present.
  if (rules.positive.length === 0) return true;
  for (const p of rules.positive) {
    if (haystack.includes(p)) return true;
  }
  return false;
}

function hostnameLabel(u: string): string {
  try {
    const host = new URL(u).host.replace(/^www\./, "");
    const part = host.split(".")[0];
    return part
      .split("-")
      .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
      .join(" ");
  } catch {
    return "Brand";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ON-DEMAND DOCUMENT EXTRACTION
//
// Triggered by the "Extract Documents" AI button on each product card and on
// each brand row in the Benchmark tab. Initial deep-extract intentionally
// skips file downloads — the user picks which products to fully extract,
// avoiding 25 PDF downloads per product across 30+ products.
// ─────────────────────────────────────────────────────────────────────────────

export type ProductFilesResult = {
  productId: number;
  productName: string;
  pdfsAttached: number;
  otherDocsAttached: number;
  fetchErrors: number;
  /** How many spec fields the auto-refresh updated after files were attached. */
  specFieldsUpdated: number;
  /** How many files the auto-refresh actually managed to read. */
  specFilesRead: number;
};

// JSON schema for the per-product document list returned by Perplexity.
const PRODUCT_DOCUMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          label: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "spec-sheet",
              "ies-photometric",
              "cad-drawing",
              "bim-revit",
              "brochure",
              "installation",
              "warranty",
              "manual",
              "certification",
              "image",
              "other",
            ],
          },
        },
        required: ["url", "label", "kind"],
      },
    },
  },
  required: ["documents"],
} as const;

export async function aiExtractProductFiles(input: {
  productId: number;
}): Promise<ProductFilesResult> {
  await requireCompetitorEditor();

  const [row] = await db
    .select()
    .from(competitorProducts)
    .where(eq(competitorProducts.id, input.productId))
    .limit(1);
  if (!row) throw new Error("Product not found");
  if (!row.sourceUrl) {
    throw new Error("Product has no source URL — can't extract files");
  }

  let pdfsAttached = 0;
  let otherDocsAttached = 0;
  let fetchErrors = 0;
  const docUrls = new Map<string, { label: string; kind: string }>();

  // ── PRIMARY: parse the embedded JSON blob in the product page HTML ──
  // Most modern brand sites (Lumenpulse confirmed) inject the product's
  // document categories + files as an HTML-encoded JSON structure into the
  // page. Parsing that gives us EVERY document — categorized exactly as the
  // brand presents it — without needing a headless browser or Perplexity.
  let pageHtml = "";
  try {
    const r = await fetchUrlFully(row.sourceUrl);
    pageHtml = r.html;
    const embedded = extractEmbeddedDocuments(pageHtml);
    console.log(
      `[aiExtractProductFiles] embedded JSON found ${embedded.length} documents`,
    );
    for (const d of embedded) {
      // Compose label as "<Category>: <Title>" so `classifyDocument` sees
      // both the brand's category label (e.g. "Brochures") and the file
      // title (e.g. "App guide Cove") when picking a canonical kind. The
      // category alone — e.g. "Brochures", "Installation Instructions" —
      // is enough to disambiguate every PDF that doesn't have an obvious
      // keyword in its title.
      docUrls.set(d.url, {
        label: `${d.category}: ${d.title || "(untitled)"}`.slice(0, 250),
        kind: categoryLabelToKind(d.category) ?? "",
      });
    }
  } catch (e) {
    console.warn("[aiExtractProductFiles] page fetch failed:", row.sourceUrl, e);
    fetchErrors++;
  }

  // ── SECONDARY: Perplexity (only if embedded extraction returned nothing) ──
  if (docUrls.size === 0 && hasPerplexityKey()) {
    try {
      const sourceUrl = row.sourceUrl;
      const host = new URL(sourceUrl).host.replace(/^www\./, "");
      const userPrompt = `On the product page at ${sourceUrl}, list every downloadable document file the brand publishes for this product.

Look in the "Documents", "Downloads", "Resources", "Spec sheets", "IES Files", "BIM", "CAD" sections. Be exhaustive — include EVERY variant (different CCT / wattage / mounting / lens variants often each have their own spec sheet & IES file).

For each document return:
- url: the direct download URL (must start with https://${host} or its CDN)
- label: the human label/title (e.g. "Spec Sheet — 3000K", "IES File — 25W 4000K", "BIM Family")
- kind: one of "spec-sheet" | "ies-photometric" | "cad-drawing" | "bim-revit" | "brochure" | "installation" | "warranty" | "manual" | "certification" | "image" | "other"

Categorization guidance:
- spec-sheet: PDF cut sheets / datasheets / spec sheets
- ies-photometric: .ies or .ldt photometric files
- cad-drawing: DWG / DXF dimensional or technical drawings
- bim-revit: RFA / RVT / SKP / STEP / 3D model files
- brochure: family brochure / catalog
- installation: install instructions / mounting guide
- warranty: warranty document
- manual: user / operating manual
- certification: UL / DLC / FCC / RoHS / IEC compliance docs
- image: high-res product photos / renders explicitly offered for download

Return JSON: { "documents": [{ url, label, kind }] }`;
      const r = await perplexityChat<{ documents: Array<{ url: string; label: string; kind: string }> }>({
        systemPrompt: "Return only valid JSON. Be exhaustive — list every downloadable document file you can find for this product.",
        userPrompt,
        schema: PRODUCT_DOCUMENTS_SCHEMA,
        schemaName: "product_documents",
        searchDomains: [host],
        maxTokens: 4000,
      });
      for (const d of r.content.documents ?? []) {
        const u = (d.url ?? "").trim();
        if (!/^https?:\/\//i.test(u)) continue;
        if (docUrls.has(u)) continue;
        docUrls.set(u, {
          label: (d.label ?? "").slice(0, 200),
          kind: d.kind || "other",
        });
      }
      console.log(
        `[aiExtractProductFiles] Perplexity returned ${docUrls.size} candidate URLs for product ${input.productId}`,
      );
    } catch (e) {
      console.warn("[aiExtractProductFiles] Perplexity failed:", e);
    }
  }

  // ── FALLBACK 1: anchor-based scrape on the same fetched HTML for sites
  //    that don't embed JSON. Cheap because we already have the HTML in memory.
  if (docUrls.size === 0 && pageHtml) {
    for (const d of extractDocumentLinks(pageHtml, row.sourceUrl)) {
      docUrls.set(d.href, { label: d.text, kind: d.kind });
    }
    const subPages = extractDownloadSubpageLinks(pageHtml, row.sourceUrl);
    for (const subUrl of subPages.slice(0, 3)) {
      try {
        const sub = await fetchUrlFully(subUrl);
        for (const d of extractDocumentLinks(sub.html, subUrl)) {
          if (!docUrls.has(d.href)) {
            docUrls.set(d.href, { label: d.text, kind: d.kind });
          }
        }
      } catch (e) {
        console.warn("[aiExtractProductFiles] sub-page fetch failed:", subUrl, e);
      }
    }
  }

  // ── FALLBACK 2: HEADLESS RENDERING — for sites whose product page docs
  //    are only injected after JavaScript runs (true SPAs). We launch
  //    Chromium, render the page, and re-run the document parsers on the
  //    post-JS DOM.
  if (docUrls.size === 0) {
    try {
      console.log(
        `[aiExtractProductFiles] no docs from static HTML, rendering with Chromium…`,
      );
      const r = await renderPageHtml(row.sourceUrl, {
        waitUntil: "networkidle",
        timeoutMs: 25_000,
        blockResources: true,
      });
      if (r.html && r.html.length > 0) {
        console.log(
          `[aiExtractProductFiles] rendered ${r.html.length} bytes in ${r.timings.totalMs}ms`,
        );
        // While we have post-JS HTML, refresh product images too. This
        // upgrades old rows whose stored imageUrls are stale (e.g. brand
        // logos picked up before the SPA-render fix landed).
        try {
          const renderedImages = extractImageUrls(r.html, row.sourceUrl);
          if (renderedImages.length > 0) {
            await db
              .update(competitorProducts)
              .set({ imageUrls: renderedImages, updatedAt: new Date() })
              .where(eq(competitorProducts.id, input.productId));
            console.log(
              `[aiExtractProductFiles] refreshed ${renderedImages.length} image URLs for product ${input.productId}`,
            );
          }
        } catch (e) {
          console.warn("[aiExtractProductFiles] image refresh failed:", e);
        }
        // Re-run BOTH the embedded-JSON parser (some SPAs inject data after
        // hydration) AND the anchor parser (JS-injected anchors).
        for (const d of extractEmbeddedDocuments(r.html)) {
          docUrls.set(d.url, {
            label: `${d.category}: ${d.title || "(untitled)"}`.slice(0, 250),
            kind: categoryLabelToKind(d.category) ?? "",
          });
        }
        for (const d of extractDocumentLinks(r.html, row.sourceUrl)) {
          if (!docUrls.has(d.href)) {
            docUrls.set(d.href, { label: d.text, kind: d.kind });
          }
        }
        const subPages = extractDownloadSubpageLinks(r.html, row.sourceUrl);
        for (const subUrl of subPages.slice(0, 2)) {
          try {
            const subR = await renderPageHtml(subUrl, {
              waitUntil: "networkidle",
              timeoutMs: 20_000,
              blockResources: true,
            });
            if (subR.html) {
              for (const d of extractDocumentLinks(subR.html, subUrl)) {
                if (!docUrls.has(d.href)) {
                  docUrls.set(d.href, { label: d.text, kind: d.kind });
                }
              }
            }
          } catch {
            // ignore sub-page failures
          }
        }
        console.log(
          `[aiExtractProductFiles] post-render: ${docUrls.size} doc URLs found`,
        );
      }
    } catch (e) {
      console.warn("[aiExtractProductFiles] headless render failed:", e);
    }
  }

  // ── Download all in parallel pool of 4. The classifier in
  //    `attachProductDocument` will use the label hint when classifying. ──
  const list = [...docUrls.entries()].slice(0, 50);
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) return;
      const [url, meta] = entry;
      const ok = await attachProductDocument(input.productId, url, meta.label);
      if (!ok) {
        fetchErrors++;
        continue;
      }
      if (
        /\.pdf(\?|$)/i.test(url) ||
        /spec|cut[- ]?sheet|datasheet|brochure|catalog/i.test(url)
      ) {
        pdfsAttached++;
      } else {
        otherDocsAttached++;
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));

  revalidatePath("/competitors");
  console.log(
    `[aiExtractProductFiles] product ${input.productId}: pdfs=${pdfsAttached} other=${otherDocsAttached} errors=${fetchErrors}`,
  );

  // Auto-refresh specs from EVERY file attached to the product (not just the
  // ones we just downloaded). If extraction was idempotent (rerun without new
  // files) we still want to re-analyze with Claude — the user may have set
  // ANTHROPIC_API_KEY between runs, or we may have a smarter prompt now.
  // refreshProductSpecsFromFiles decides whether there's anything to read.
  let specFieldsUpdated = 0;
  let specFilesRead = 0;
  try {
    const r = await refreshProductSpecsFromFiles({ productId: input.productId });
    specFieldsUpdated = r.fieldsUpdated;
    specFilesRead = r.filesRead;
    console.log(
      `[aiExtractProductFiles] auto-refresh: read ${r.filesRead} files, updated ${r.fieldsUpdated} fields`,
    );
  } catch (e) {
    console.warn(
      "[aiExtractProductFiles] auto-refresh failed (extraction kept):",
      e,
    );
  }

  return {
    productId: input.productId,
    productName: row.name,
    pdfsAttached,
    otherDocsAttached,
    fetchErrors,
    specFieldsUpdated,
    specFilesRead,
  };
}

export type BrandFilesResult = {
  competitorId: number;
  brandName: string;
  filesAttached: number;
  fetchErrors: number;
};

export async function aiExtractBrandFiles(input: {
  competitorId: number;
}): Promise<BrandFilesResult> {
  await requireCompetitorEditor();

  const [row] = await db
    .select()
    .from(competitors)
    .where(eq(competitors.id, input.competitorId))
    .limit(1);
  if (!row) throw new Error("Brand not found");
  if (!row.website) {
    throw new Error("Brand has no website — can't extract files");
  }

  let filesAttached = 0;
  let fetchErrors = 0;
  const docUrls = new Map<string, { label: string; kind: string }>();

  const origin = (() => {
    try {
      return new URL(row.website).origin;
    } catch {
      return null;
    }
  })();
  if (!origin) throw new Error("Invalid brand website");
  const host = new URL(row.website).host.replace(/^www\./, "");

  // ── PRIMARY: Perplexity ──
  if (hasPerplexityKey()) {
    try {
      const userPrompt = `For the brand at ${row.website} (${row.name}), list every COMPANY-LEVEL downloadable document. These are documents that describe the brand or whole catalog, NOT individual product spec sheets.

Look in /about, /downloads, /resources, /literature, /documents, /sustainability, /certifications, /design-tools — anywhere the brand publishes their company brochure, line card, full product catalog, sustainability report, certifications, BIM library archives, IES library archives, design / specification tools.

For each document return:
- url: direct download URL (must start with https://${host} or its CDN)
- label: human title
- kind: one of "spec-sheet" | "ies-photometric" | "cad-drawing" | "bim-revit" | "brochure" | "installation" | "warranty" | "manual" | "certification" | "image" | "other"

EXCLUDE per-product spec sheets — those belong on the product, not the brand row.

Return JSON: { "documents": [{ url, label, kind }] }`;
      const r = await perplexityChat<{ documents: Array<{ url: string; label: string; kind: string }> }>({
        systemPrompt: "Return only valid JSON. Be exhaustive.",
        userPrompt,
        schema: PRODUCT_DOCUMENTS_SCHEMA,
        schemaName: "brand_documents",
        searchDomains: [host],
        maxTokens: 3000,
      });
      for (const d of r.content.documents ?? []) {
        const u = (d.url ?? "").trim();
        if (!/^https?:\/\//i.test(u)) continue;
        if (docUrls.has(u)) continue;
        docUrls.set(u, {
          label: (d.label ?? "").slice(0, 200),
          kind: d.kind || "other",
        });
      }
      console.log(
        `[aiExtractBrandFiles] Perplexity returned ${docUrls.size} candidate URLs for brand ${input.competitorId}`,
      );
    } catch (e) {
      console.warn("[aiExtractBrandFiles] Perplexity failed:", e);
    }
  }

  // ── FALLBACK: static-HTML scrape across common brand pages ──
  if (docUrls.size === 0) {
    const brandPagesToScan = new Set<string>();
    brandPagesToScan.add(row.website);
    brandPagesToScan.add(`${origin}/`);
    for (const path of [
      "/about", "/about-us", "/company", "/who-we-are",
      "/downloads", "/resources", "/literature", "/documents", "/files",
      "/sustainability", "/certifications",
    ]) {
      brandPagesToScan.add(`${origin}${path}`);
    }
    const scanResults = await Promise.allSettled(
      [...brandPagesToScan].map((u) =>
        fetchUrlFully(u).then((r) => ({ u, html: r.html })),
      ),
    );
    for (const r of scanResults) {
      if (r.status !== "fulfilled") {
        fetchErrors++;
        continue;
      }
      for (const d of extractDocumentLinks(r.value.html, r.value.u)) {
        if (/\/products?\/[^/]+\/[^/]+\/.+\.(pdf|ies|ldt|dwg|dxf|rfa|rvt)/i.test(d.href)) continue;
        if (docUrls.has(d.href)) continue;
        docUrls.set(d.href, { label: d.text, kind: d.kind });
      }
    }
  }

  // Download in parallel pool of 6.
  const list = [...docUrls.entries()].slice(0, 40);
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) return;
      const [url, meta] = entry;
      const ok = await attachBrandDocument(input.competitorId, url, meta.label);
      if (ok) filesAttached++;
      else fetchErrors++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => worker()));

  revalidatePath("/competitors");
  console.log(
    `[aiExtractBrandFiles] brand ${input.competitorId}: ${filesAttached} files attached, ${fetchErrors} errors`,
  );
  return {
    competitorId: input.competitorId,
    brandName: row.name,
    filesAttached,
    fetchErrors,
  };
}
