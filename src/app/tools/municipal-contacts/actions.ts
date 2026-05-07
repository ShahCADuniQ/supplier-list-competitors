"use server";

// Tools / Municipal Contacts — generate a directory of engineering and
// administration contacts for Canadian municipalities.
//
// Pipeline:
//   1. Perplexity does the on-the-web research — its `sonar` family is
//      built for citation-backed lookups, which is exactly what we want
//      when scraping public municipal directories.
//   2. Claude normalizes + categorizes the result. Perplexity's response
//      is verbose, sometimes mixes records, and label fields vary
//      ("Director of Engineering" vs "City Engineer" vs "Chief Engineer").
//      Claude collapses them into a canonical category bucket and a
//      consistent record shape.
//   3. The resulting rows persist as a `municipality_searches` parent
//      with a child `municipality_contacts` per record so the user can
//      re-open the search later.
//
// Why both models: this skill follows the project's "use Claude when
// OpenAI / Perplexity is thin" rule — Perplexity is the search engine,
// Claude is the cleaner. Single-model attempts at this either miss
// citations (Claude alone) or return inconsistent shapes (Perplexity
// alone).

import type Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  municipalitySearches,
  municipalityContacts,
} from "@/db/schema";
import { perplexityChat, hasPerplexityKey } from "@/lib/ai/perplexity";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "@/lib/ai/claude";
import { getOrCreateProfile, canEdit } from "@/lib/permissions";
import {
  SCOPE_TYPES,
  SECTOR_OPTIONS,
  ALL_SECTOR_CODES,
  COUNT_MIN,
  COUNT_MAX,
} from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type GenerateInput = {
  province: string; // full province name, e.g. "Quebec"
  scopeTypes: string[]; // any subset of SCOPE_TYPES.code, or [] = "all"
  sectors: string[]; // any subset of SECTOR_OPTIONS.code, or [] = "all"
  cityFilter?: string | null; // optional municipality name (prefix match in prompt)
  count: number;
  title?: string | null;
  notes?: string | null;
};

export type GenerateResult = {
  searchId: number;
  contactCount: number;
  citations: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// PERPLEXITY SCHEMA — what we ask the search model to return
// ─────────────────────────────────────────────────────────────────────────────

const PERPLEXITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          municipalityName: { type: "string" },
          municipalityType: { type: "string" }, // city/town/village/municipality
          department: { type: "string" }, // free-form
          role: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          website: { type: "string" },
          sourceUrl: { type: "string" },
          servicesSummary: { type: "string" },
          notes: { type: "string" },
        },
        required: [
          "municipalityName",
          "municipalityType",
          "department",
          "role",
          "name",
          "email",
          "phone",
          "address",
          "website",
          "sourceUrl",
          "servicesSummary",
          "notes",
        ],
      },
    },
  },
  required: ["contacts"],
};

