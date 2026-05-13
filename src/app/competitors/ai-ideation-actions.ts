"use server";

import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  competitorCollections,
  competitors,
  competitorProducts,
  competitorIdeationItems,
} from "@/db/schema";
import { AI_MODEL, openaiClient } from "@/lib/ai/openai";
import { requireCompetitorEditor } from "@/lib/permissions";
import {
  withProductHashFallback,
  LEGACY_PRODUCT_COLS,
} from "./_attachments";

// ─────────────────────────────────────────────────────────────────────────────
// AI IDEATION — given a collection's existing reference images plus optional
// user prompt + image URLs, returns a list of structured product ideas the team
// could build to compete in the same niche.
// ─────────────────────────────────────────────────────────────────────────────

const IDEATION_SYSTEM = `You are a senior lighting product designer running a creative brainstorm.

You receive:
1. The collection name and a short description of the niche we're competing in.
2. A list of existing competitor products in the niche (names, categories, mounting).
3. Reference images uploaded by the user (real-world products, sketches, moodboards, mounting details).
4. An optional free-form prompt or "creative direction" from the user.

Your job is to generate bold, diverse product concepts that PUSH the niche forward — not safe clones of what's already there. Aim wide:
- Mix safe-and-buildable concepts with 1–2 deliberate stretches (new form factor, unusual mounting, novel optic, trim profile, modular system, integration with sensors / acoustics / shelving / etc.).
- Each idea must be SUBSTANTIVELY different from the others — different mounting, optic family, scale, OR target room.
- Vary the materials/finishes (anodized aluminum, blackened steel, oak/walnut, glass diffuser, fabric, ceramic, composite, recycled, etc.).
- Reference details from the user's images (what makes it inspiring, what it tells you the user wants) but don't copy any single product wholesale.
- Be specific with rough specs the team can validate (lumens range, CCT, IP rating, mounting, finish, dimensions).
- For at least one idea, include a notable optic choice (frosted, prismatic, asymmetric wallwash, microprismatic, honeycomb, cluster, lambertian, linear lens) and explain why.

Respond with a JSON object: { "ideas": Idea[] } where Idea = {
  "name": string,                       // catchy short name
  "category": string,                   // e.g. "Linear Pendant", "Wall Wash", "Recessed Slot"
  "concept": string,                    // 2–3 sentence pitch — what's the hook
  "mounting": string,                   // e.g. "Suspended cable", "Surface", "Recessed", "Magnetic track"
  "finishes": string[],                 // 2–4 e.g. ["Anodized Black", "Brushed Aluminum", "Walnut end cap"]
  "dimensions": string,                 // e.g. "1500mm × 50mm × 35mm" or "Modular: 600/1200/1800mm"
  "wattage": string,                    // e.g. "20–60W (selectable)"
  "lumens": string,                     // e.g. "3000–8000lm"
  "cct": string,                        // e.g. "2700–4000K tunable, optional 1800K dim-to-warm"
  "ipRating": string,                   // e.g. "IP20" or "IP65 (wet variant)"
  "differentiators": string[],          // 3–5 bullets — what wins vs the existing market
  "risks": string[]                     // 2–3 bullets — what could go wrong / what's hard
}

Generate 6–10 ideas. Avoid redundancy: if two concepts feel similar, pick one and make the other one bolder.`;

export type IdeationIdea = {
  name: string;
  category: string;
  concept: string;
  mounting: string;
  finishes: string[];
  dimensions: string;
  wattage: string;
  lumens: string;
  cct: string;
  ipRating: string;
  differentiators: string[];
  risks: string[];
};

const IDEA_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          concept: { type: "string" },
          mounting: { type: "string" },
          finishes: { type: "array", items: { type: "string" } },
          dimensions: { type: "string" },
          wattage: { type: "string" },
          lumens: { type: "string" },
          cct: { type: "string" },
          ipRating: { type: "string" },
          differentiators: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
        },
        required: [
          "name",
          "category",
          "concept",
          "mounting",
          "finishes",
          "dimensions",
          "wattage",
          "lumens",
          "cct",
          "ipRating",
          "differentiators",
          "risks",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
} as const;

