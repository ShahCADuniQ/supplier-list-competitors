import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { AI_MODEL, openaiClient } from "./openai";
import { fetchUrlAsText, parseFile, type ParsedSource } from "./parsers";

const CATEGORIES = [
  "Acoustics", "Agency", "Agriculture/Tech", "Building Materials",
  "Buy/Sell Distribution", "Design Services", "Digital Services", "Distribution",
  "Drivers/Power", "Electrical", "Electronics", "Equipment", "Exhibition/Display",
  "Flooring", "Furniture", "Hardware", "LED/Components", "LED/Lighting",
  "Logistics/Freight", "Manufacturing", "Manufacturing / Logistics", "Materials",
  "Optics", "Sealing/Thermal", "Services", "Software",
];
const ORIGINS = [
  "Australia", "Austria", "Canada", "Canada/China", "China", "Finland",
  "Germany", "Global", "Indonesia", "Japan", "N/A", "Taiwan", "USA", "Vietnam",
];
const ATTACHMENT_CATEGORIES = [
  "specs", "quotes", "contracts", "certs", "tests",
  "catalogs", "invoices", "comms", "media", "other",
];
const COMPETITOR_TIERS = ["mass", "mid", "spec", "premium"] as const;
const CAPABILITIES = [
  "Utility Strip/Shop", "Wraparound", "Vapor-Tight (IP65+)", "Linear High-Bay",
  "Recessed Troffer", "Architectural Recessed Slot",
  "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect",
  "Wall-Wash / Asymmetric",
  "LED Tape / Cove", "Aluminum Extrusion + Tape", "Stair / Step Integrated",
  "Under-Cabinet", "T5/T8 Retrofit", "LED Batten",
  "RGB / Color", "Tunable White / Smart", "Custom / Bespoke",
];

export type SourceFile = { buffer: Buffer | Uint8Array; mime: string; name: string };
export type SourceInput = { files?: SourceFile[]; url?: string };

async function buildContext(input: SourceInput): Promise<ParsedSource[]> {
  const sources: ParsedSource[] = [];
  if (input.url) {
    try {
      const text = await fetchUrlAsText(input.url);
      sources.push({ label: input.url, text: `URL CONTENT (${input.url}):\n${text}` });
    } catch (e) {
      sources.push({
        label: input.url,
        text: `[Could not fetch ${input.url}: ${e instanceof Error ? e.message : "error"}]`,
      });
    }
  }
  for (const file of input.files ?? []) {
    sources.push(await parseFile(file.buffer, file.mime, file.name));
  }
  return sources;
}

/** Build the OpenAI message content array, including any vision images. */
function buildUserContent(sources: ParsedSource[]): ChatCompletionContentPart[] {
  const text = sources
    .map((s) => `=== ${s.label} ===\n${s.text}`)
    .join("\n\n");
  const parts: ChatCompletionContentPart[] = [
    { type: "text", text: text || "[no usable input]" },
  ];
  for (const s of sources) {
    if (s.imageDataUrl) {
      parts.push({ type: "image_url", image_url: { url: s.imageDataUrl } });
    }
  }
  return parts;
}

async function callJsonSchema<T>(opts: {
  systemPrompt: string;
  userContent: ChatCompletionContentPart[];
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  const client = openaiClient();
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from OpenAI");
  return JSON.parse(raw) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierExtraction = {
  name: string;
  category: string;
  subCategory: string;
  origin: string;
  status: "Active" | "Historical";
  website: string;
  email: string;
  phone: string;
  contactName: string;
  products: string;
  notes: string;
  fileCategorizations: { filename: string; attachmentCategory: string }[];
};

const SUPPLIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Company/supplier name. Required." },
    category: { type: "string", enum: CATEGORIES },
    subCategory: { type: "string" },
    origin: { type: "string", enum: ORIGINS },
    status: { type: "string", enum: ["Active", "Historical"] },
    website: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    contactName: { type: "string" },
    products: {
      type: "string",
      description: "Comma-separated list of products/services this supplier provides.",
    },
    notes: {
      type: "string",
      description: "1-3 sentence summary of specialties or notable points.",
    },
    fileCategorizations: {
      type: "array",
      description: "For each input filename, which attachment category it should land under.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          filename: { type: "string" },
          attachmentCategory: { type: "string", enum: ATTACHMENT_CATEGORIES },
        },
        required: ["filename", "attachmentCategory"],
      },
    },
  },
  required: [
    "name", "category", "subCategory", "origin", "status",
    "website", "email", "phone", "contactName", "products", "notes",
    "fileCategorizations",
  ],
};