type PerplexityContact = {
  municipalityName: string;
  municipalityType: string;
  department: string;
  role: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  website: string;
  sourceUrl: string;
  servicesSummary: string;
  notes: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE — categorize + normalize Perplexity's records
// ─────────────────────────────────────────────────────────────────────────────

type CategorizedContact = PerplexityContact & {
  category: string; // engineering | public-works | administration | elected | other
};

async function categorizeWithClaude(
  raw: PerplexityContact[],
): Promise<CategorizedContact[]> {
  if (!hasClaudeKey()) {
    // Fallback: keyword categorization so the tool still works without Claude.
    return raw.map((c) => ({ ...c, category: keywordCategory(c) }));
  }
  const client = claudeClient();
  const sectorBullets = SECTOR_OPTIONS.map(
    (s) => `  • "${s.code}" — ${s.promptHint}`,
  ).join("\n");
  const systemPrompt = `You are normalizing a list of Canadian municipal contacts. For each input record, return one record with EVERY field plus a "category" chosen from this fixed set:
${sectorBullets}

Pick the BEST single bucket. Trim and clean every field. Keep email / phone digits readable; strip "mailto:" prefixes; collapse whitespace. If a field is unknown, use empty string. Don't invent fields.`;

  const userPrompt = `Normalize and categorize:\n\n${JSON.stringify(raw, null, 2)}`;

  const tools = [
    {
      name: "record_contacts",
      description: "Normalized + categorized municipal contacts.",
      input_schema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          contacts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                municipalityName: { type: "string" },
                municipalityType: { type: "string" },
                department: { type: "string" },
                role: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                phone: { type: "string" },
                address: { type: "string" },
                website: { type: "string" },
                sourceUrl: { type: "string" },
                notes: { type: "string" },
                servicesSummary: { type: "string" },
                category: {
                  type: "string",
                  enum: [...ALL_SECTOR_CODES],
                },
              },
              required: [
                "municipalityName",
                "municipalityType",
                "department",
                "role",
                "name",
                "email",
                "phone",
                "address",
                "website",
                "sourceUrl",
                "servicesSummary",
                "notes",
                "category",
              ],
            },
          },
        },
        required: ["contacts"],
      },
    },
  ];

  const models = [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS];
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools,
        tool_choice: { type: "tool", name: "record_contacts" },
      });
      const block = res.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (!block) throw new Error("Claude did not call the tool");
      const out = block.input as { contacts: CategorizedContact[] };
      return out.contacts;
    } catch (e) {
      lastErr = e;
      console.warn(`[municipal-contacts] Claude ${model} failed:`, e);
      // Try next fallback model.
    }
  }
  // Every model failed — fall back to keyword categorization rather than
  // throwing, so Perplexity's data isn't lost.
  console.warn(
    "[municipal-contacts] every Claude model failed; using keyword fallback:",
    lastErr,
  );
  return raw.map((c) => ({ ...c, category: keywordCategory(c) }));
}

