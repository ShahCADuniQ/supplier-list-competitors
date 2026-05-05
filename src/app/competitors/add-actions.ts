"use server";

// User-driven product entry. The user pastes a URL / uploads a PDF / drops
// images for a product they're interested in; we identify the brand, extract
// product details with AI, auto-create the brand if it doesn't exist in the
// collection, persist the product, and attach the user-provided files.
//
// This is the inverse of research-actions.ts (which crawls a brand's whole
// catalog from a brand URL). Here the user curates the input one product at
// a time and the brand records accumulate as a side-effect.

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  competitors,
  competitorProducts,
  competitorProductAttachments,
} from "@/db/schema";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import type Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL, openaiClient } from "@/lib/ai/openai";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "@/lib/ai/claude";
import {
  fetchUrlFully,
  parseFile,
  type ParsedSource,
} from "@/lib/ai/parsers";
import { renderPageHtml } from "@/lib/ai/render";
import { extractImageUrls } from "@/lib/ai/parsers";
import { requireCompetitorEditor } from "@/lib/permissions";
import { classifyDocument } from "./_attachments";

// ─────────────────────────────────────────────────────────────────────────────
// AI EXTRACTION SCHEMA (brand + product from arbitrary source)
// ─────────────────────────────────────────────────────────────────────────────

const TIER_KEYS = ["mass", "mid", "spec", "premium"] as const;

// Canonical lighting spec schema. Covers the full architectural-spec sheet
// surface — geometry, photometry, color quality, electrical, optical,
// mounting / installation, certifications, and lifecycle. Every field is
// required (strict JSON schema) so the model returns a populated record;
// empty strings are fine when a value isn't stated.
const PRODUCT_SPECS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // ── Geometry ──
    dimensions: { type: "string", description: "Free-form full dimensions with units. e.g. '1200×25×25 mm', '4 ft', '2x4'." },
    maxLength: { type: "string", description: "Longest single / continuous run available, with units. e.g. '12 ft (continuous run)'." },
    length: { type: "string", description: "Per-section lengths the product ships in, comma list. e.g. '2 ft, 4 ft, 8 ft' or '600 / 1200 / 2400 mm'." },
    profileFaceSize: { type: "string", description: "Linear profile face / cross-section dimensions. e.g. '25×25 mm', '35×80 mm', '1.4\\\" wide'." },
    cutout: { type: "string", description: "Recessed / trimless cut-out dimensions. e.g. 'Ø 100 mm', '1200×25 mm trimless cutout'." },
    weight: { type: "string", description: "Fixture weight per unit / per ft / per mm. e.g. '1.4 kg/m', '3.2 lbs/ft'." },
    // ── Photometry ──
    lumens: { type: "string", description: "Lumen output (range or per-CCT). e.g. '500-2400 lm', '900 lm @ 3000K'." },
    wattage: { type: "string", description: "Wattage options. e.g. '8W / 14W / 20W'." },
    efficacy: { type: "string", description: "Lumens per watt. e.g. '120 lm/W'." },
    cct: { type: "string", description: "Color temperature(s). e.g. '2700K, 3000K, 3500K, 4000K' or 'Tunable 2700-6500K'." },
    cri: { type: "string", description: "Color rendering index. e.g. 'CRI > 90' or 'CRI 80 / 90 / 97'." },
    r9: { type: "string", description: "R9 (red) rendering value. e.g. 'R9 > 50', 'R9 > 90'. Empty if unstated." },
    sdcm: { type: "string", description: "MacAdam ellipse / colour consistency. e.g. '3 SDCM', '<2-step'. Empty if unstated." },
    beamAngle: { type: "string", description: "Beam angle(s) — comma list when multiple optics. e.g. '15° / 25° / 40° / 60°'." },
    opticType: { type: "string", description: "Optic / reflector type. e.g. 'Reflector', 'TIR lens', 'Asymmetric optic', 'Wall-wash optic'." },
    ugr: { type: "string", description: "Unified Glare Rating. e.g. 'UGR < 19', 'UGR < 16'. Empty if unstated." },
    // ── Electrical ──
    voltage: { type: "string", description: "Input voltage. e.g. '120-277V', '24VDC'." },
    powerFactor: { type: "string", description: "Power factor. e.g. 'PF > 0.9'. Empty if unstated." },
    inrushCurrent: { type: "string", description: "Inrush current spec. e.g. '14A peak / 250µs'. Empty if unstated." },
    driverLocation: { type: "string", description: "'Internal', 'External', 'Both', or empty." },
    driverType: { type: "string", description: "Driver model / brand if specified. e.g. 'Tridonic LCO', 'eldoLED ECOdrive'." },
    dimming: { type: "string", description: "Dimming protocols, comma list. e.g. '0-10V, DALI-2, TRIAC, Casambi, Bluetooth'." },
    // ── Mounting & form ──
    mounting: { type: "string", description: "Mounting types comma-separated. Use canonical: Surface, Suspended, Recessed, Wall, Cove, Track, Inground, Pole, Stem, Magnetic." },
    orientation: { type: "string", description: "'Direct', 'Indirect', 'Direct/Indirect', or empty (mostly relevant for pendants)." },
    lensType: { type: "string", description: "Lens / diffuser type comma-separated. Use canonical: Frosted, Prismatic, Asymmetric, Symmetric, Clear, Opal, Microprismatic, Honeycomb-Louver, Diffuser, Cluster, Lambertian, Linear, Wall-Wash." },
    housingMaterial: { type: "string", description: "Housing material. e.g. 'Anodized aluminum extrusion', 'Die-cast aluminum'." },
    finishes: { type: "array", items: { type: "string" }, description: "Finish options (anodised, powder-coat, etc.)." },
    colors: { type: "array", items: { type: "string" }, description: "Available colors. e.g. ['White', 'Black', 'Bronze']." },
    // ── Environment & safety ──
    ipRating: { type: "string", description: "IP rating. e.g. 'IP20', 'IP65', 'IP67'." },
    ikRating: { type: "string", description: "IK impact rating. e.g. 'IK08'. Empty if unstated." },
    operatingTemp: { type: "string", description: "Ambient operating temperature range. e.g. '-20°C to +40°C', 'ta = 25°C'." },
    // ── Lifecycle ──
    lifespan: { type: "string", description: "Rated life. e.g. 'L70 50,000 hrs', 'L80B10 60,000 hrs'." },
    warranty: { type: "string", description: "Warranty terms. e.g. '5 years', '10 years on driver'." },
    countryOfOrigin: { type: "string", description: "Where the product is made. e.g. 'Italy', 'Made in USA'." },
    // ── Standards ──
    certifications: { type: "array", items: { type: "string" }, description: "Standards / certifications. e.g. ['UL', 'DLC Premium', 'cULus', 'CE', 'RoHS', 'IEC 60598-1']." },
    // ── Customisation ──
    customization: { type: "array", items: { type: "string" }, description: "Custom options. e.g. ['Custom length', 'Custom CCT', 'RAL finish']." },
    accessories: { type: "array", items: { type: "string" }, description: "Accessories sold or compatible. e.g. ['End caps', 'Aircraft cable kit', 'Plaster trim', 'Joiners', 'Recess kit']." },
    // ── Catch-all ──
    notes: { type: "string", description: "Anything else worth recording (mounting detail, control compatibility, photometric distribution, etc.)." },
  },
  required: [
    "dimensions", "maxLength", "length", "profileFaceSize", "cutout", "weight",
    "lumens", "wattage", "efficacy", "cct", "cri", "r9", "sdcm", "beamAngle",
    "opticType", "ugr",
    "voltage", "powerFactor", "inrushCurrent", "driverLocation", "driverType", "dimming",
    "mounting", "orientation", "lensType", "housingMaterial", "finishes", "colors",
    "ipRating", "ikRating", "operatingTemp",
    "lifespan", "warranty", "countryOfOrigin",
    "certifications", "customization", "accessories", "notes",
  ],
};