const SUPPLIER_PROMPT = `You are extracting structured supplier-master data for a lighting hardware company called Lightbase. Read the attached documents and/or website content and infer the supplier's profile.

Rules:
- "name" is required. If genuinely unknown, return your best guess.
- Pick "category" from the enum exactly. Default to "Manufacturing" only if nothing else fits.
- Pick "origin" from the enum exactly. Use "N/A" if undetermined.
- "status" is "Active" unless the source clearly says retired/historical.
- Use empty strings for unknown contact fields rather than guessing fake values.
- "products" should be a concise comma-separated list (≤200 chars).
- "notes" should summarize specialties, certifications, capabilities (≤300 chars).
- For each input filename, classify into one of these attachment categories:
  specs (datasheets/drawings), quotes (price lists/RFQ responses), contracts (NDAs/MSAs),
  certs (CE/UL/ISO etc.), tests (LM-80/IES/photometric), catalogs (marketing/brochures),
  invoices (POs/payments), comms (emails/letters), media (photos/factory tours), other.
  If only a URL was given, return an empty list for fileCategorizations.`;

export async function extractSupplier(input: SourceInput): Promise<SupplierExtraction> {
  const sources = await buildContext(input);
  const result = await callJsonSchema<SupplierExtraction>({
    systemPrompt: SUPPLIER_PROMPT,
    userContent: buildUserContent(sources),
    schemaName: "supplier_extraction",
    schema: SUPPLIER_SCHEMA,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT ENTRY (PO) EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectEntryExtraction = {
  projectNum: string;
  poNumber: string;
  status: "Quoted" | "PO Issued" | "In Production" | "Shipped" | "Delivered" | "Closed" | "Cancelled";
  quoteDate: string;
  poDate: string;
  expectedDelivery: string;
  actualDelivery: string;
  orderedQuantity: number;
  deliveredQuantity: number;
  defectiveQuantity: number;
  returnedQuantity: number;
  quotedAmount: number;
  actualAmount: number;
  currency: string;
  incoterms: string;
  paymentTerms: string;
  notes: string;
};

const PROJECT_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectNum: {
      type: "string",
      description: "Internal project number Lightbase uses to tag POs (often a 4-digit code or short string). REQUIRED.",
    },
    poNumber: { type: "string", description: "External PO/order reference like PO-2026-031." },
    status: {
      type: "string",
      enum: ["Quoted", "PO Issued", "In Production", "Shipped", "Delivered", "Closed", "Cancelled"],
    },
    quoteDate: { type: "string", description: "ISO YYYY-MM-DD or empty string." },
    poDate: { type: "string", description: "ISO YYYY-MM-DD or empty string." },
    expectedDelivery: { type: "string", description: "ISO YYYY-MM-DD or empty string." },
    actualDelivery: { type: "string", description: "ISO YYYY-MM-DD or empty string." },
    orderedQuantity: { type: "number" },
    deliveredQuantity: { type: "number" },
    defectiveQuantity: { type: "number" },
    returnedQuantity: { type: "number" },
    quotedAmount: { type: "number" },
    actualAmount: { type: "number" },
    currency: { type: "string", enum: ["USD", "CAD", "EUR", "CNY", "JPY", "GBP", ""] },
    incoterms: { type: "string", enum: ["EXW", "FOB", "FCA", "CIF", "CFR", "CIP", "DAP", "DDP", ""] },
    paymentTerms: { type: "string" },
    notes: { type: "string" },
  },
  required: [
    "projectNum", "poNumber", "status",
    "quoteDate", "poDate", "expectedDelivery", "actualDelivery",
    "orderedQuantity", "deliveredQuantity", "defectiveQuantity", "returnedQuantity",
    "quotedAmount", "actualAmount", "currency", "incoterms", "paymentTerms", "notes",
  ],
};

const PROJECT_ENTRY_PROMPT = `You are extracting purchase-order data from supplier documents (POs, invoices, sales orders, or pro-forma invoices). Lightbase tracks each PO as a "project entry" linked to an internal project number.

Rules:
- Read every page carefully. Quantities, prices, and dates are the most important fields — get them right.
- "projectNum" is the internal Lightbase project tag if visible (e.g. "1267"). If not present, return the PO number, or empty if neither.
- Dates must be ISO format (YYYY-MM-DD). If a date is missing, return an empty string — don't invent dates.
- Numeric fields (quantity, amounts) default to 0 when unknown.
- "status": pick the best fit. A PO with shipping confirmation → "Shipped". A delivery note → "Delivered". A signed PO with no delivery → "PO Issued". A quote → "Quoted".
- "actualAmount" should match the line-total/grand-total on the document. "quotedAmount" is the original quote if visible, else same as actual.
- Keep "notes" short — 1 sentence on anything unusual (rush, partial shipment, defects, etc.).`;

export async function extractProjectEntry(file: SourceFile): Promise<ProjectEntryExtraction> {
  const sources = await buildContext({ files: [file] });
  return callJsonSchema<ProjectEntryExtraction>({
    systemPrompt: PROJECT_ENTRY_PROMPT,
    userContent: buildUserContent(sources),
    schemaName: "project_entry_extraction",
    schema: PROJECT_ENTRY_SCHEMA,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITOR EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

export type CompetitorProductExtraction = {
  name: string;
  productCode: string;
  productCategory: string;
  description: string;
  imageUrls: string[];
  sourceUrl: string;
  specs: {
    dimensions: string;
    colors: string[];
    finishes: string[];
    certifications: string[];
    cct: string;
    lumens: string;
    wattage: string;
    cri: string;
    beamAngle: string;
    voltage: string;
    ipRating: string;
    notes: string;
  };
};

export type CompetitorExtraction = {
  name: string;
  website: string;
  parent: string;
  tierKey: typeof COMPETITOR_TIERS[number];
  tier: string;
  segment: string;
  country: string;
  productLines: string;
  channel: string;
  notes: string;
  capabilities: string[];
  products: CompetitorProductExtraction[];
};

const PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Product name as the brand uses it (e.g. 'Slot 4', 'Define', 'BLT-200W')." },
    productCode: { type: "string", description: "SKU / model code if present, else empty." },
    productCategory: { type: "string", description: "Short category like 'Linear Pendant', 'Recessed Slot', 'High-Bay'." },
    description: { type: "string", description: "1-2 sentence summary." },
    imageUrls: {
      type: "array",
      items: { type: "string" },
      description: "Absolute URLs to product photos (only when extracting from a website with visible images).",
    },
    sourceUrl: { type: "string", description: "Direct link to the product page if known, else empty." },
    specs: {
      type: "object",
      additionalProperties: false,
      properties: {
        dimensions: { type: "string", description: "Free-form, include units. e.g. '1200×25×25 mm', '4 ft', '2x4'." },
        colors: { type: "array", items: { type: "string" }, description: "Available housing/finish colors. e.g. 'White', 'Black', 'Bronze'." },
        finishes: { type: "array", items: { type: "string" }, description: "Material/finish options. e.g. 'Anodized aluminum', 'Powder coat'." },
        certifications: { type: "array", items: { type: "string" }, description: "e.g. 'UL', 'DLC', 'CE', 'IP65', 'cULus'." },
        cct: { type: "string", description: "Color temperature options. e.g. '3000K, 3500K, 4000K' or 'Tunable 2700-6500K'." },
        lumens: { type: "string", description: "Lumen output range." },
        wattage: { type: "string", description: "Wattage options." },
        cri: { type: "string", description: "Color rendering index. e.g. 'CRI 90+'." },
        beamAngle: { type: "string", description: "Beam angle if applicable." },
        voltage: { type: "string", description: "Input voltage. e.g. '120-277V'." },
        ipRating: { type: "string", description: "IP rating if listed." },
        notes: { type: "string", description: "Anything else worth recording (driver type, dimming protocol, mounting, etc.)." },
      },
      required: ["dimensions", "colors", "finishes", "certifications", "cct", "lumens", "wattage", "cri", "beamAngle", "voltage", "ipRating", "notes"],
    },
  },
  required: ["name", "productCode", "productCategory", "description", "imageUrls", "sourceUrl", "specs"],
};

const COMPETITOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    website: { type: "string" },
    parent: { type: "string", description: "Parent company / owner. 'Private' if independent." },
    tierKey: { type: "string", enum: [...COMPETITOR_TIERS] },
    tier: { type: "string", description: "Free-form short tier description." },
    segment: { type: "string" },
    country: { type: "string" },
    productLines: { type: "string", description: "Comma-separated product line names." },
    channel: { type: "string", description: "Sales channel: distributor, agency, online, retail, etc." },
    notes: { type: "string", description: "1-3 sentence positioning summary." },
    capabilities: {
      type: "array",
      items: { type: "string", enum: CAPABILITIES },
      description: "Subset of the canonical capability list this brand offers.",
    },
    products: {
      type: "array",
      description: "Up to 25 individual products/SKUs the brand sells. Empty array if the source contains no product details.",
      items: PRODUCT_SCHEMA,
    },
  },
  required: [
    "name", "website", "parent", "tierKey", "tier", "segment", "country",
    "productLines", "channel", "notes", "capabilities", "products",
  ],
};