function keywordCategory(c: PerplexityContact): string {
  const hay = `${c.department} ${c.role} ${c.notes}`.toLowerCase();
  if (/police|service[\s-]?de[\s-]?police|chief[\s-]?of[\s-]?police/.test(hay)) {
    return "police";
  }
  if (
    /fire[\s-]?chief|service[\s-]?d?[ ’']?incendie|sécurité[\s-]?incendie|emergency[\s-]?services|civil[\s-]?security|public[\s-]?safety/.test(
      hay,
    )
  ) {
    return "fire";
  }
  if (
    /environment|environnement|sustainab|sanitation|matières[\s-]?résiduelles|recycl|climate|développement[\s-]?durable/.test(
      hay,
    )
  ) {
    return "environment";
  }
  if (/parks|parcs|recreation|loisirs|sports/.test(hay)) {
    return "parks";
  }
  if (
    /planning|urbanisme|urbaniste|land[\s-]?use|zoning|permits?|aménagement/.test(
      hay,
    )
  ) {
    return "planning";
  }
  if (
    /engineer|génie|ingénieur|ingenieur|ing\./i.test(hay) ||
    /civil|traffic|geomatics|municipal[\s-]?engineering/.test(hay)
  ) {
    return "engineering";
  }
  if (
    /public[\s-]?works|travaux[\s-]?publics|water|sewer|wastewater|road|infrastructure|voirie/.test(
      hay,
    )
  ) {
    return "public-works";
  }
  if (/mayor|maire|councill?or|conseiller|deputy[\s-]?mayor/.test(hay)) {
    return "elected";
  }
  if (
    /clerk|greffier|director[\s-]?general|directeur[\s-]?general|city[\s-]?manager|administrator|finance|hr|human[\s-]?resources|town[\s-]?hall/.test(
      hay,
    )
  ) {
    return "administration";
  }
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY — generate + persist
// ─────────────────────────────────────────────────────────────────────────────

export async function generateMunicipalContacts(
  input: GenerateInput,
): Promise<GenerateResult> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  if (!canEdit(profile)) throw new Error("Insufficient permissions");

  if (!hasPerplexityKey()) {
    throw new Error(
      "PERPLEXITY_API_KEY (or PPLX_API_KEY) is not set. Add it to .env to use this tool.",
    );
  }

  const province = input.province.trim();
  if (!province) throw new Error("Province is required");

  const count = clampCount(input.count);
  const scopeTypes = (input.scopeTypes ?? []).filter(Boolean);
  const scopeText = scopeTypeText(scopeTypes);
  // Sectors: empty list means "all sectors" — same convention as scope.
  const sectors = (input.sectors ?? []).filter((s) =>
    ALL_SECTOR_CODES.includes(s),
  );
  const cityFilter = (input.cityFilter ?? "").trim() || null;

  // Load every existing contact for this province so we can (a) tell
  // Perplexity to skip those municipalities and (b) reject duplicates
  // before insert. Keys are `municipality::role` — same person at
  // different roles, or two roles in one municipality, each count as
  // separate leads.
  const existingRows = await db
    .select({
      municipalityName: municipalityContacts.municipalityName,
      role: municipalityContacts.role,
    })
    .from(municipalityContacts)
    .where(eq(municipalityContacts.province, province));
  const existingKeys = new Set<string>();
  const existingMunicipalities = new Set<string>();
  for (const r of existingRows) {
    existingKeys.add(dedupKeyOf(r.municipalityName, r.role));
    if (r.municipalityName) existingMunicipalities.add(r.municipalityName);
  }
  console.log(
    `[municipal-contacts] excluding ${existingMunicipalities.size} municipalities (${existingRows.length} existing contacts) from this generation`,
  );

  // Build the Perplexity prompt — explicit about only Canada, only public
  // contacts, only the requested scope, and the sectors we want filled.
  // The excluded list is passed in so the model doesn't rediscover known
  // municipalities; it nudges Perplexity toward unsearched towns.
  const userPrompt = buildPerplexityPrompt({
    province,
    scopeText,
    sectors,
    cityFilter,
    count,
    excludedMunicipalities: [...existingMunicipalities],
  });

  console.log(
    `[municipal-contacts] generating ${count} contacts for ${province}` +
      (cityFilter ? ` (filter: ${cityFilter})` : "") +
      ` scope=${scopeTypes.join(",") || "all"}` +
      ` sectors=${sectors.join(",") || "all"}`,
  );

  // Budget per record × count + overhead. Each record is ~150 output tokens
  // (12 string fields + JSON shape). For 200 records this is ~30k; clamped
  // to 32k since most providers cap there.
  const maxTokens = Math.min(32_000, 1500 + count * 180);

  const systemPrompt =
    "You are a public-records research assistant for Canadian municipalities. Take time to actually search the web for each municipality before answering. Search BOTH English and French municipal websites — Quebec and New Brunswick directories are often in French. Use ONLY publicly-listed municipal contacts (city hall directories, official municipal pages). Do not include personal cell numbers or unverified emails. If a record's optional fields aren't on the source, fill them with empty string. Spread contacts across multiple municipalities.";

  // Two-pass strategy.
  //
  // Pass A: strict JSON-schema mode. Fast when it works (5-10 s) and the
  // model fills the array directly. Some queries — notably Quebec, where
  // the directories are in French — make sonar-pro bail in JSON-schema
  // mode and return `{"contacts":[]}` in ~2 s without actually searching.
  //
  // Pass B: free-form prompt. Strip the JSON schema and instead give the
  // model an explicit example output block, then parse the JSON we find
  // inside the reply ourselves. This fires only when Pass A returned []
  // and reliably produces 10+ records.
  let citations: string[] = [];
  let rawContacts: PerplexityContact[] = [];

  try {
    const passA = await perplexityChat<{ contacts: PerplexityContact[] }>({
      systemPrompt,
      userPrompt,
      schema: PERPLEXITY_SCHEMA,
      schemaName: "municipal_contacts",
      maxTokens,
    });
    rawContacts = passA.content?.contacts ?? [];
    citations = passA.citations ?? [];
    console.log(
      `[municipal-contacts] Pass A (schema): ${rawContacts.length} contacts, ${citations.length} citations`,
    );
  } catch (e) {
    console.warn("[municipal-contacts] Pass A failed:", e);
  }

  if (rawContacts.length === 0) {
    console.warn(
      "[municipal-contacts] Pass A returned 0 — falling back to free-form prompt (Pass B)",
    );
    const freeFormPrompt = buildFreeFormPrompt({
      province,
      scopeText,
      sectors,
      cityFilter,
      count,
      excludedMunicipalities: [...existingMunicipalities],
    });
    try {
      const passB = await perplexityChat<string>({
        systemPrompt,
        userPrompt: freeFormPrompt,
        // No schema — the model returns a fenced JSON block we parse below.
        maxTokens,
      });
      const text = passB.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { contacts?: PerplexityContact[] };
          rawContacts = parsed.contacts ?? [];
          citations = passB.citations ?? citations;
          console.log(
            `[municipal-contacts] Pass B (free-form): ${rawContacts.length} contacts, ${citations.length} citations`,
          );
        } catch (e) {
          console.warn("[municipal-contacts] Pass B JSON parse failed:", e);
        }
      } else {
        console.warn(
          "[municipal-contacts] Pass B returned no JSON block. Head:",
          text.slice(0, 300),
        );
      }
    } catch (e) {
      console.warn("[municipal-contacts] Pass B failed:", e);
    }
  }

  if (!rawContacts.length) {
    throw new Error(
      "Perplexity returned no contacts in either schema or free-form mode. Try a broader scope, fewer sectors, or a smaller count.",
    );
  }

  // Claude normalizes + categorizes (or keyword fallback if Claude is down).
  const categorized = await categorizeWithClaude(rawContacts);

  // Verify every sourceUrl + website actually resolves. Perplexity sometimes
  // hallucinates plausible-sounding URLs that 404. We HEAD-check each in
  // parallel; for any that fails, swap in the closest Perplexity citation
  // that mentions the same municipality (or null out the field) so the user
  // never clicks through to a dead page.
  const verified = await verifyContactUrls(categorized, citations);

  // Fill missing services_summary fields with a per-record Perplexity
  // follow-up call. Don't gate-and-reject incomplete rows here — users may
  // intentionally want partial records — but every record we DO save should
  // have a useful summary if we can produce one. Skipped silently if the
  // follow-up fails.
  await fillMissingServicesSummaries(verified);

  // Insert search row + contacts (single transaction-ish flow: parent first,
  // then bulk insert children).
  const [searchRow] = await db
    .insert(municipalitySearches)
    .values({
      country: "Canada",
      province,
      scopeTypes: scopeTypes.length ? scopeTypes.join(",") : "all",
      sectors: sectors.length ? sectors.join(",") : "all",
      cityFilter,
      requestedCount: count,
      title: (input.title ?? "").trim() || null,
      notes: (input.notes ?? "").trim() || null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning();

  // Filter out duplicates against the existing-keys set built at the top.
  // Identical (municipality::role) records already in the DB would just clutter
  // the user's directory, so we keep only the genuinely-new ones.
  const fresh = verified.filter((c) => {
    const k = dedupKeyOf(c.municipalityName, c.role);
    if (existingKeys.has(k)) return false;
    existingKeys.add(k); // also catches dupes within this generation
    return true;
  });
  const skippedDupes = verified.length - fresh.length;
  if (skippedDupes > 0) {
    console.log(
      `[municipal-contacts] skipped ${skippedDupes} duplicate(s) already in the directory`,
    );
  }

  if (fresh.length > 0) {
    await db.insert(municipalityContacts).values(
      fresh.map((c) => ({
        searchId: searchRow.id,
        municipalityName: c.municipalityName?.trim() || "Unknown",
        municipalityType: nullIfEmpty(c.municipalityType),
        province,
        department: nullIfEmpty(c.department),
        role: nullIfEmpty(c.role),
        category: c.category || "other",
        name: nullIfEmpty(c.name),
        email: nullIfEmpty(c.email),
        phone: nullIfEmpty(c.phone),
        address: nullIfEmpty(c.address),
        website: nullIfEmpty(c.website),
        sourceUrl: nullIfEmpty(c.sourceUrl),
        servicesSummary: nullIfEmpty(c.servicesSummary),
        notes: nullIfEmpty(c.notes),
      })),
    );
  }

  revalidatePath("/tools/municipal-contacts");
  return {
    searchId: searchRow.id,
    contactCount: fresh.length,
    citations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL VERIFICATION
//
// Perplexity returns plausible URLs that don't always exist. HEAD-check each
// sourceUrl + website in parallel; on failure, try to substitute a citation
// the model actually visited that mentions the same municipality. As a last
// resort, null the field — better than linking to a 404.
// ─────────────────────────────────────────────────────────────────────────────

const URL_VERIFY_TIMEOUT_MS = 8_000;
const URL_VERIFY_CONCURRENCY = 8;
const VERIFY_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

async function verifyContactUrls(
  contacts: CategorizedContact[],
  citations: string[],
): Promise<CategorizedContact[]> {
  // Collect every distinct URL across sourceUrl + website. Verifying once per
  // URL — many contacts share a municipality website.
  const urls = new Set<string>();
  for (const c of contacts) {
    if (c.sourceUrl) urls.add(c.sourceUrl);
    if (c.website) urls.add(c.website);
  }
  for (const u of citations) urls.add(u);

  const status = new Map<string, boolean>(); // url → ok
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u) return;
      status.set(u, await checkUrl(u));
    }
  }
  await Promise.all(
    Array.from({ length: URL_VERIFY_CONCURRENCY }, () => worker()),
  );

  let fixed = 0;
  let droppedSource = 0;
  let droppedWebsite = 0;
  const out = contacts.map((c) => {
    let sourceUrl = c.sourceUrl?.trim() || "";
    let website = c.website?.trim() || "";

    if (sourceUrl && !status.get(sourceUrl)) {
      const replacement = bestCitationFor(c.municipalityName, citations, status);
      if (replacement) {
        sourceUrl = replacement;
        fixed++;
      } else {
        sourceUrl = "";
        droppedSource++;
      }
    }
    if (website && !status.get(website)) {
      // Try to keep a domain-level fallback (https://<host>/) if the host
      // appears in any citation that resolved.
      const fallback = bestCitationDomainFor(website, citations, status);
      if (fallback) {
        website = fallback;
      } else {
        website = "";
        droppedWebsite++;
      }
    }

    return { ...c, sourceUrl, website };
  });

  console.log(
    `[municipal-contacts] verify: checked ${urls.size} URL(s) · ` +
      `replaced ${fixed} sourceUrl(s) · ` +
      `dropped ${droppedSource} sourceUrl(s) and ${droppedWebsite} website(s) that 404'd`,
  );
  return out;
}

