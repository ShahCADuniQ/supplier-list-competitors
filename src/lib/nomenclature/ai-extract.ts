// AI extractor — given a hardware nomenclature standard plus a product
// URL (Amazon, McMaster, Fastenal, eBay, vendor pages, …) Claude reads
// the page, picks the right enum values, and returns a code that fits
// the family's template. The caller then prepends class code + unique
// ID to assemble the final fullCode.
//
// We use the existing claude.ts helper so the cost-control + fallback
// chain (Opus → Opus prev → Sonnet → Haiku) applies. No PDF parsing;
// the URL is fetched server-side and the visible HTML text is passed
// to the model.

import { claudeClient, CLAUDE_MODEL } from "@/lib/ai/claude";

const URL_FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 60_000;

// V125 — a few sensible browser-like UAs we rotate through. Major
// vendors (McMaster, Fastenal, Amazon, eBay, DigiKey, …) block the
// previous "NomenclatureBot" UA outright, returning 403 / a captcha
// page. We don't aim for full anti-bot resistance — just enough that
// a typical product page loads.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPlainText(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), URL_FETCH_TIMEOUT_MS);
  let originHeader: string | null = null;
  try {
    const u = new URL(url);
    originHeader = `${u.protocol}//${u.host}`;
  } catch {
    // Bad URL — re-throw with a clearer message instead of fetching.
    throw new Error("That doesn't look like a valid URL.");
  }
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        ...(originHeader ? { Referer: originHeader } : {}),
      },
    });
    if (!res.ok) {
      // Some vendors return the actual page content alongside a 403
      // / 503 — try to use it anyway so the AI has something to
      // chew on. Empty body? Re-throw with the status.
      const fallbackText = await res.text().catch(() => "");
      if (fallbackText.trim().length > 200) {
        return stripHtml(fallbackText);
      }
      throw new Error(
        `Vendor page returned ${res.status} ${res.statusText}. ` +
          `Most likely the site is blocking server-side fetches; ` +
          `try a different URL (e.g. the printable spec PDF page) ` +
          `or fill the nomenclature in manually.`,
      );
    }
    const html = await res.text();
    return stripHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  // Strip <script>, <style>, and HTML tags; collapse whitespace; cap.
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, MAX_BODY_CHARS);
}

export type AiExtractResult = {
  // The nomenclature string (without classCode + uniqueId), e.g.
  //   "HEX-PHL-M5-0,8-25-3-8-(FULL)-(SS)-(WOOD)-(STAP)"
  nomenclature: string;
  // Display name we pull from the page title / breadcrumb so the
  // inventory row has a human label.
  name: string | null;
  // Short caveats Claude wanted to surface ("guessed material from
  // image", "page didn't list pitch — assumed 0.8"). Shown verbatim
  // beneath the result.
  notes: string | null;
  // V126 — when the product introduces a TYPE / MATERIAU / etc. that
  // wasn't in the standard yet, Claude proposes additional lines to
  // append to the relevant section so future extractions have the
  // new abbreviation. Empty when no extension was needed. Each entry
  // is rendered as "{section}\n{line}" and merged into spec_text.
  specExtensions: Array<{ section: string; lines: string[] }>;
  rawModelOutput: string;
};

export type AiTemplateSuggestion = {
  // Suggested family name in title case (e.g. "Cable Glands").
  name: string;
  // Suggested template line, dash-joined, matching the existing
  // NOMENCLATURE_*.txt shape (e.g. "TYPE-DIA-THREAD-(MATERIAU)").
  template: string;
  // Spec body — type list with abbreviations, materials list,
  // examples — matching the existing .txt files' shape.
  specText: string;
  rawModelOutput: string;
};

