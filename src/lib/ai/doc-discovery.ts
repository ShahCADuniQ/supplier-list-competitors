// AI-powered last-resort document URL discovery. Per the AI Project Master
// Guide §5.4: "Use whatever tool is necessary — re-read the source, use a
// different tool, search related sources, ask the user". When every
// deterministic doc-extractor returns nothing, this module hands a bundle
// of every URL we found on the rendered page to Claude and asks it which
// ones are real product documents.
//
// Strategy:
//   1. Caller collects every <a href> from the page, plus the inline-script
//      PDF-ish URLs, plus the page text (for context).
//   2. We pass them to Claude with a strict tool_use schema. Claude returns
//      `{ documents: [{ url, label, kind }] }`.
//   3. We trust Claude's classification but cap the result to at most 50
//      docs and filter out obviously-non-doc URLs (HTML pages, image-CDN
//      pixels) as a sanity guard.
//
// Cost: ONE Claude call, system prompt cached via ephemeral cache_control.
// Triggered only when all deterministic strategies returned nothing, so
// typical product pages never reach this rung. iGuzzini-class sites with
// JS-injected docs that don't match any known pattern get rescued here.

import type Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "./claude";

const DOC_KINDS = [
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
] as const;

const DOC_DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description:
              "Absolute https:// URL that downloads a document file. Must be one of the URLs from the input — never invent.",
          },
          label: {
            type: "string",
            description:
              "Short human label, e.g. 'Spec Sheet — 3000K', 'BIM Family', 'Installation Guide'.",
          },
          kind: {
            type: "string",
            enum: [...DOC_KINDS],
          },
        },
        required: ["url", "label", "kind"],
      },
    },
  },
  required: ["documents"],
} as const;

const DOC_DISCOVERY_SYSTEM_PROMPT = `You are a document URL classifier for an architectural-lighting research tool. You receive a list of URLs and (optional) anchor text from a competitor's product page. Your job: identify which URLs are downloadable product documents.

Document kinds to recognise:
- spec-sheet: PDF cut sheet / datasheet / spec sheet
- ies-photometric: .ies / .ldt photometric files
- cad-drawing: DWG / DXF dimensional or technical drawings
- bim-revit: RFA / RVT / SKP / STEP / 3D model files
- brochure: family brochure / catalog
- installation: install instructions / mounting guide
- warranty: warranty document
- manual: user / operating manual
- certification: UL / DLC / FCC / RoHS / IEC compliance docs
- image: high-res product photos / renderings explicitly offered for download
- other: any other downloadable product asset

Rules:
1. Only return URLs FROM THE INPUT LIST — never invent or modify them.
2. Skip URLs that are HTML pages (product pages, blog posts, category pages). Only downloadable assets.
3. Skip URLs that are NOT product-specific (privacy policy, terms, generic catalog, sitemap.xml, robots.txt).
4. Skip image URLs hosted on generic image CDNs unless the URL clearly indicates a download (e.g. "spec_high_res_jpg").
5. Prefer the most-specific label visible in the anchor text. If anchor text is empty or generic ("Download", "PDF"), infer from the URL filename.
6. Be exhaustive. List every variant (different CCT / wattage / mounting / lens often each have their own spec sheet & IES file).
7. If there are NO real product documents in the input, return { "documents": [] }. Don't force matches.
8. Use the record_documents tool to return your findings — that's the only way to respond.`;

export type DocDiscoveryCandidate = {
  /** Absolute URL from the page. */
  url: string;
  /** Anchor/button text, if known. Empty otherwise. */
  text?: string;
};

export type DocDiscoveryResult = {
  documents: Array<{ url: string; label: string; kind: string }>;
};

/**
 * Hand the URL bundle to Claude and ask which are real product docs.
 *
 * Returns an empty `documents` array when:
 *  - ANTHROPIC_API_KEY isn't set (caller is expected to use Perplexity instead)
 *  - the call fails / times out (degrades gracefully — never throws)
 *  - Claude judges that none of the input URLs are real docs
 *
 * The caller must dedupe `candidates` and cap to a sensible size before
 * passing — we cap further at 500 inside this function as a hard safety
 * limit to keep input tokens bounded.
 */
export async function discoverDocumentsWithClaude(input: {
  productName: string;
  brandName: string;
  productUrl: string;
  candidates: DocDiscoveryCandidate[];
  modelOverride?: string;
}): Promise<DocDiscoveryResult> {
  if (!hasClaudeKey()) {
    return { documents: [] };
  }
  if (input.candidates.length === 0) {
    return { documents: [] };
  }
  // Hard cap: 500 candidates is plenty for any realistic product page; more
  // than this is almost certainly noise (sitemap dumps, full-site anchors).
  const capped = input.candidates.slice(0, 500);

  const candidateText = capped
    .map((c, i) => {
      const t = (c.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      return `${i + 1}. ${c.url}${t ? ` — "${t}"` : ""}`;
    })
    .join("\n");

  const userMsg = `Product: ${input.productName}
Brand: ${input.brandName}
Source page: ${input.productUrl}

Below are every URL surfaced on the rendered product page (anchors + inline-script asset references). Identify which are real downloadable documents FOR THIS PRODUCT.

=== Candidate URLs (${capped.length}) ===
${candidateText}`;

  const client = claudeClient();
  const requestedModel = input.modelOverride || CLAUDE_MODEL;
  const tryModels = [
    requestedModel,
    ...CLAUDE_FALLBACK_MODELS.filter((m) => m !== requestedModel),
  ];

  for (const model of tryModels) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: DOC_DISCOVERY_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: "record_documents",
            description:
              "Record the list of product documents you've identified in the candidate URLs.",
            input_schema: DOC_DISCOVERY_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            cache_control: { type: "ephemeral" },
          },
        ],
        tool_choice: { type: "tool", name: "record_documents" },
        messages: [{ role: "user", content: userMsg }],
      });
      for (const block of res.content) {
        if (block.type === "tool_use" && block.name === "record_documents") {
          const parsed = block.input as DocDiscoveryResult;
          const allow = new Set(capped.map((c) => c.url));
          // Trust-but-verify: drop anything that wasn't in the input.
          const safe = (parsed.documents ?? []).filter((d) =>
            allow.has(d.url),
          );
          return { documents: safe.slice(0, 50) };
        }
      }
      // No tool_use block — model returned text. Treat as empty.
      return { documents: [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fall through to next model on permission / not-found errors;
      // bail on anything else.
      if (!/not[_ ]?found|permission|invalid[_ ]?model|404|403/i.test(msg)) {
        console.warn("[discoverDocumentsWithClaude] failed:", msg);
        return { documents: [] };
      }
      console.warn(
        `[discoverDocumentsWithClaude] ${model} unavailable, falling back:`,
        msg,
      );
    }
  }
  return { documents: [] };
}