// Per-record services_summary follow-up. Runs in a small parallel pool so
// a 50-record search doesn't take 2-3 minutes longer. Mutates the records
// in place — empty or thin summaries (< 40 chars) are replaced with a
// follow-up Perplexity reply.
const SUMMARY_FILL_CONCURRENCY = 4;

async function fillMissingServicesSummaries(
  contacts: CategorizedContact[],
): Promise<void> {
  const todo = contacts.filter(
    (c) => !c.servicesSummary || c.servicesSummary.trim().length < 40,
  );
  if (todo.length === 0) return;
  console.log(
    `[municipal-contacts] filling services_summary for ${todo.length} record(s)`,
  );
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      if (!c) return;
      try {
        const r = await perplexityChat<string>({
          systemPrompt:
            "You are a public-records research assistant. Reply with 2-3 specific sentences in plain prose — no markdown, no bullets, no preamble.",
          userPrompt: `Summarize what the "${c.department}" department of "${c.municipalityName}" (Canada) actually does — what services it offers, what projects it runs, who it serves. Be specific to this municipality based on what their website says.${
            c.sourceUrl ? ` Their listing: ${c.sourceUrl}` : ""
          }${c.website ? ` Their homepage: ${c.website}` : ""}`,
          maxTokens: 600,
        });
        const summary = (r.content ?? "").trim().replace(/^"|"$/g, "");
        if (summary.length >= 40) {
          c.servicesSummary = summary;
        }
      } catch (e) {
        console.warn(
          `  summary fill failed for ${c.municipalityName}: ${(e as Error).message}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: SUMMARY_FILL_CONCURRENCY }, () => worker()),
  );
}

async function checkUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_VERIFY_TIMEOUT_MS);
  try {
    // Verify with realistic browser headers; many municipal CMSes (Drupal,
    // SiteCore) sit behind WAFs that 403 a bare HEAD request even when the
    // page is real and reachable from a browser. We only treat the URL as
    // broken when we get a definitive 404 / 410 / 5xx — anything else is
    // assumed reachable so we don't strip URLs out of the user's results
    // just because we hit a bot wall.
    const headers = {
      "User-Agent": VERIFY_BROWSER_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
    };
    // GET (not HEAD) — many sites HEAD-block but answer GET.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers,
    }).catch(() => null);
    if (!res) return false; // network failure — treat as broken
    // 2xx / 3xx → fine. 401/403 → bot wall, page likely real, keep it.
    if (res.status < 400) return true;
    if (res.status === 401 || res.status === 403) return true;
    return false; // 404 / 410 / 5xx etc.
  } finally {
    clearTimeout(timer);
  }
}

/** Score citations by host-similarity to the municipality name + domain
 *  signal (gov.qc.ca, ville.<x>, town.<x>). Best-scoring resolved citation
 *  wins. Returns null if nothing resolves or matches. */
function bestCitationFor(
  municipalityName: string,
  citations: string[],
  status: Map<string, boolean>,
): string | null {
  const name = (municipalityName || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = name.split(/\s+/).filter((t) => t.length >= 4);
  let best: { url: string; score: number } | null = null;
  for (const u of citations) {
    if (!status.get(u)) continue; // only consider URLs that actually resolved
    const lower = u.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score += 2;
    if (/\.(qc|on|bc|ab|mb|sk|ns|nb|nl|pe|yt|nt|nu)\.ca\b/i.test(lower)) score += 1;
    if (/\b(ville|town|city|village|municipalit[eé])\b/i.test(lower)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { url: u, score };
  }
  return best?.url ?? null;
}

/** When a website 404s, try the same host's homepage (or any citation on the
 *  same host that resolved) as a fallback. */
function bestCitationDomainFor(
  brokenWebsite: string,
  citations: string[],
  status: Map<string, boolean>,
): string | null {
  let host: string;
  try {
    host = new URL(brokenWebsite).host;
  } catch {
    return null;
  }
  // Same-host root.
  const root = `https://${host}/`;
  if (status.get(root)) return root;
  // Any resolved citation on the same host.
  for (const u of citations) {
    if (!status.get(u)) continue;
    try {
      if (new URL(u).host === host) return u;
    } catch {
      // skip malformed
    }
  }
  return null;
}

export async function deleteMunicipalitySearch(searchId: number): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  if (!canEdit(profile)) throw new Error("Insufficient permissions");
  await db
    .delete(municipalitySearches)
    .where(eq(municipalitySearches.id, searchId));
  revalidatePath("/tools/municipal-contacts");
}

export async function deleteMunicipalityContact(
  contactId: number,
): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  if (!canEdit(profile)) throw new Error("Insufficient permissions");
  await db
    .delete(municipalityContacts)
    .where(eq(municipalityContacts.id, contactId));
  revalidatePath("/tools/municipal-contacts");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 25;
  const r = Math.round(n);
  if (r < COUNT_MIN) return COUNT_MIN;
  if (r > COUNT_MAX) return COUNT_MAX;
  return r;
}