const ADD_PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brand: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: "Brand / manufacturer name as it appears on the source.",
        },
        website: {
          type: "string",
          description: "Brand homepage URL — empty string if not visible.",
        },
        parent: { type: "string" },
        country: { type: "string" },
        tierKey: { type: "string", enum: [...TIER_KEYS] },
        notes: { type: "string" },
      },
      required: ["name", "website", "parent", "country", "tierKey", "notes"],
    },
    product: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        productCode: { type: "string" },
        productCategory: { type: "string" },
        description: { type: "string" },
        sourceUrl: { type: "string" },
        imageUrls: { type: "array", items: { type: "string" } },
        specs: PRODUCT_SPECS_SCHEMA,
      },
      required: [
        "name", "productCode", "productCategory", "description", "sourceUrl",
        "imageUrls", "specs",
      ],
    },
  },
  required: ["brand", "product"],
} as const;

type AddProductExtraction = {
  brand: {
    name: string;
    website: string;
    parent: string;
    country: string;
    tierKey: typeof TIER_KEYS[number];
    notes: string;
  };
  product: {
    name: string;
    productCode: string;
    productCategory: string;
    description: string;
    sourceUrl: string;
    imageUrls: string[];
    specs: Record<string, string | string[]>;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INPUT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AddedAttachment = {
  url: string;
  name: string;
  mime: string | null;
  size: number;
  blobPathname: string;
};

export type AddProductInput = {
  collectionId: number;
  /** Optional product page URL (preferred — gives the AI structured info). */
  url?: string | null;
  /** Pre-uploaded files (PDFs, images) the AI should read. */
  attachments?: AddedAttachment[];
  /** Free-form note / hint the user typed, e.g. "this is the new XAL Slot 4". */
  hint?: string | null;
  /** Niche label, used as a hint in the prompt. */
  niche?: string | null;
};

export type AddProductResult = {
  brandId: number;
  brandName: string;
  brandCreated: boolean;
  productId: number;
  productName: string;
  attachedFileCount: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────────────────────────────────────

export async function aiAddProductFromInput(
  input: AddProductInput,
): Promise<AddProductResult> {
  await requireCompetitorEditor();

  const url = (input.url ?? "").trim();
  const attachments = input.attachments ?? [];
  const hint = (input.hint ?? "").trim();

  if (!url && attachments.length === 0 && !hint) {
    throw new Error(
      "Provide at least a URL, a file, or a hint about the product.",
    );
  }

  // ── 1. Build the source context the AI will read ──
  const sources: ParsedSource[] = [];
  let pageHtml = "";

  if (url) {
    let html = "";
    let text = "";
    try {
      const r = await fetchUrlFully(url);
      html = r.html;
      text = r.text;
    } catch (e) {
      console.warn("[aiAddProduct] static fetch failed, will try render", url, e);
    }
    // For SPA brand sites the static HTML is empty — fall back to a render.
    if (!text || text.length < 200) {
      try {
        const rendered = await renderPageHtml(url, {
          waitUntil: "networkidle",
          timeoutMs: 25_000,
          blockResources: true,
          scrollPasses: 3,
          clickToReveal: true,
        });
        if (rendered.html) {
          html = rendered.html;
          // Strip tags for a readable text version.
          text = rendered.html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
            .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60_000);
        }
      } catch (e) {
        console.warn("[aiAddProduct] headless render failed", url, e);
      }
    }
    pageHtml = html;
    sources.push({
      label: url,
      text: `URL CONTENT (${url}):\n${text || "[no readable text]"}`,
    });
  }

  // Fetch + parse each user-uploaded file from the blob URL.
  for (const att of attachments) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        sources.push({
          label: att.name,
          text: `[Could not fetch attachment ${att.name}: HTTP ${res.status}]`,
        });
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      sources.push(await parseFile(buf, att.mime ?? "", att.name));
    } catch (e) {
      sources.push({
        label: att.name,
        text: `[Failed to read ${att.name}: ${e instanceof Error ? e.message : "error"}]`,
      });
    }
  }

  if (hint) {
    sources.push({ label: "user hint", text: `User note: ${hint}` });
  }

  // ── 2. Build OpenAI message content (text + any uploaded image data URLs) ──
  const textBlock = sources
    .map((s) => `=== ${s.label} ===\n${s.text}`)
    .join("\n\n");
  const messageParts: ChatCompletionContentPart[] = [
    { type: "text", text: textBlock || "[no usable input]" },
  ];
  for (const s of sources) {
    if (s.imageDataUrl) {
      messageParts.push({
        type: "image_url",
        image_url: { url: s.imageDataUrl, detail: "high" },
      });
    }
  }

  // ── 3. Call AI with strict JSON schema ──
  const niche = (input.niche ?? "").trim();
  const systemPrompt = `You are identifying a single lighting product the user is researching, plus the brand that makes it.

You'll be given a mix of:
  - A product page URL with cleaned text
  - PDF spec sheets / catalog pages
  - Photographs of the product (use vision to read what they show)
  - A free-form user note

Your output is JSON: { "brand": {...}, "product": {...} }.

For the brand:
  - "name" = brand / manufacturer name as printed on the source (e.g. "Lumenpulse", "iGuzzini", "XAL", "Lithonia").
  - "website" = brand homepage URL ("https://www.lumenpulse.com/"), empty string if you can't tell.
  - "parent" = parent / owner company. "" if independent.
  - "country" = "USA (NY)" form. Empty if unsure.
  - "tierKey" = "mass" | "mid" | "spec" | "premium" — pick the most likely tier.
      mass = big-box / value commodity (Hyperikon, Sunco, Feit)
      mid = mid-tier commercial (RAB, MaxLite, Signify Standard)
      spec = architectural / agency-channel (Lithonia, Cooper, Cree, Axis, XAL, Lumenpulse, iGuzzini)
      premium = premium / decorative / tape (WAC, Diode LED, Tech Lighting, Erco)
  - "notes" = 1-2 sentence positioning summary.

For the product:
  - "name" = the product's actual brand-given name (e.g. "Lumenline", "Linealuce 47", "Slot 4").
  - "productCode" = SKU / model code if printed. Empty otherwise.
  - "productCategory" = short shape-of-fixture label like "Linear Pendant", "Recessed Slot", "LED Strip", "Track Spotlight".
  - "description" = 1-2 sentence product summary.
  - "sourceUrl" = canonical product page URL — use the input URL if it's the product page, otherwise empty.
  - "imageUrls" = absolute URLs to product photos visible in the source. Skip if none — never invent URLs.
  - "specs" — fill every field the source actually states. Empty string is fine when not stated; never invent values. Use canonical vocabulary where listed:

    Geometry:
      dimensions / maxLength / length (per-section list) / profileFaceSize / cutout / weight
      profileFaceSize: cross-section dims of the linear profile, e.g. "25×25 mm".
      cutout: recessed / trimless cut-out dims, e.g. "Ø 100 mm" or "1200×25 mm".

    Photometry:
      lumens / wattage / efficacy ("120 lm/W") / cct / cri ("CRI > 90") / r9 ("R9 > 50")
      sdcm: MacAdam ellipse, e.g. "3 SDCM"
      beamAngle: comma list when multiple optics, e.g. "15°, 25°, 40°, 60°"
      opticType: Reflector / TIR lens / Asymmetric / Wall-wash / etc.
      ugr: Unified Glare Rating, e.g. "UGR < 19"

    Electrical:
      voltage / powerFactor ("PF > 0.9") / inrushCurrent / driverType / dimming
      driverLocation: Internal / External / Both
      dimming: comma list of protocols (0-10V, DALI-2, TRIAC, Casambi, Bluetooth, …)

    Form / mounting:
      mounting: Surface / Suspended / Recessed / Wall / Cove / Track / Inground / Pole / Stem / Magnetic
      orientation: Direct / Indirect / Direct/Indirect (mostly for pendants)
      lensType: Frosted / Prismatic / Asymmetric / Symmetric / Clear / Opal / Microprismatic / Honeycomb-Louver / Diffuser / Cluster / Lambertian / Linear / Wall-Wash
      housingMaterial / finishes (array) / colors (array)

    Environment & safety:
      ipRating ("IP20", "IP65") / ikRating ("IK08") / operatingTemp ("-20°C to +40°C")

    Lifecycle & standards:
      lifespan ("L70 50,000 hrs") / warranty ("5 years") / countryOfOrigin / certifications (array)

  - For arrays, list every option mentioned. Don't invent values.

${niche ? `Niche hint: "${niche}". Use this to interpret ambiguous text — but DO NOT exclude the product because of it.` : ""}`;

  const client = openaiClient();
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: messageParts },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "add_product_extraction",
        strict: true,
        schema: ADD_PRODUCT_SCHEMA,
      },
    },
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("AI returned no content");
  const parsed = JSON.parse(raw) as AddProductExtraction;

  // ── 4. Look up or create the brand in this collection ──
  const brandName = parsed.brand.name?.trim();
  if (!brandName) {
    throw new Error("Could not identify a brand from the input.");
  }

  let brandRow = await db
    .select()
    .from(competitors)
    .where(
      and(
        eq(competitors.collectionId, input.collectionId),
        sql`lower(${competitors.name}) = lower(${brandName})`,
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  let brandCreated = false;
  if (!brandRow) {
    const [created] = await db
      .insert(competitors)
      .values({
        collectionId: input.collectionId,
        name: brandName,
        website: parsed.brand.website || null,
        parent: parsed.brand.parent || null,
        tierKey: parsed.brand.tierKey,
        country: parsed.brand.country || null,
        notes: parsed.brand.notes || null,
      })
      .returning();
    brandRow = created;
    brandCreated = true;
  } else if (
    !brandRow.website ||
    !brandRow.country ||
    !brandRow.notes
  ) {
    // Best-effort: backfill any missing brand profile fields from the AI.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (!brandRow.website && parsed.brand.website) patch.website = parsed.brand.website;
    if (!brandRow.parent && parsed.brand.parent) patch.parent = parsed.brand.parent;
    if (!brandRow.country && parsed.brand.country) patch.country = parsed.brand.country;
    if (!brandRow.notes && parsed.brand.notes) patch.notes = parsed.brand.notes;
    if (Object.keys(patch).length > 1) {
      await db
        .update(competitors)
        .set(patch)
        .where(eq(competitors.id, brandRow.id));
    }
  }

  // ── 5. Build the imageUrls list — prefer AI-extracted URLs that resolve;
  //      fall back to the page's HTML-extracted gallery if AI gave nothing.
  let imageUrls: string[] = (parsed.product.imageUrls ?? [])
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter((u) => /^https?:\/\//i.test(u));
  if (imageUrls.length === 0 && pageHtml && url) {
    imageUrls = extractImageUrls(pageHtml, url);
  }
  // If the user uploaded images themselves, use those blob URLs as fallbacks.
  if (imageUrls.length === 0) {
    imageUrls = attachments
      .filter((a) => (a.mime ?? "").startsWith("image/"))
      .map((a) => a.url);
  }

  // ── 6. Persist the product row ──
  const [productRow] = await db
    .insert(competitorProducts)
    .values({
      competitorId: brandRow.id,
      name: parsed.product.name?.trim() || "Untitled product",
      productCode: parsed.product.productCode || null,
      productCategory: parsed.product.productCategory || null,
      description: parsed.product.description || null,
      sourceUrl: parsed.product.sourceUrl || url || null,
      imageUrls,
      specs: parsed.product.specs as unknown as Record<string, string | string[]>,
    })
    .returning();

  // ── 7. Attach every user-uploaded file (PDFs, images) to the product ──
  let attachedFileCount = 0;
  for (const att of attachments) {
    try {
      const classified = classifyDocument({
        url: att.url,
        label: att.name,
        contentType: att.mime ?? "",
      });
      await db.insert(competitorProductAttachments).values({
        productId: productRow.id,
        name: att.name,
        size: att.size,
        mimeType: att.mime,
        kind: classified.kind,
        url: att.url,
        blobPathname: att.blobPathname,
      });
      attachedFileCount++;
    } catch (e) {
      console.warn("[aiAddProduct] failed to attach file", att.name, e);
    }
  }

  revalidatePath("/competitors");
  return {
    brandId: brandRow.id,
    brandName: brandRow.name,
    brandCreated,
    productId: productRow.id,
    productName: productRow.name,
    attachedFileCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH SPECS FROM ATTACHED PDFs (Claude-powered)
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec sheets carry the values architects actually need (profile face size,
// per-section length, lumen tables, etc.) but the deep extractor often only
// has the source page text. This action pulls every attached PDF for a given
// product and hands them to Claude AS NATIVE DOCUMENTS — Claude reads PDFs
// directly (preserving tables, dimensional drawings, photometric tables) so
// fields like profileFaceSize / length are pulled accurately.
// Identity fields (name, code, category, image URLs) are NOT overwritten —
// only specs and description are merged. When ANTHROPIC_API_KEY isn't set we
// fall back to the OpenAI text-extraction path.

const SPECS_ONLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", description: "1-2 sentence summary of the product. Update if the PDFs reveal more accurate text." },
    specs: PRODUCT_SPECS_SCHEMA,
  },
  required: ["description", "specs"],
} as const;

type SpecsOnlyExtraction = {
  description: string;
  specs: Record<string, string | string[]>;
};

export type RefreshSpecsResult = {
  productId: number;
  productName: string;
  filesRead: number;
  fieldsUpdated: number;
};

const SPEC_REFRESH_SYSTEM_PROMPT = `You are an exhaustive spec-sheet extractor for architectural lighting. The product is already identified (name + brand). Your job: read EVERY page of EVERY attached PDF (spec sheets, photometric reports, install guides, brochures, dimensional drawings, IES summaries) plus the product page text, and fill EVERY field below the source actually states.

Be thorough. Spec sheets put values in tables, dimensional callouts, photometric curves, footnotes, and back-page certification lists. Walk through every page methodically. If a value appears on page 1 *and* in a page-4 table, prefer the more specific table form. If multiple variants exist (e.g. 3000K / 4000K columns, 6 different optic types, 4 mounting kits), list ALL of them comma-separated.

═══════════ FIELDS TO FILL ═══════════

GEOMETRY:
  • profileFaceSize — face / cross-section dimensions of a linear profile. e.g. "25×25 mm", "35×80 mm", "60×60 mm". List ALL face sizes the product is offered in: "20×20 mm, 35×35 mm, 50×50 mm". Read dimensional drawings on the front pages of the PDF.
  • length — discrete per-section lengths in the order book. e.g. "2 ft, 4 ft, 8 ft" or "600 / 1200 / 2400 mm". Every variant.
  • maxLength — longest single / continuous run, e.g. "12 ft (continuous run via joiners)".
  • cutout — recessed / trimless cut-out dimensions, e.g. "Ø 100 mm" or "1200×25 mm trimless cutout".
  • dimensions — full free-form dimensions when no separate field captures it. e.g. "1200×25×25 mm".
  • weight — fixture weight per unit / per ft / per metre.

PHOTOMETRY (mostly in the spec table on pages 2-4):
  • lumens — lumen output. List every variant: "504 lm / 1008 lm / 2016 lm @ 3000K".
  • wattage — wattage options.
  • efficacy — lumens per watt, e.g. "120 lm/W".
  • cct — every CCT offered: "2700K, 3000K, 3500K, 4000K" or "Tunable 2700-6500K".
  • cri — Color Rendering Index. e.g. "CRI > 90" or "CRI 80 / 90 / 97".
  • r9 — R9 (red) rendering, e.g. "R9 > 50".
  • sdcm — MacAdam ellipse / colour consistency, e.g. "3 SDCM" or "<2-step".
  • beamAngle — every optic angle offered, comma-listed: "15°, 25°, 40°, 60°, 90° wallwash".
  • opticType — Reflector / TIR lens / Asymmetric / Wall-wash / Honeycomb-louver, etc.
  • ugr — Unified Glare Rating, e.g. "UGR < 19".

ELECTRICAL (often a back-page table):
  • voltage — input voltage(s). e.g. "120V / 220V / 277V" or "24VDC".
  • powerFactor — e.g. "PF > 0.9".
  • inrushCurrent — e.g. "14A peak / 250µs".
  • driverLocation — Internal, External, Both.
  • driverType — driver brand + model when listed (e.g. "Tridonic LCO", "eldoLED ECOdrive").
  • dimming — every protocol called out, comma list. "0-10V, DALI-2, TRIAC, Casambi, Bluetooth".

FORM & MOUNTING:
  • mounting — comma list. canonical: Surface, Suspended, Recessed, Wall, Cove, Track, Inground, Pole, Stem, Magnetic.
  • orientation — Direct, Indirect, Direct/Indirect (mostly pendants).
  • lensType — comma list. canonical: Frosted, Prismatic, Asymmetric, Symmetric, Clear, Opal, Microprismatic, Honeycomb-Louver, Diffuser, Cluster, Lambertian, Linear, Wall-Wash.
  • housingMaterial — e.g. "Anodized aluminum extrusion", "Die-cast aluminum".
  • finishes — array of every finish option.
  • colors — array of every color.

ENVIRONMENT & SAFETY:
  • ipRating — IP20 / IP65 / IP67.
  • ikRating — IK06 / IK08 / IK10.
  • operatingTemp — e.g. "-20°C to +40°C", "ta = 25°C".

LIFECYCLE & STANDARDS:
  • lifespan — e.g. "L70 50,000 hrs", "L80B10 60,000 hrs".
  • warranty — e.g. "5 years", "10 years on driver".
  • countryOfOrigin — where it's manufactured.
  • certifications — array. UL / cULus / DLC Premium / CE / RoHS / IEC 60598-1 / ENEC / TÜV / etc.

CUSTOMISATION:
  • customization — array. "Custom length", "Custom CCT", "RAL finish", "Custom optic", "Special voltage".
  • accessories — array. "End caps", "Aircraft cable kit", "Plaster trim", "Joiners", "Recess kit".
  • notes — any other useful detail.

═══════════ RULES ═══════════

  1. Read every page. Spec sheets are 2-8 pages and important values hide in tables on later pages.
  2. Don't invent values that aren't in the source. Empty string is acceptable.
  3. List ALL options for fields that vary by SKU (CCT, wattage, lumens, beamAngle, etc.) — don't pick a representative one.
  4. Use canonical vocabulary where listed.
  5. Rewrite the product description (1-2 sentences) if the PDFs give a better summary than the current one.
  6. Use the record_product_specs tool to return your findings — that's the only way to respond.`;

export async function refreshProductSpecsFromFiles(input: {
  productId: number;
}): Promise<RefreshSpecsResult> {
  await requireCompetitorEditor();

  if (!hasClaudeKey()) {
    console.warn(
      `[refreshSpecs] ANTHROPIC_API_KEY is NOT set. PDFs will be skipped and OpenAI text-only fallback will run — set the key in .env to enable native PDF analysis.`,
    );
  }

  const [row] = await db
    .select()
    .from(competitorProducts)
    .where(eq(competitorProducts.id, input.productId))
    .limit(1);
  if (!row) throw new Error("Product not found");

  // Pull every attached file. Only PDFs are forwarded to Claude — IES, DWG,
  // RFA, xlsx, txt and friends are skipped (Claude can't read them natively
  // and stuffing a giant text dump into the request just inflates payload).
  const atts = await db
    .select()
    .from(competitorProductAttachments)
    .where(eq(competitorProductAttachments.productId, input.productId));

  // PDFs: fetched as base64 to send to Claude as document content blocks.
  const pdfDocuments: Array<{ name: string; base64: string; bytes: number }> = [];
  // otherSources is kept in scope but never populated — the analyzer signature
  // still accepts it for backward compatibility. Empty array on every call.
  const otherSources: ParsedSource[] = [];
  let filesRead = 0;

  // 1. PDFs only. Other file types (IES, DWG, RFA, xlsx, txt) are skipped —
  //    Claude can't read those natively. EVERY PDF is queued; the analyzer
  //    batches them across multiple Claude calls so total payload size is
  //    not a constraint. PDFs whose binary size would push a single batch
  //    over the API limit (after ~33% base64 inflation + JSON overhead)
  //    fall back to pdf-parse text extraction.
  //
  //    Anthropic accepts up to 32 MB total request body. 22 MB binary →
  //    ~29 MB encoded → ~31 MB total with JSON envelope. Anything larger
  //    on its own can't be a "document" content block (a single-PDF batch
  //    would 413), so we extract text instead.
  const ANTHROPIC_PER_DOC_LIMIT = 22 * 1024 * 1024; // 22 MB binary
  const t0 = Date.now();

  // Filter + score so the most useful PDFs land in the first batch (in case
  // later batches hit a transient error, the first batch still has the gold).
  function pdfRank(name: string): number {
    const n = name.toLowerCase();
    if (/spec[\s_-]?sheet|cut[\s_-]?sheet|data[\s_-]?sheet|specsheet/.test(n)) return 0;
    if (/brochure|catalog|catalogue/.test(n)) return 1;
    if (/install|warranty|manual|user[\s_-]?guide/.test(n)) return 2;
    return 3;
  }

  const pdfCandidates = atts
    .filter((a) => {
      const mime = (a.mimeType ?? "").toLowerCase();
      return (
        mime === "application/pdf" || /\.pdf(\?|$)/i.test(a.name)
      );
    })
    .sort((a, b) => pdfRank(a.name) - pdfRank(b.name));

  // Parallelize PDF blob fetches — sequential awaits add up fast when there
  // are many attachments. Promise.allSettled so a single bad URL doesn't
  // tank the whole batch.
  let textFallbackCount = 0;
  const fetchResults = await Promise.allSettled(
    pdfCandidates.map(async (att) => {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`${res.status} ${att.url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { att, buf };
    }),
  );
  for (let i = 0; i < fetchResults.length; i++) {
    const r = fetchResults[i];
    if (r.status === "rejected") {
      console.warn("[refreshSpecs] PDF fetch failed", pdfCandidates[i].name, r.reason);
      continue;
    }
    const { att, buf } = r.value;
    if (buf.byteLength > ANTHROPIC_PER_DOC_LIMIT) {
      // Single PDF exceeds Anthropic's per-document limit. Fall back to
      // pdf-parse text extraction and ship as a text source instead.
      const parsed = await parseFile(buf, "application/pdf", att.name);
      if (parsed.text && parsed.text.length > 30) {
        otherSources.push({
          label: att.name,
          text: `=== ${att.name} (large PDF, text-extracted) ===\n${parsed.text}`,
        });
        filesRead++;
        textFallbackCount++;
      }
      continue;
    }
    pdfDocuments.push({
      name: att.name,
      base64: Buffer.from(buf).toString("base64"),
      bytes: buf.byteLength,
    });
    filesRead++;
  }
  const totalQueuedBytes = pdfDocuments.reduce((s, p) => s + p.bytes, 0);
  console.log(
    `[refreshSpecs] product ${input.productId}: fetched ${pdfDocuments.length} PDF(s) (${(totalQueuedBytes / 1024 / 1024).toFixed(1)} MB) in ${Date.now() - t0}ms`,
  );

  // 2. Source page — only fetched when we have NO PDFs. With PDFs already in
  //    hand, the source page is redundant noise and re-fetching iGuzzini-style
  //    SPA pages with renderPageHtml costs another 10-20s per product.
  let sourcePageText = "";
  if (pdfDocuments.length === 0 && otherSources.length === 0 && row.sourceUrl) {
    try {
      const r = await fetchUrlFully(row.sourceUrl);
      let text = r.text;
      if (!text || text.length < 200) {
        try {
          const rendered = await renderPageHtml(row.sourceUrl, {
            waitUntil: "networkidle",
            timeoutMs: 20_000,
            blockResources: true,
            scrollPasses: 2,
            clickToReveal: true,
          });
          if (rendered.html) {
            text = rendered.html
              .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
              .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
              .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
              .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 40_000);
          }
        } catch {
          // ignore — we'll still surface the right error below
        }
      }
      if (text) sourcePageText = text;
    } catch (e) {
      console.warn("[refreshSpecs] source page fetch failed", row.sourceUrl, e);
    }
  }
  if (textFallbackCount > 0) {
    console.log(
      `[refreshSpecs] product ${input.productId}: ${textFallbackCount} oversized PDF(s) used text-fallback`,
    );
  }

  if (pdfDocuments.length === 0 && otherSources.length === 0 && !sourcePageText) {
    if (atts.length === 0 && !row.sourceUrl) {
      throw new Error(
        "Nothing to analyze: this product has no attached PDFs and no source URL. Attach a spec PDF or set a source URL via Edit, then click Refresh again.",
      );
    }
    const pdfCount = atts.filter(
      (a) =>
        (a.mimeType ?? "").toLowerCase() === "application/pdf" ||
        /\.pdf(\?|$)/i.test(a.name),
    ).length;
    if (pdfCount === 0) {
      throw new Error(
        `Nothing to analyze: ${atts.length} file(s) attached but none are PDFs. Only PDF spec sheets are read by Claude — non-PDF files (IES, DWG, xlsx) are skipped. Attach the PDF spec sheet directly.`,
      );
    }
    throw new Error(
      `Nothing to analyze: ${pdfCount} PDF(s) attached but every fetch failed${row.sourceUrl ? ` and ${row.sourceUrl} didn't return readable text` : " and no source URL is set"}.`,
    );
  }

  // 3. Run AI extraction. Prefer Claude (native PDF reading); fall back to
  //    OpenAI text-only when no Anthropic key is set. Wrap errors so the
  //    client sees the actual API message instead of a generic "failed".
  let parsed: SpecsOnlyExtraction;
  try {
    if (hasClaudeKey()) {
      const totalBytes = pdfDocuments.reduce((s, p) => s + p.bytes, 0);
      console.log(
        `[refreshSpecs] product ${input.productId}: invoking Claude (${CLAUDE_MODEL}) with ${pdfDocuments.length} PDF(s) (${(totalBytes / 1024 / 1024).toFixed(1)} MB) + ${otherSources.length} text source(s) + page-text=${sourcePageText.length}B`,
      );
      parsed = await analyzeProductWithClaude({
        productName: row.name,
        productCode: row.productCode,
        sourceUrl: row.sourceUrl,
        sourcePageText,
        pdfDocuments,
        otherSources,
      });
      console.log(
        `[refreshSpecs] Claude returned: description=${parsed.description?.length ?? 0} chars, specs keys=${Object.keys(parsed.specs ?? {}).length}`,
      );
    } else {
      console.log(
        `[refreshSpecs] product ${input.productId}: ANTHROPIC_API_KEY not set, falling back to OpenAI text-only (${pdfDocuments.length} PDFs unread, ${otherSources.length} text sources)`,
      );
      parsed = await analyzeProductWithOpenAI({
        productName: row.name,
        productCode: row.productCode,
        sourcePageText,
        pdfDocuments,
        otherSources,
      });
    }
  } catch (e) {
    // Anthropic / OpenAI SDK errors carry the API status + body. Surface that
    // to the toast so the user can see what's wrong (rate limit, bad PDF,
    // invalid key, …) instead of a generic "Refresh failed".
    console.error("[refreshSpecs] AI call failed:", e);
    const provider = hasClaudeKey() ? "Claude" : "OpenAI";
    if (e && typeof e === "object" && "status" in e) {
      const err = e as {
        status: number;
        message?: string;
        error?: { error?: { message?: string }; message?: string };
      };
      // Anthropic SDK puts the structured body under .error.error.message.
      const body =
        err.error?.error?.message ??
        err.error?.message ??
        err.message ??
        "(no body)";
      throw new Error(`${provider} ${err.status}: ${body}`);
    }
    if (e instanceof Error) {
      throw new Error(`${provider}: ${e.message}`);
    }
    throw new Error(`${provider} call failed`);
  }

  // 4. Merge: keep existing values when the AI returns empty, overwrite when
  //    it found something. Count fields that changed for the toast message.
  const existing = (row.specs ?? {}) as Record<string, string | string[]>;
  const merged: Record<string, string | string[]> = { ...existing };
  let fieldsUpdated = 0;
  for (const [k, v] of Object.entries(parsed.specs)) {
    if (Array.isArray(v)) {
      if (v.length > 0) {
        merged[k] = v;
        const before = JSON.stringify(existing[k] ?? []);
        const after = JSON.stringify(v);
        if (before !== after) fieldsUpdated++;
      }
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) {
        merged[k] = t;
        if ((existing[k] ?? "") !== t) fieldsUpdated++;
      }
    }
  }
  // If existing description is short / empty, prefer the AI's. Otherwise keep
  // user-curated text.
  const newDescription =
    parsed.description?.trim() &&
    (!row.description || row.description.length < 40)
      ? parsed.description.trim()
      : row.description ?? null;

  await db
    .update(competitorProducts)
    .set({
      specs: merged,
      description: newDescription,
      updatedAt: new Date(),
    })
    .where(eq(competitorProducts.id, input.productId));

  revalidatePath("/competitors");
  return {
    productId: input.productId,
    productName: row.name,
    filesRead,
    fieldsUpdated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK REFRESH — every product in a collection that has files attached
// ─────────────────────────────────────────────────────────────────────────────
//
// Use case: user already extracted files for many products before Claude was
// wired up (or before adding ANTHROPIC_API_KEY). Hitting this once re-runs
// the spec analysis for every product in the active collection that has
// attached PDFs / docs, in a controlled-concurrency loop so we don't hammer
// the Anthropic / OpenAI API.

export type BulkRefreshResult = {
  productsScanned: number;
  productsRefreshed: number;
  totalFilesRead: number;
  totalFieldsUpdated: number;
  errors: Array<{ productId: number; productName: string; error: string }>;
};

export async function aiRefreshAllProductSpecs(input: {
  collectionId: number;
}): Promise<BulkRefreshResult> {
  await requireCompetitorEditor();

  // Find every product in the collection that has at least one non-image
  // attachment — those are the ones spec analysis can act on.
  const brandsInCollection = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.collectionId, input.collectionId));
  const brandIds = brandsInCollection.map((b) => b.id);
  if (brandIds.length === 0) {
    return {
      productsScanned: 0,
      productsRefreshed: 0,
      totalFilesRead: 0,
      totalFieldsUpdated: 0,
      errors: [],
    };
  }

  const products = await db
    .select({ id: competitorProducts.id, name: competitorProducts.name })
    .from(competitorProducts)
    .where(
      sql`${competitorProducts.competitorId} IN (${sql.join(brandIds.map((b) => sql`${b}`), sql`, `)})`,
    );

  // Filter to products that have a non-image attachment.
  const productIds = products.map((p) => p.id);
  if (productIds.length === 0) {
    return {
      productsScanned: 0,
      productsRefreshed: 0,
      totalFilesRead: 0,
      totalFieldsUpdated: 0,
      errors: [],
    };
  }
  const attsRows = await db
    .select({
      productId: competitorProductAttachments.productId,
      mimeType: competitorProductAttachments.mimeType,
      name: competitorProductAttachments.name,
    })
    .from(competitorProductAttachments)
    .where(
      sql`${competitorProductAttachments.productId} IN (${sql.join(productIds.map((p) => sql`${p}`), sql`, `)})`,
    );
  const productHasFile = new Set<number>();
  for (const a of attsRows) {
    const m = (a.mimeType ?? "").toLowerCase();
    const isImageOnly = m.startsWith("image/");
    if (!isImageOnly) productHasFile.add(a.productId);
  }
  const queue = products.filter((p) => productHasFile.has(p.id));

  const result: BulkRefreshResult = {
    productsScanned: queue.length,
    productsRefreshed: 0,
    totalFilesRead: 0,
    totalFieldsUpdated: 0,
    errors: [],
  };

  // Concurrency-3: Claude vision-document calls are heavy, but the user is
  // typically refreshing 10-50 products. Three in flight gives a good
  // throughput-vs-rate-limit balance.
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const p = queue[idx];
      if (!p) return;
      try {
        const r = await refreshProductSpecsFromFiles({ productId: p.id });
        result.productsRefreshed++;
        result.totalFilesRead += r.filesRead;
        result.totalFieldsUpdated += r.fieldsUpdated;
      } catch (e) {
        result.errors.push({
          productId: p.id,
          productName: p.name,
          error: e instanceof Error ? e.message : "refresh failed",
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  revalidatePath("/competitors");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ADAPTERS used by refreshProductSpecsFromFiles
// ─────────────────────────────────────────────────────────────────────────────

type AnalyzerInput = {
  productName: string;
  productCode: string | null;
  sourceUrl?: string | null;
  sourcePageText: string;
  pdfDocuments: Array<{ name: string; base64: string; bytes: number }>;
  otherSources: ParsedSource[];
};

/**
 * Claude-based extractor — sends PDFs as native document content blocks so
 * the model reads tables and dimensional drawings directly. Uses tool_use
 * with our SPECS_ONLY_SCHEMA for guaranteed structured output.
 */
// Anthropic's API rejects total request body > ~32MB. Per-batch budget keeps
// the encoded payload (base64 = 1.33× binary, plus JSON overhead + system
// prompt) safely under the limit while still letting us pack 4-5 typical
// spec sheets per call.
const ANTHROPIC_BATCH_BUDGET = 22 * 1024 * 1024; // 22 MB binary

/**
 * Pack PDFs into batches, each ≤ ANTHROPIC_BATCH_BUDGET binary. Greedy
 * first-fit ordering preserves the spec-sheet-first sort the caller did,
 * so the highest-value PDFs land in the first batch.
 */
function batchPdfs<T extends { bytes: number }>(pdfs: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const pdf of pdfs) {
    if (currentBytes + pdf.bytes > ANTHROPIC_BATCH_BUDGET && current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(pdf);
    currentBytes += pdf.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Merge two extractions: prefer non-empty values, union arrays. Used to
 * fold per-batch results into a single accumulated record across multiple
 * Claude calls.
 */
function mergeExtractions(
  acc: SpecsOnlyExtraction,
  next: SpecsOnlyExtraction,
): SpecsOnlyExtraction {
  const mergedSpecs: Record<string, string | string[]> = { ...acc.specs };
  for (const [k, v] of Object.entries(next.specs ?? {})) {
    if (Array.isArray(v)) {
      const prev = Array.isArray(mergedSpecs[k]) ? (mergedSpecs[k] as string[]) : [];
      const union = [...new Set([...prev, ...v.filter(Boolean)])];
      if (union.length > 0) mergedSpecs[k] = union;
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) {
        const existing = (mergedSpecs[k] ?? "").toString().trim();
        // Keep first non-empty value; if both have values, keep the longer
        // one (often the more detailed one with all variants listed).
        if (!existing || t.length > existing.length) mergedSpecs[k] = t;
      }
    }
  }
  return {
    description:
      (next.description?.trim().length ?? 0) > (acc.description?.trim().length ?? 0)
        ? next.description
        : acc.description,
    specs: mergedSpecs,
  };
}

/**
 * Call client.messages.create with the configured model; if Anthropic
 * returns a "model not found" / "permission" / "invalid model" error,
 * retry with each fallback model in turn until one succeeds.
 *
 * Caches the first working model in module memory so subsequent batches
 * (and subsequent products in a bulk re-analyze) skip straight to it
 * instead of paying the round-trip to discover Opus 4.7 isn't available.
 */
let _resolvedClaudeModel: string | null = null;

async function callClaudeWithFallback(
  client: ReturnType<typeof claudeClient>,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
): Promise<Anthropic.Message> {
  const primary = _resolvedClaudeModel ?? CLAUDE_MODEL;
  const candidates = [primary, ...CLAUDE_FALLBACK_MODELS].filter(
    (m, i, a) => a.indexOf(m) === i, // dedupe
  );
  let lastErr: unknown = null;
  for (const model of candidates) {
    try {
      const res = await client.messages.create({ ...params, model });
      // First success — cache for this process so we don't retry the
      // failing primary on every subsequent batch / product.
      if (model !== _resolvedClaudeModel) {
        if (_resolvedClaudeModel === null && model !== CLAUDE_MODEL) {
          console.log(
            `[refreshSpecs] caching working model "${model}" for the rest of this process (configured ${CLAUDE_MODEL} unavailable)`,
          );
        }
        _resolvedClaudeModel = model;
      }
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      // Strict match: "model: X not found", "no such model", "permission",
      // "not available". Don't match generic "invalid_request_error" — that
      // covers parameter problems (e.g. temperature) which are bugs in OUR
      // request, not model-availability problems.
      const isModelError =
        /(model[:\s][^,]*(not found|does not exist|not available)|no such model|you don[''’]t have (access|permission)|invalid model)/i.test(
          msg,
        );
      if (isModelError) {
        console.warn(
          `[refreshSpecs] model ${model} unavailable (${(e as Error).message}); falling back…`,
        );
        lastErr = e;
        continue;
      }
      // Any other error (rate limit, bad input, network) — propagate.
      throw e;
    }
  }
  throw new Error(
    `No accessible Claude model (tried ${candidates.join(", ")}). Last error: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

async function analyzeProductWithClaude(
  input: AnalyzerInput,
): Promise<SpecsOnlyExtraction> {
  // Guard early — Claude rejects empty content with a 400.
  if (
    input.pdfDocuments.length === 0 &&
    input.otherSources.length === 0 &&
    input.sourcePageText.length < 30
  ) {
    throw new Error(
      "Nothing to analyze. Attach a spec PDF or set a working source URL.",
    );
  }

  const client = claudeClient();
  const intro = `Product: ${input.productName}${input.productCode ? ` (${input.productCode})` : ""}${input.sourceUrl ? `\nSource page: ${input.sourceUrl}` : ""}`;

  // Split PDFs into batches that fit Anthropic's per-request size budget.
  // Source page text + non-PDF sources (text-extracted oversized PDFs) ride
  // along on the FIRST batch only — they're tiny relative to PDFs and we
  // don't want to pay for them N times.
  const batches = input.pdfDocuments.length > 0
    ? batchPdfs(input.pdfDocuments)
    : [[]]; // one empty batch so text-only path still runs

  console.log(
    `[refreshSpecs] Claude call: ${batches.length} batch(es) for ${input.pdfDocuments.length} PDF(s) (${(input.pdfDocuments.reduce((s, p) => s + p.bytes, 0) / 1024 / 1024).toFixed(1)} MB total binary)`,
  );

  let accumulated: SpecsOnlyExtraction | null = null;
  const errors: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchBytes = batch.reduce((s, p) => s + p.bytes, 0);
    const isFirst = i === 0;
    const batchStart = Date.now();

    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "text",
        text: `${intro}\n\nThis is batch ${i + 1} of ${batches.length} — ${batch.length} PDF(s) (${(batchBytes / 1024 / 1024).toFixed(1)} MB).`,
      },
    ];
    for (const pdf of batch) {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: pdf.base64,
        },
        title: pdf.name,
      });
    }
    // Source page + text-extracted oversized PDFs ride only on batch 1.
    if (isFirst) {
      if (input.sourcePageText) {
        content.push({
          type: "text",
          text: `=== Product page text ===\n${input.sourcePageText}`,
        });
      }
      for (const s of input.otherSources) {
        content.push({ type: "text", text: s.text });
      }
    }

    try {
      // NOTE: no `temperature` — Claude Opus 4.7 deprecated that parameter
      // and rejects requests that include it. The default sampling is fine
      // since strict tool_use already constrains output to our schema.
      const res = await callClaudeWithFallback(client, {
        max_tokens: 8192,
        system: SPEC_REFRESH_SYSTEM_PROMPT,
        tools: [
          {
            name: "record_product_specs",
            description:
              "Record the extracted product specs and a 1-2 sentence description.",
            input_schema: SPECS_ONLY_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "record_product_specs" },
        messages: [{ role: "user", content }],
      });
      let parsed: SpecsOnlyExtraction | null = null;
      for (const block of res.content) {
        if (block.type === "tool_use" && block.name === "record_product_specs") {
          parsed = block.input as SpecsOnlyExtraction;
          break;
        }
      }
      if (!parsed) {
        const textBlocks = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .slice(0, 200);
        errors.push(
          `batch ${i + 1}: no tool_use (stop_reason=${res.stop_reason})${textBlocks ? ` — ${textBlocks}` : ""}`,
        );
        continue;
      }
      const t1 = Date.now();
      console.log(
        `[refreshSpecs] batch ${i + 1}/${batches.length}: ${batch.length} PDFs → ${Object.keys(parsed.specs ?? {}).length} spec keys (${t1 - batchStart}ms)`,
      );
      accumulated = accumulated
        ? mergeExtractions(accumulated, parsed)
        : parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error(`[refreshSpecs] batch ${i + 1}/${batches.length} failed:`, e);
      errors.push(`batch ${i + 1}: ${msg}`);
    }
  }

  if (!accumulated) {
    throw new Error(
      `All ${batches.length} Claude batch(es) failed. ${errors.join("; ")}`,
    );
  }
  if (errors.length > 0) {
    console.warn(
      `[refreshSpecs] partial success: ${batches.length - errors.length}/${batches.length} batches succeeded. Errors:`,
      errors,
    );
  }
  return accumulated;
}

/**
 * OpenAI fallback when ANTHROPIC_API_KEY isn't set. Text-only — PDFs in this
 * path were already captured as base64 but OpenAI's chat.completions can't
 * read them natively, so the user should set the Anthropic key for full
 * fidelity. This branch keeps the system functional in dev environments
 * without an Anthropic account.
 */
async function analyzeProductWithOpenAI(
  input: AnalyzerInput,
): Promise<SpecsOnlyExtraction> {
  const intro = `Product: ${input.productName}${input.productCode ? ` (${input.productCode})` : ""}`;
  const sources: string[] = [];
  if (input.sourcePageText) {
    sources.push(`=== Product page ===\n${input.sourcePageText}`);
  }
  for (const s of input.otherSources) sources.push(s.text);
  if (input.pdfDocuments.length > 0) {
    sources.push(
      `=== ${input.pdfDocuments.length} PDF spec sheet(s) attached but not readable in this fallback path. Set ANTHROPIC_API_KEY to enable native PDF analysis. ===`,
    );
  }

  const messageParts: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `${intro}\n\n${sources.join("\n\n")}`,
    },
  ];

  const client = openaiClient();
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: SPEC_REFRESH_SYSTEM_PROMPT },
      { role: "user", content: messageParts },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "specs_refresh_extraction",
        strict: true,
        schema: SPECS_ONLY_SCHEMA,
      },
    },
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned no content");
  return JSON.parse(raw) as SpecsOnlyExtraction;
}