const COMPETITOR_PROMPT = `You are extracting structured competitor-intelligence data for Lightbase, a linear-lighting manufacturer. Read the input documents and/or website content and infer the competitor's profile AND a catalog of their individual products.

Rules for the brand profile:
- "name" is the brand name (not the parent — that goes in "parent").
- "tierKey" picks the broad market segment exactly:
    mass    → Big-box / Amazon / value commodity (Hyperikon, Sunco, Feit)
    mid     → Mid-tier commercial / mass spec (RAB, MaxLite, Signify)
    spec    → Architectural / agency-channel (Lithonia, Cooper, Cree, Axis, XAL)
    premium → Premium / tape / decorative (WAC, Diode LED, Tech Lighting)
- "tier" is a free-form short label like "Architectural spec" or "Mass / value".
- "country" should include the city if known, e.g. "USA (NY)".
- "capabilities": pick ONLY from the canonical list. If unclear, leave empty.
- Use empty strings for unknown text fields.

Rules for "products":
- Return at MOST 25 distinct products. Pick the most representative ones.
- Each product is a real SKU or named product line (e.g. "Slot 4", "BLT-200W", "Define").
- "imageUrls" must be ABSOLUTE URLs to product images visible in the source. Skip if absent — never invent URLs.
- "sourceUrl" is the canonical product page URL if you can identify one.
- "specs.dimensions" should include units. If only some specs are given, fill those and leave the rest as empty strings/arrays.
- "specs.colors" / "finishes" / "certifications" are arrays — list every option mentioned, deduped.
- Be precise: do not guess a wattage or lumen number that isn't in the source.
- If the input clearly isn't a catalog (e.g. a corporate-overview page), return an empty products array.`;