function scopeTypeText(scopeTypes: string[]): string {
  if (!scopeTypes.length) return "cities, towns, villages, and other municipalities";
  const labels = scopeTypes
    .map((c) => SCOPE_TYPES.find((s) => s.code === c)?.label.toLowerCase())
    .filter(Boolean);
  return labels.length === 0 ? "municipalities" : labels.join(", ");
}

function buildPerplexityPrompt(args: {
  province: string;
  scopeText: string;
  sectors: string[];
  cityFilter: string | null;
  count: number;
  excludedMunicipalities?: string[];
}): string {
  const { province, scopeText, sectors, cityFilter, count, excludedMunicipalities } = args;
  const excludeBlock = buildExcludeBlock(excludedMunicipalities);

  // Compose the "sectors to look for" block. Empty array → ask for engineering
  // and admin first (the original default), but allow any. A non-empty list
  // becomes a strict whitelist with the long-form prompt hints inlined.
  const sectorBlock =
    sectors.length === 0
      ? `Sectors of interest (no hard filter — return any of these, with the first two being the priority):
  1. Engineering / génie municipal (Director of Engineering, City Engineer, Chief Engineer, Civil Engineer, Traffic Engineer)
  2. Public Works / Travaux publics (Director of Public Works, infrastructure, water / sewer)
  3. Administration (Mayor, City Manager, Director General / DG, Town Clerk / Greffier)
  4. Other relevant departments only if the above don't fill the count`
      : `Sectors REQUESTED (return contacts for these sectors only — exclude every other department):
${sectors
  .map((code, i) => {
    const opt = SECTOR_OPTIONS.find((s) => s.code === code);
    return `  ${i + 1}. ${opt?.label ?? code} — ${opt?.promptHint ?? ""}`;
  })
  .join("\n")}

If a municipality has no contact in any of the requested sectors, skip it and pick the next municipality.`;

  // Provinces with significant French-language municipal sites need an
  // explicit French-source instruction. Quebec is the obvious one; New
  // Brunswick is bilingual.
  const bilingualNote =
    province === "Quebec"
      ? `IMPORTANT: Quebec municipal websites are in French. Search BOTH languages — French department names like "Service du génie", "Travaux publics", "Greffier(ère)", "Directeur général", "Maire" are equally valid sources to the English equivalents. Many municipalities only publish their directories in French.`
      : province === "New Brunswick"
        ? `Note: New Brunswick is bilingual — search both English and French municipal directories.`
        : "";

  return `Find ${count} verified public contacts for municipalities in ${province}, Canada${
    cityFilter
      ? ` (focus on the municipality named "${cityFilter}" — return contacts only for that municipality and its closest neighbours)`
      : ""
  }.

${bilingualNote}
${excludeBlock}
Scope: ${scopeText}.

${sectorBlock}

For each contact, return:
  - municipalityName: the municipality name as written on its website (e.g. "Ville de Saint-Hyacinthe", "Town of Mont-Royal").
  - municipalityType: "city" / "town" / "village" / "municipality" (best guess).
  - department: department name as listed (e.g. "Engineering", "Public Works", "Service du génie").
  - role: official title (e.g. "City Engineer", "Director of Public Works", "Mayor", "Greffier").
  - name: full name if listed publicly. Empty string if directory only lists the role.
  - email: official department or person email. Empty string if unlisted.
  - phone: main phone with extension if applicable. Empty string if unlisted.
  - address: city hall / department mailing address. Empty string if not on the source page.
  - website: the municipality's website HOMEPAGE URL (not a deep link). Verify the host actually exists by checking your citations list.
  - sourceUrl: MUST be a URL you actually visited and that appears in your citations. Do NOT invent or guess paths — if the page you read at city hall doesn't have a stable URL, fall back to the staff-directory landing page from your citations. Better to give the citation root than invent a deep path that 404s.
  - servicesSummary: 2-3 sentence summary of the services this department offers and what they actually do — e.g. "Manages municipal infrastructure projects: roads, drainage, water/sewer networks, traffic studies, bridges. Reviews engineering submittals from developers and oversees public-works tenders." Be specific to this municipality based on the source page; don't write a generic description.
  - notes: any extra context (e.g. "interim director", "shared phone with planning").

CRITICAL rules:
  - Only Canadian municipalities. Reject anything outside ${province}.
  - Only publicly-listed contacts. No personal cells, no unverified emails.
  - Do not invent. If you cannot verify a field on the source page, use empty string.
  - Each contact must be a different person OR the same person at a different role/department only if both are public.
  - Be exhaustive across municipalities — don't return ${count} contacts all from one big city; spread across the province where the count permits.

Return JSON: { "contacts": [{ municipalityName, municipalityType, department, role, name, email, phone, address, website, sourceUrl, notes }] }`;
}

function nullIfEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

/**
 * Deduplication key for municipal contacts. Same person at a different role,
 * or different people at the same role in one municipality, each count as
 * separate leads. Unicode-folded so accent variants merge.
 */
function dedupKeyOf(
  municipalityName: string | null | undefined,
  role: string | null | undefined,
): string {
  const fold = (s: string | null | undefined) =>
    (s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return `${fold(municipalityName)}::${fold(role)}`;
}

/**
 * Compose the "DO NOT include these municipalities" block injected into both
 * the strict and free-form prompts. Keeps the prompt budget under control
 * by truncating to the first N alphabetically (so successive sweeps see a
 * stable list and don't oscillate).
 */
function buildExcludeBlock(excluded: string[] | undefined): string {
  if (!excluded || excluded.length === 0) return "";
  const sample = [...excluded].sort().slice(0, 80);
  return `\n\nDO NOT return contacts from these municipalities — they are already in the directory: ${sample.join(", ")}${excluded.length > sample.length ? `, …and ${excluded.length - sample.length} more` : ""}. Pick OTHER municipalities. Smaller cities, towns, villages, MRC seats, and agglomeration members are all fair game.\n`;
}

// Pass B prompt — no JSON schema, just an explicit example block. We parse
// the JSON ourselves from the model's reply. Use this when schema mode
// returns []; common with Quebec (French sources) and other queries where
// strict whitelisting trips the model into a fast-bail.
function buildFreeFormPrompt(args: {
  province: string;
  scopeText: string;
  sectors: string[];
  cityFilter: string | null;
  count: number;
  excludedMunicipalities?: string[];
}): string {
  const { province, scopeText, sectors, cityFilter, count, excludedMunicipalities } = args;
  const excludeBlock = buildExcludeBlock(excludedMunicipalities);

  const sectorPreference =
    sectors.length === 0
      ? `Focus on engineering and administration leads where available, but accept any public contact you can verify.`
      : `Prefer contacts in: ${sectors
          .map((c) => SECTOR_OPTIONS.find((s) => s.code === c)?.label ?? c)
          .join(", ")}. If a municipality has none in those sectors, return its closest equivalent (e.g. infrastructure → engineering, mayor's office → administration). Do not return empty — return your best effort.`;

  const bilingualNote =
    province === "Quebec"
      ? `Quebec municipalities use French labels: "Service du génie", "Travaux publics", "Greffier(ère)", "Maire", "Directeur général". Search for those terms too.`
      : province === "New Brunswick"
        ? "New Brunswick is bilingual — search both English and French municipal directories."
        : "";

  return `Find up to ${count} public municipal contacts in ${province}, Canada${
    cityFilter
      ? ` with a focus on the municipality named "${cityFilter}"`
      : ""
  }.
${excludeBlock}
Scope: ${scopeText}.
${sectorPreference}

Search BOTH English and French municipal websites. ${bilingualNote}

Take your time. Visit each municipality's directory page. Each contact must have a real sourceUrl you visited.

Output FORMAT (must be exactly this — a fenced JSON block):

\`\`\`json
{
  "contacts": [
    {
      "municipalityName": "Ville de Saint-Hyacinthe",
      "municipalityType": "city",
      "department": "Service du génie",
      "role": "Directeur du génie",
      "name": "...",
      "email": "...",
      "phone": "...",
      "address": "...",
      "website": "...",
      "sourceUrl": "...",
      "servicesSummary": "2-3 sentence summary of services this department offers and what they do",
      "notes": ""
    }
  ]
}
\`\`\`

Empty string is acceptable for ANY field you can't verify on the source — EXCEPT servicesSummary, which should always be filled with a specific 2-3 sentence description of the department's actual services. Spread across multiple municipalities — don't return all ${count} from one big city.`;
}