// AI-suggested preliminary nomenclature template for a brand-new
// hardware family. Used by the "New family" wizard so the user gets
// a starting point instead of a blank template field. The user
// reviews + edits before saving.
export async function suggestTemplateFromUrl(args: {
  url: string;
}): Promise<AiTemplateSuggestion> {
  const pageText = await fetchPlainText(args.url);

  const system = [
    "You are designing a nomenclature standard for an internal parts catalogue.",
    "Look at the product page and propose a SHORT template + standard body.",
    "Follow the existing convention: a dash-joined template line, then a body that lists TYPE choices (3-letter abbreviations), MATERIAUX choices (2-letter abbreviations), optional anchor/category lists, then EXEMPLES.",
    "Substitute / with _ and . with , in dimensions.",
    "ALL VALUES IN UPPERCASE.",
    "Return ONLY a JSON object — no markdown fences.",
  ].join(" ");

  const user = [
    "PRODUCT URL:",
    args.url,
    "",
    "PAGE TEXT (truncated):",
    pageText,
    "",
    "Return JSON shaped:",
    `{"name": "<title-case family name>",`,
    ` "template": "<dash-joined template line>",`,
    ` "specText": "<the body, plain text>"}`,
    "",
    "Example body shape:",
    "TYPE",
    "Some Type : XYZ",
    "Another Type : ABC",
    "",
    "MATERIAUX",
    "Stainless Steel : SS",
    "",
    "EXEMPLES:",
    "XYZ-10-(SS)",
  ].join("\n");

  const client = claudeClient();
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1200,
    // V126 — temperature is deprecated on Opus 4.7+; passing it
    // returns a 400 invalid_request_error. The new models default
    // to a low temperature internally which is fine for our use.
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  type Parsed = { name?: string; template?: string; specText?: string };
  let parsed: Parsed;
  try {
    parsed = JSON.parse(cleaned) as Parsed;
  } catch {
    throw new Error(
      `Claude returned non-JSON template suggestion. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (!parsed.name || !parsed.template || !parsed.specText) {
    throw new Error(
      `Claude omitted required fields. Got: ${text.slice(0, 200)}`,
    );
  }
  return {
    name: parsed.name.trim(),
    template: parsed.template.trim().toUpperCase(),
    specText: parsed.specText.trim(),
    rawModelOutput: text,
  };
}

export async function extractHardwareFromUrl(args: {
  url: string;
  template: string;
  specText: string;
  familyName: string;
}): Promise<AiExtractResult> {
  const pageText = await fetchPlainText(args.url);

  const system = [
    "You are extracting a hardware nomenclature code from a product page.",
    "Follow the family's nomenclature standard. Prefer the abbreviations already listed in the standard.",
    "If the product has a TYPE / HEAD / DRIVE / MATERIAL / etc. that is NOT in the standard, INVENT a sensible short uppercase abbreviation following the convention of the existing entries (typically 2-4 letters) AND list the new line in specExtensions so we can append it to the standard for future use.",
    "Substitute / with _ and . with , in dimensions (matching the standard's convention).",
    "Return ONLY a JSON object. No markdown fences. No prose outside the JSON.",
  ].join(" ");

  const user = [
    `Hardware family: ${args.familyName}`,
    "",
    "TEMPLATE (this is the literal shape your nomenclature must match):",
    args.template,
    "",
    "FULL STANDARD:",
    args.specText,
    "",
    "PRODUCT URL:",
    args.url,
    "",
    "PAGE TEXT (truncated):",
    pageText,
    "",
    "Return JSON shaped:",
    `{"nomenclature": "<the assembled code, NO leading class prefix, NO unique id>",`,
    ` "name": "<human-readable product name from the page, or null>",`,
    ` "notes": "<short caveats if anything had to be guessed, or null>",`,
    ` "specExtensions": [`,
    `   {"section": "<header name from the standard, e.g. TYPE or MATERIAUX>",`,
    `    "lines": ["<readable label> : <ABBR>"] }`,
    ` ]}`,
    "",
    "Leave specExtensions as [] when every abbreviation you used already appears in the standard.",
  ].join("\n");

  const client = claudeClient();
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1200,
    // V126 — temperature is deprecated on Opus 4.7+.
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  // Tolerate the model wrapping its JSON in ```json … ``` despite the
  // instruction not to.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  type Parsed = {
    nomenclature?: string;
    name?: string | null;
    notes?: string | null;
    specExtensions?: Array<{ section?: string; lines?: string[] }>;
  };
  let parsed: Parsed;
  try {
    parsed = JSON.parse(cleaned) as Parsed;
  } catch {
    throw new Error(
      `Claude returned non-JSON output. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (!parsed.nomenclature || typeof parsed.nomenclature !== "string") {
    throw new Error(
      `Claude returned no "nomenclature" field. Got: ${text.slice(0, 200)}`,
    );
  }
  const specExtensions: AiExtractResult["specExtensions"] = [];
  if (Array.isArray(parsed.specExtensions)) {
    for (const ext of parsed.specExtensions) {
      const section = typeof ext.section === "string" ? ext.section.trim() : "";
      const lines = Array.isArray(ext.lines)
        ? ext.lines
            .filter((l): l is string => typeof l === "string")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
      if (section && lines.length > 0) {
        specExtensions.push({ section, lines });
      }
    }
  }
  return {
    nomenclature: parsed.nomenclature.trim(),
    name: parsed.name?.trim() ?? null,
    notes: parsed.notes?.trim() ?? null,
    specExtensions,
    rawModelOutput: text,
  };
}