export async function extractCompetitor(input: SourceInput): Promise<CompetitorExtraction> {
  const sources = await buildContext(input);
  return callJsonSchema<CompetitorExtraction>({
    systemPrompt: COMPETITOR_PROMPT,
    userContent: buildUserContent(sources),
    schemaName: "competitor_extraction",
    schema: COMPETITOR_SCHEMA,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REFINE — update an existing record from new sources, only set fields where
// new info exists. Returns the same shape as the extractor.
// ─────────────────────────────────────────────────────────────────────────────

const REFINE_SUPPLIER_PROMPT = `You are refining an EXISTING supplier record using new documents and/or website content provided by the user.

Rules:
- For each field, return the CURRENT value unchanged unless the new sources clearly contain better/more accurate information.
- Never blank out a field that already has a value unless the new sources contradict it.
- Improve "notes" by appending or replacing only when meaningfully better information is found.
- For "fileCategorizations", classify ONLY the new files listed in the sources. Files already attached are not re-uploaded.
- All other rules from the extraction system prompt apply.`;

export async function refineSupplier(
  current: Partial<SupplierExtraction>,
  input: SourceInput,
): Promise<SupplierExtraction> {
  const sources = await buildContext(input);
  const currentJson = `=== CURRENT SUPPLIER (do not erase, only refine) ===\n${JSON.stringify(current, null, 2)}`;
  const userContent = buildUserContent([
    { label: "current-record.json", text: currentJson },
    ...sources,
  ]);
  return callJsonSchema<SupplierExtraction>({
    systemPrompt: REFINE_SUPPLIER_PROMPT,
    userContent,
    schemaName: "supplier_refinement",
    schema: SUPPLIER_SCHEMA,
  });
}

const REFINE_COMPETITOR_PROMPT = `You are refining an EXISTING competitor record using new documents and/or website content provided by the user.

Rules:
- For each field, return the CURRENT value unchanged unless the new sources clearly contain better/more accurate information.
- Never blank out a field that already has a value unless the new sources contradict it.
- "capabilities" should be the union of existing + newly evidenced capabilities (still picked from the canonical list only).
- "products": return ONLY products newly evidenced in the latest sources. The system will merge them with the existing catalog by name — duplicates are de-duplicated automatically. If the new sources contain no new products, return an empty array.
- All other rules from the competitor extraction prompt apply.`;

export async function refineCompetitor(
  current: Partial<CompetitorExtraction>,
  input: SourceInput,
): Promise<CompetitorExtraction> {
  const sources = await buildContext(input);
  const currentJson = `=== CURRENT COMPETITOR (do not erase, only refine) ===\n${JSON.stringify(current, null, 2)}`;
  const userContent = buildUserContent([
    { label: "current-record.json", text: currentJson },
    ...sources,
  ]);
  return callJsonSchema<CompetitorExtraction>({
    systemPrompt: REFINE_COMPETITOR_PROMPT,
    userContent,
    schemaName: "competitor_refinement",
    schema: COMPETITOR_SCHEMA,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB SEARCH — uses OpenAI's Responses API + web_search tool to look up
// real-time supplier info (website, manufacturing capabilities, materials).
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierWebResearch = {
  website: string;        // best-guess official URL ("" if unknown)
  manufacturingTypes: string[];
  materials: string[];
  notes: string;          // 1-3 sentence summary of what was found
  sources: string[];      // URLs the model relied on
};

const WEB_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    website: { type: "string" },
    manufacturingTypes: {
      type: "array",
      items: { type: "string" },
      description: "e.g. CNC machining, sheet-metal fabrication, injection molding, laser cutting, die casting, anodizing, powder coating",
    },
    materials: {
      type: "array",
      items: { type: "string" },
      description: "e.g. aluminum 6061, stainless steel 304, ABS, PCB FR4",
    },
    notes: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["website", "manufacturingTypes", "materials", "notes", "sources"],
};

const WEB_RESEARCH_PROMPT = `You are researching a Lightbase supplier on the live web. Use the web_search tool to find their official website and gather manufacturing capabilities (machining, fabrication, finishing processes) and the materials they typically work with.

Output rules:
- "website" = the canonical company URL. Empty string if you can't confirm one.
- "manufacturingTypes" = de-duplicated list of capabilities (lowercase or title-case is fine, but be consistent — "CNC machining", "Sheet metal fabrication", "Anodizing", etc.). Empty array if not a manufacturer or unknown.
- "materials" = the materials they actually process (e.g. "Aluminum 6061", "Stainless 304", "ABS plastic"). Empty array if unknown.
- "notes" = 1-3 sentence summary of what you confirmed.
- "sources" = URLs you relied on. At least one if you found anything.
- If the supplier name is too generic and you can't confidently find them, return empty fields rather than inventing.`;

const RESEARCH_MODEL = "gpt-4o-mini";

export async function webResearchSupplier(
  supplier: { name: string; category?: string | null; origin?: string | null; products?: string | null; website?: string | null },
): Promise<SupplierWebResearch> {
  const client = openaiClient();
  const userPrompt = `Research this supplier and return structured info as JSON.

Name: ${supplier.name}
Category: ${supplier.category ?? ""}
Origin: ${supplier.origin ?? ""}
Known products: ${supplier.products ?? ""}
Existing website (verify or replace if wrong): ${supplier.website ?? ""}

Return ONLY a JSON object matching this shape (no other text):
{
  "website": string,
  "manufacturingTypes": string[],
  "materials": string[],
  "notes": string,
  "sources": string[]
}`;

  // Responses API supports the web_search tool but does NOT support strict
  // json_schema. We ask the model to return JSON in its message, then parse.
  const res = await client.responses.create({
    model: RESEARCH_MODEL,
    tools: [{ type: "web_search" }],
    input: [
      { role: "system", content: WEB_RESEARCH_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  // `output_text` is the convenience aggregate of all assistant text output.
  const raw = (res as unknown as { output_text?: string }).output_text ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Web search returned no text");
  }
  // Strip markdown fences if present.
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: SupplierWebResearch;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: try to find a JSON object inside the text.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Web search returned non-JSON");
    parsed = JSON.parse(m[0]);
  }
  // Be defensive with shape — the model may omit fields.
  return {
    website: parsed.website ?? "",
    manufacturingTypes: Array.isArray(parsed.manufacturingTypes) ? parsed.manufacturingTypes : [],
    materials: Array.isArray(parsed.materials) ? parsed.materials : [],
    notes: parsed.notes ?? "",
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  };
}

// Use when only the website is needed (no manufacturing fields).
export async function webResearchWebsite(
  supplier: { name: string; category?: string | null; origin?: string | null; products?: string | null },
): Promise<{ website: string; sources: string[] }> {
  const result = await webResearchSupplier(supplier);
  return { website: result.website, sources: result.sources };
}