export async function aiGenerateIdeas(input: {
  collectionId: number;
  // Optional user-supplied refs in addition to existing ideation items.
  extraImageUrls?: string[];
  // Optional free-form prompt.
  prompt?: string;
  // Cap on images fed to the model (each image counts against context).
  maxImages?: number;
}): Promise<{ ideas: IdeationIdea[] }> {
  await requireCompetitorEditor();

  const [coll] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, input.collectionId))
    .limit(1);
  if (!coll) throw new Error("Collection not found");

  const brands = await db
    .select()
    .from(competitors)
    .where(eq(competitors.collectionId, input.collectionId))
    .orderBy(asc(competitors.name));

  const products = brands.length
    ? await withProductHashFallback(
        () =>
          db
            .select()
            .from(competitorProducts)
            .orderBy(asc(competitorProducts.name)),
        () =>
          db
            .select(LEGACY_PRODUCT_COLS)
            .from(competitorProducts)
            .orderBy(asc(competitorProducts.name)),
      )
    : [];

  const items = await db
    .select()
    .from(competitorIdeationItems)
    .where(eq(competitorIdeationItems.collectionId, input.collectionId))
    .orderBy(asc(competitorIdeationItems.sortOrder));

  // Build image array — existing ideation items, then any extras passed in.
  const cap = Math.max(1, Math.min(input.maxImages ?? 12, 16));
  const allImages = [
    ...items.map((i) => i.imageUrl),
    ...(input.extraImageUrls ?? []),
  ]
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, cap);

  const productSummary = products
    .filter((p) => brands.find((b) => b.id === p.competitorId))
    .slice(0, 60)
    .map((p) => {
      const brand = brands.find((b) => b.id === p.competitorId)?.name ?? "?";
      const cat = p.productCategory ?? "uncategorized";
      const mounting =
        Array.isArray(p.specs?.mounting)
          ? p.specs.mounting.join(", ")
          : (typeof p.specs?.mounting === "string" ? p.specs.mounting : "");
      return `- ${brand} / ${p.name}${
        p.productCode ? ` [${p.productCode}]` : ""
      } — ${cat}${mounting ? ` (${mounting})` : ""}`;
    })
    .join("\n");

  const userText = [
    `Collection: ${coll.name}${coll.description ? ` — ${coll.description}` : ""}`,
    "",
    productSummary
      ? `Existing competitor products in this collection:\n${productSummary}`
      : "No existing competitor products in this collection.",
    "",
    input.prompt?.trim()
      ? `User prompt:\n${input.prompt.trim()}`
      : "No user prompt — focus on common patterns in the reference images.",
    "",
    allImages.length
      ? `${allImages.length} reference image(s) attached below.`
      : "No reference images attached.",
  ].join("\n");

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: userText }];
  for (const url of allImages) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  const client = openaiClient();
  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    // Higher temperature → more creative variance across runs.
    temperature: 0.85,
    top_p: 0.95,
    presence_penalty: 0.4,
    messages: [
      { role: "system", content: IDEATION_SYSTEM },
      // The OpenAI types don't directly accept the union here, but the runtime
      // does — cast through unknown to satisfy TS without losing structure.
      { role: "user", content: userContent as unknown as string },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ideation_ideas",
        schema: IDEA_SCHEMA,
        strict: true,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("AI returned empty response");
  const parsed = JSON.parse(raw) as { ideas: IdeationIdea[] };
  return { ideas: parsed.ideas ?? [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI BENCHMARK — summarize commonalities across a collection: most common
// mountings, finishes, sizes; gaps and opportunities. Uses existing product
// data only (no external fetch); fast and cheap.
// ─────────────────────────────────────────────────────────────────────────────

const BENCHMARK_SYSTEM = `You are a senior lighting product analyst.

You receive a list of competitor products in one niche (the collection). For each product, you have name, category, dimensions, wattage, lumens, CCT, mounting, finishes, IP rating, certifications, and short description.

Produce a structured benchmark summary as JSON: {
  "marketStandard": {
    "commonMountings": string[],     // most common mounting types, ordered by frequency
    "commonFinishes": string[],      // most common finishes, ordered by frequency
    "commonDimensions": string[],    // common length/width patterns
    "commonWattages": string[],      // common wattage tiers
    "commonLumenRanges": string[],   // typical lumen output ranges
    "commonCcts": string[],          // common CCT options
    "commonIpRatings": string[]      // common IP ratings
  },
  "categoryBreakdown": [             // most common product categories
    { "category": string, "count": number, "examples": string[] }
  ],
  "gaps": string[],                  // 2–4 product/spec opportunities not well covered
  "differentiators": string[]        // 2–4 ways a new product could stand out
}

Be specific and concise — no hedging. If data is sparse, say so explicitly in gaps.`;

export type BenchmarkSummary = {
  marketStandard: {
    commonMountings: string[];
    commonFinishes: string[];
    commonDimensions: string[];
    commonWattages: string[];
    commonLumenRanges: string[];
    commonCcts: string[];
    commonIpRatings: string[];
  };
  categoryBreakdown: Array<{
    category: string;
    count: number;
    examples: string[];
  }>;
  gaps: string[];
  differentiators: string[];
};

const BENCHMARK_SCHEMA = {
  type: "object",
  properties: {
    marketStandard: {
      type: "object",
      properties: {
        commonMountings: { type: "array", items: { type: "string" } },
        commonFinishes: { type: "array", items: { type: "string" } },
        commonDimensions: { type: "array", items: { type: "string" } },
        commonWattages: { type: "array", items: { type: "string" } },
        commonLumenRanges: { type: "array", items: { type: "string" } },
        commonCcts: { type: "array", items: { type: "string" } },
        commonIpRatings: { type: "array", items: { type: "string" } },
      },
      required: [
        "commonMountings",
        "commonFinishes",
        "commonDimensions",
        "commonWattages",
        "commonLumenRanges",
        "commonCcts",
        "commonIpRatings",
      ],
      additionalProperties: false,
    },
    categoryBreakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          count: { type: "number" },
          examples: { type: "array", items: { type: "string" } },
        },
        required: ["category", "count", "examples"],
        additionalProperties: false,
      },
    },
    gaps: { type: "array", items: { type: "string" } },
    differentiators: { type: "array", items: { type: "string" } },
  },
  required: ["marketStandard", "categoryBreakdown", "gaps", "differentiators"],
  additionalProperties: false,
} as const;

export async function aiBenchmarkCollection(input: {
  collectionId: number;
}): Promise<BenchmarkSummary> {
  await requireCompetitorEditor();

  const [coll] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, input.collectionId))
    .limit(1);
  if (!coll) throw new Error("Collection not found");

  const brands = await db
    .select()
    .from(competitors)
    .where(eq(competitors.collectionId, input.collectionId));

  const products = brands.length
    ? await withProductHashFallback(
        () => db.select().from(competitorProducts),
        () => db.select(LEGACY_PRODUCT_COLS).from(competitorProducts),
      )
    : [];
  const filtered = products.filter((p) =>
    brands.find((b) => b.id === p.competitorId),
  );
  if (!filtered.length) {
    throw new Error("No competitor products in this collection yet");
  }

  const summary = filtered
    .slice(0, 200)
    .map((p) => {
      const brand = brands.find((b) => b.id === p.competitorId)?.name ?? "?";
      const specs = p.specs ?? {};
      const flat = Object.entries(specs)
        .map(([k, v]) =>
          `${k}=${Array.isArray(v) ? v.join("|") : String(v ?? "")}`,
        )
        .filter((s) => !s.endsWith("="))
        .join("; ");
      return `${brand} / ${p.name}${
        p.productCode ? ` [${p.productCode}]` : ""
      } — cat:${p.productCategory ?? "?"}; ${flat}`;
    })
    .join("\n");

  const userText = [
    `Collection: ${coll.name}${
      coll.description ? ` — ${coll.description}` : ""
    }`,
    "",
    `Products (${filtered.length}):`,
    summary,
  ].join("\n");

  const client = openaiClient();
  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: BENCHMARK_SYSTEM },
      { role: "user", content: userText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "benchmark_summary",
        schema: BENCHMARK_SCHEMA,
        strict: true,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("AI returned empty response");
  return JSON.parse(raw) as BenchmarkSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECSHEET BUNDLE — return every product attachment URL for a collection so
// the client can zip and download them. Cheaper than streaming through the
// server, since the blobs are public.
// ─────────────────────────────────────────────────────────────────────────────

import { competitorProductAttachments } from "@/db/schema";

export type SpecsheetEntry = {
  brand: string;
  productName: string;
  productCode: string | null;
  attachment: {
    id: number;
    name: string;
    url: string;
    size: number;
    mimeType: string | null;
    kind: string | null;
  };
};

export async function listCollectionSpecsheets(
  collectionId: number,
): Promise<SpecsheetEntry[]> {
  await requireCompetitorEditor();

  const brands = await db
    .select()
    .from(competitors)
    .where(eq(competitors.collectionId, collectionId));
  if (!brands.length) return [];

  const products = await withProductHashFallback(
    () => db.select().from(competitorProducts),
    () => db.select(LEGACY_PRODUCT_COLS).from(competitorProducts),
  );
  const productsInColl = products.filter((p) =>
    brands.find((b) => b.id === p.competitorId),
  );
  if (!productsInColl.length) return [];

  const atts = await db.select().from(competitorProductAttachments);

  const out: SpecsheetEntry[] = [];
  for (const p of productsInColl) {
    const brand = brands.find((b) => b.id === p.competitorId);
    const productAtts = atts.filter((a) => a.productId === p.id);
    for (const a of productAtts) {
      // Anything that looks like a spec doc — PDFs, IES, datasheets/drawings.
      const ext = (a.name.split(".").pop() ?? "").toLowerCase();
      const isSpecDoc =
        a.kind === "drawing" ||
        a.kind === "datasheet" ||
        a.kind === "ies" ||
        ext === "pdf" ||
        ext === "ies" ||
        ext === "dwg" ||
        ext === "dxf";
      if (!isSpecDoc) continue;
      out.push({
        brand: brand?.name ?? "Unknown",
        productName: p.name,
        productCode: p.productCode,
        attachment: {
          id: a.id,
          name: a.name,
          url: a.url,
          size: a.size,
          mimeType: a.mimeType,
          kind: a.kind,
        },
      });
    }
  }
  return out;
}
