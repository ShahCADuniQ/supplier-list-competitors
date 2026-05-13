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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  municipalitySearches,
  municipalityContacts,
  municipalityContactExports,
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

export type GenerateResult =
  | {
      ok: true;
      searchId: number;
      contactCount: number;
      citations: string[];
    }
  | {
      ok: false;
      error: string;
      stack?: string;
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
  // Cache the system prompt + tool schema so back-to-back generations (and
  // model retries within this same call) read the prefix at 10% of normal
  // input cost. Anthropic skips the cache write when the cached prefix is
  // under the model minimum (~1024 tokens), so this is a no-op for short
  // prompts and a real saving once the system prompt grows.
  const cachedTools = tools.map((t, i, arr) =>
    i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
  );
  for (const model of models) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 8000,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
        tools: cachedTools,
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
// STREAMING-FRIENDLY ACTIONS
//
// The original generateMunicipalContacts ran the full pipeline (Perplexity
// → verify → insert) in one server action. That made cancel slow and meant
// the UI couldn't show contacts as they came in. The per-contact path
// below splits the work into two cheap actions the client orchestrates:
//
//   1. fetchMunicipalCandidates(input) — one Perplexity call, returns raw
//      candidates + citations + canonical search id. Slow (5-30 s) but
//      runs once per batch.
//   2. verifyAndInsertOneContact({ candidate, citations, searchId,
//      province }) — verifies URLs, repairs broken sourceUrl/website,
//      gates, dedupes against the DB, inserts. Fast (~1-3 s).
//
// Client loops fetchMunicipalCandidates → for each candidate calls
// verifyAndInsertOneContact → router.refresh() → next contact.
//
// Cancel between contact-inserts feels instant (1-3 s wait, not 30-60 s),
// and each successful insert immediately shows up in the grid.
// ─────────────────────────────────────────────────────────────────────────────

export type FetchCandidatesResult =
  | {
      ok: true;
      candidates: PerplexityContact[];
      citations: string[];
      searchId: number;
      existingKeys: string[]; // pre-populated dedup set for the client
    }
  | { ok: false; error: string };

export async function fetchMunicipalCandidates(
  input: GenerateInput,
): Promise<FetchCandidatesResult> {
  try {
    const profile = await getOrCreateProfile();
    if (!profile) throw new Error("Sign in required");
    if (!canEdit(profile)) throw new Error("Insufficient permissions");
    if (!hasPerplexityKey()) {
      throw new Error("PERPLEXITY_API_KEY (or PPLX_API_KEY) is not set on this server.");
    }

    const province = input.province.trim();
    if (!province) throw new Error("Province is required");
    const count = clampCount(input.count);
    const scopeTypes = (input.scopeTypes ?? []).filter(Boolean);
    const scopeText = scopeTypeText(scopeTypes);
    const sectors = (input.sectors ?? []).filter((s) => ALL_SECTOR_CODES.includes(s));
    const cityFilter = (input.cityFilter ?? "").trim() || null;

    // Existing-keys + excluded-municipalities for dedupe + prompt biasing.
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

    const userPrompt = buildPerplexityPrompt({
      province,
      scopeText,
      sectors,
      cityFilter,
      count,
      excludedMunicipalities: [...existingMunicipalities],
    });
    const maxTokens = Math.min(32_000, 1500 + count * 180);
    const systemPrompt =
      "You are a public-records research assistant for Canadian municipalities. Take time to actually search the web for each municipality before answering. Search BOTH English and French municipal websites. Use ONLY publicly-listed municipal contacts. Spread contacts across multiple municipalities.";

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
    } catch (e) {
      console.warn("[municipal-contacts] Pass A failed:", e);
    }

    if (rawContacts.length === 0) {
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
          maxTokens,
        });
        const text = passB.content ?? "";
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]) as { contacts?: PerplexityContact[] };
            rawContacts = parsed.contacts ?? [];
            citations = passB.citations ?? citations;
          } catch (e) {
            console.warn("[municipal-contacts] Pass B parse failed:", e);
          }
        }
      } catch (e) {
        console.warn("[municipal-contacts] Pass B failed:", e);
      }
    }

    // Filter dupes upfront so the client doesn't waste verify calls on
    // contacts we already know we'd skip.
    const fresh = rawContacts.filter(
      (c) => !existingKeys.has(dedupKeyOf(c.municipalityName, c.role)),
    );

    // Find / create the canonical search row so the client can pass its id
    // to verifyAndInsertOneContact.
    const canonicalTitlePrefix = `${province} municipalities — comprehensive lead list`;
    const existingCanonical = await db
      .select()
      .from(municipalitySearches)
      .where(
        and(
          eq(municipalitySearches.province, province),
          sql`${municipalitySearches.title} LIKE ${`${canonicalTitlePrefix}%`}`,
        ),
      )
      .orderBy(asc(municipalitySearches.id))
      .limit(1);

    let searchId: number;
    if (existingCanonical.length > 0) {
      searchId = existingCanonical[0].id;
    } else {
      const [created] = await db
        .insert(municipalitySearches)
        .values({
          country: "Canada",
          province,
          scopeTypes: scopeTypes.length ? scopeTypes.join(",") : "all",
          sectors: sectors.length ? sectors.join(",") : "all",
          cityFilter,
          requestedCount: count,
          title: canonicalTitlePrefix,
          notes: (input.notes ?? "").trim() || null,
          createdByClerkId: profile.clerkUserId,
        })
        .returning();
      searchId = created.id;
    }

    return {
      ok: true,
      candidates: fresh,
      citations,
      searchId,
      existingKeys: [...existingKeys],
    };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error("[municipal-contacts] fetchCandidates failed:", msg);
    return { ok: false, error: msg };
  }
}

export type VerifyAndInsertResult =
  | { ok: true; inserted: false; reason: string }
  | {
      ok: true;
      inserted: true;
      contact: typeof municipalityContacts.$inferSelect;
      total: number; // total in canonical row after this insert
    }
  | { ok: false; error: string };

export async function verifyAndInsertOneContact(input: {
  candidate: PerplexityContact;
  citations: string[];
  searchId: number;
  province: string;
}): Promise<VerifyAndInsertResult> {
  try {
    const profile = await getOrCreateProfile();
    if (!profile) throw new Error("Sign in required");
    if (!canEdit(profile)) throw new Error("Insufficient permissions");

    const c = input.candidate;
    if (!c.municipalityName?.trim()) {
      return { ok: true, inserted: false, reason: "missing municipality" };
    }

    // Dedupe against the live DB — handles the race where another batch
    // inserted this same contact between fetch and verify.
    const dupKey = dedupKeyOf(c.municipalityName, c.role);
    const dupRow = await db
      .select({ id: municipalityContacts.id })
      .from(municipalityContacts)
      .where(eq(municipalityContacts.province, input.province))
      .limit(200);
    for (const r of dupRow) {
      // Re-check via dedup key. (We could narrow at SQL level but the
      // province scope is small enough.)
      // (skip this row's check inline to keep the query simple)
      void r;
    }
    // Simpler: dedup-check at SQL level via lower-name match.
    const sameNameRows = await db
      .select({
        id: municipalityContacts.id,
        municipalityName: municipalityContacts.municipalityName,
        role: municipalityContacts.role,
      })
      .from(municipalityContacts)
      .where(
        and(
          eq(municipalityContacts.province, input.province),
          sql`lower(${municipalityContacts.municipalityName}) = lower(${c.municipalityName.trim()})`,
        ),
      );
    for (const row of sameNameRows) {
      if (dedupKeyOf(row.municipalityName, row.role) === dupKey) {
        return { ok: true, inserted: false, reason: "duplicate" };
      }
    }

    // URL verify + repair + classify, all on this single contact.
    const allUrls = [
      ...(c.sourceUrl ? [c.sourceUrl] : []),
      ...(c.website ? [c.website] : []),
      ...input.citations,
    ];
    const status = await verifyUrlsForOneContact(allUrls);

    let sourceUrl = c.sourceUrl?.trim() || "";
    let website = c.website?.trim() || "";
    if (sourceUrl && !status.get(sourceUrl)) {
      sourceUrl = bestCitationFor(c.municipalityName, input.citations, status) ?? "";
    }
    if (website && !status.get(website)) {
      try {
        const host = new URL(website).host;
        const root = `https://${host}/`;
        if (status.get(root)) website = root;
        else {
          let pick = "";
          for (const u of input.citations) {
            if (!status.get(u)) continue;
            try {
              if (new URL(u).host === host) { pick = u; break; }
            } catch { /* skip */ }
          }
          website = pick;
        }
      } catch { website = ""; }
    }

    // Run a one-record Claude classify pass so the inserted row lands in
    // the right sector. Cheap (~1-2 s) and keeps the UI's category chips
    // accurate without a batch normalize step.
    const classified = await classifyOneContactWithClaude({ ...c, sourceUrl, website });

    const [inserted] = await db
      .insert(municipalityContacts)
      .values({
        searchId: input.searchId,
        municipalityName: c.municipalityName.trim(),
        municipalityType: nullIfEmpty(c.municipalityType),
        province: input.province,
        department: nullIfEmpty(c.department),
        role: nullIfEmpty(c.role),
        category: classified.category,
        name: nullIfEmpty(c.name),
        email: nullIfEmpty(c.email),
        phone: nullIfEmpty(c.phone),
        address: nullIfEmpty(c.address),
        website: nullIfEmpty(website),
        sourceUrl: nullIfEmpty(sourceUrl),
        servicesSummary: nullIfEmpty(c.servicesSummary),
        notes: nullIfEmpty(c.notes),
      })
      .returning();

    // Refresh canonical title incrementally — adds 1 to the count after
    // each insert so the saved-searches strip stays in sync as the run
    // progresses.
    const totalRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(municipalityContacts)
      .where(eq(municipalityContacts.searchId, input.searchId));
    const total = totalRow[0]?.c ?? 0;
    const canonicalTitlePrefix = `${input.province} municipalities — comprehensive lead list`;
    await db
      .update(municipalitySearches)
      .set({
        title: `${canonicalTitlePrefix} (${total} verified)`,
        requestedCount: total,
        updatedAt: new Date(),
      })
      .where(eq(municipalitySearches.id, input.searchId));

    revalidatePath("/crm/municipal-contacts");
    return { ok: true, inserted: true, contact: inserted, total };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error("[municipal-contacts] verifyAndInsertOne failed:", msg);
    return { ok: false, error: msg };
  }
}

// Lightweight URL-verification helper used by the per-contact action.
// Mirrors verifyContactUrls but stays public-API-friendly for one record.
async function verifyUrlsForOneContact(urls: string[]): Promise<Map<string, boolean>> {
  const distinct = [...new Set(urls.filter(Boolean))];
  const status = new Map<string, boolean>();
  await Promise.all(distinct.map(async (u) => status.set(u, await checkUrl(u))));
  return status;
}

// One-shot Claude classifier — keeps the per-contact path independent of
// the batch categorizeWithClaude. Falls back to the keyword bucket if
// Claude isn't reachable.
async function classifyOneContactWithClaude(
  c: PerplexityContact,
): Promise<{ category: string }> {
  if (!hasClaudeKey()) return { category: keywordCategory(c) };
  try {
    const client = claudeClient();
    const sectorBullets = SECTOR_OPTIONS.map(
      (s) => `  • "${s.code}" — ${s.promptHint}`,
    ).join("\n");
    const tools = [{
      name: "classify_contact",
      description: "Pick the best sector code for one contact.",
      input_schema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          category: { type: "string", enum: [...ALL_SECTOR_CODES] },
        },
        required: ["category"],
      },
    }];
    const models = [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS];
    // System + tools are identical for every contact in a generation run.
    // Marking them ephemeral lets Anthropic serve them from cache on the
    // 2nd…Nth contact (subject to the model's prefix-minimum). Saves a
    // significant share of tokens on a 100-contact streamed run.
    const cachedTools = tools.map((t, i, arr) =>
      i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
    );
    for (const model of models) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 200,
          system: [
            {
              type: "text",
              text: `Pick the BEST single sector code for this Canadian municipal contact, from this set:\n${sectorBullets}`,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            { role: "user", content: `Department: ${c.department}\nRole: ${c.role}\nNotes: ${c.notes}` },
          ],
          tools: cachedTools,
          tool_choice: { type: "tool", name: "classify_contact" },
        });
        const block = res.content.find(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );
        if (block) {
          return block.input as { category: string };
        }
      } catch (e) {
        console.warn(`[municipal-contacts] classifyOne ${model} failed:`, e);
      }
    }
  } catch (e) {
    console.warn("[municipal-contacts] classifyOne fully failed:", e);
  }
  return { category: keywordCategory(c) };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY — generate + persist
// ─────────────────────────────────────────────────────────────────────────────

export async function generateMunicipalContacts(
  input: GenerateInput,
): Promise<GenerateResult> {
  // Returns the error as DATA instead of throwing, so the production-mode
  // server-action error sanitizer doesn't rewrite our message into the
  // generic "Server Components render" string. The client checks `ok` and
  // displays `error` directly.
  try {
    return await generateMunicipalContactsImpl(input);
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error(
      "[municipal-contacts] generation failed:",
      `${name}: ${message}\n${stack ?? "(no stack)"}`,
    );
    return {
      ok: false,
      error: `${name}: ${message}`,
      stack,
    };
  }
}

// Internal worker that throws on error. Wrapper above turns thrown errors
// into a `{ ok: false, error }` so they survive Next's prod sanitizer.
async function generateMunicipalContactsImpl(
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

  // Per-record services_summary follow-up calls were ~5-15 s each and could
  // easily blow past Vercel's serverless function timeout (60 s on Hobby,
  // 300 s on Pro) when generating 25+ contacts at once. We now rely on
  // whatever Perplexity returned in the main pass; the comprehensive CLI
  // sweep (`scripts/lead-quebec-comprehensive.ts`) keeps the per-record
  // fill since it runs without a wall-clock cap. If a record came back with
  // a thin / empty summary it stays that way — the user can still see the
  // role + department + source URL, and the next sweep will likely pick it
  // up with a fuller summary.
  // Removed: await fillMissingServicesSummaries(verified);

  // ── Canonical search row ──
  // All generations for a given province get folded into a single
  // "<Province> municipalities — comprehensive lead list" row so the user
  // sees one growing directory per province instead of N saved searches.
  // Reuse the existing canonical row when present; otherwise create it.
  const canonicalTitlePrefix = `${province} municipalities — comprehensive lead list`;
  const existingCanonical = await db
    .select()
    .from(municipalitySearches)
    .where(
      and(
        eq(municipalitySearches.province, province),
        sql`${municipalitySearches.title} LIKE ${`${canonicalTitlePrefix}%`}`,
      ),
    )
    .orderBy(asc(municipalitySearches.id))
    .limit(1);

  let searchRow: typeof municipalitySearches.$inferSelect;
  if (existingCanonical.length > 0) {
    searchRow = existingCanonical[0];
    console.log(`[municipal-contacts] appending to canonical search #${searchRow.id}`);
  } else {
    [searchRow] = await db
      .insert(municipalitySearches)
      .values({
        country: "Canada",
        province,
        scopeTypes: scopeTypes.length ? scopeTypes.join(",") : "all",
        sectors: sectors.length ? sectors.join(",") : "all",
        cityFilter,
        requestedCount: count,
        title: canonicalTitlePrefix,
        notes: (input.notes ?? "").trim() || null,
        createdByClerkId: profile.clerkUserId,
      })
      .returning();
    console.log(`[municipal-contacts] created canonical search #${searchRow.id}`);
  }

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

  // Refresh the canonical title with the post-insert total so the saved-
  // searches strip always shows accurate counts.
  const totalRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(municipalityContacts)
    .where(eq(municipalityContacts.searchId, searchRow.id));
  const total = totalRow[0]?.c ?? 0;
  await db
    .update(municipalitySearches)
    .set({
      title: `${canonicalTitlePrefix} (${total} verified)`,
      requestedCount: total,
      updatedAt: new Date(),
    })
    .where(eq(municipalitySearches.id, searchRow.id));

  revalidatePath("/crm/municipal-contacts");
  return {
    ok: true,
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

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT EXPORT — per-user tracking
//
// Generates a CSV in HubSpot's expected contact-import shape. Each user has
// their own "what have I exported?" state stored in
// `municipality_contact_exports`, so user A pulling the full directory
// doesn't change what user B sees as "new". Three modes:
//
//   • mode: "new" — only rows the CURRENT user hasn't exported yet. The
//                   most-common path: re-runnable as the directory grows,
//                   only ships the diff for this user.
//   • mode: "all" — every contact in the search. Marks them as exported
//                   for the current user too (so the next "new" export
//                   shows nothing). Use to re-import the full list.
//   • mode: "everything" — every contact in the search, but DOES NOT
//                   change export state. For "give me everything for an
//                   ad-hoc spreadsheet" without affecting future "new"
//                   counts.
//
// HubSpot column names follow the "Default contact properties" import spec:
// First Name, Last Name, Email, Phone Number, Job Title, Company, Website,
// Address, City, State/Region, Country/Region, Lead Source, plus custom
// properties for Department / Services Description / Source URL /
// Municipality Type / Sector / Notes.
// ─────────────────────────────────────────────────────────────────────────────

export type HubspotExportMode = "new" | "all" | "everything";

export type HubspotExportInput = {
  searchId: number;
  mode: HubspotExportMode;
};

export type HubspotExportResult = {
  csv: string;
  fileName: string;
  exportedCount: number;
  totalInSearch: number;
  newRemaining: number;
};

export async function exportToHubspot(
  input: HubspotExportInput,
): Promise<HubspotExportResult> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");

  // Pull the rows. For "new" mode, exclude any contact this user has
  // already exported. "all" and "everything" both pull every row in the
  // search; they differ only in whether we stamp the export afterward.
  const myExports = await db
    .select({ contactId: municipalityContactExports.contactId })
    .from(municipalityContactExports)
    .where(eq(municipalityContactExports.clerkUserId, profile.clerkUserId));
  const myExportedIds = new Set(myExports.map((e) => e.contactId));

  const allRows = await db
    .select()
    .from(municipalityContacts)
    .where(eq(municipalityContacts.searchId, input.searchId))
    .orderBy(
      asc(municipalityContacts.municipalityName),
      asc(municipalityContacts.id),
    );

  const rows =
    input.mode === "new"
      ? allRows.filter((r) => !myExportedIds.has(r.id))
      : allRows;

  const totalInSearch = allRows.length;

  if (rows.length === 0) {
    return {
      csv: "",
      fileName: "",
      exportedCount: 0,
      totalInSearch,
      newRemaining: allRows.length - myExportedIds.size,
    };
  }

  const csv = buildHubspotCsv(rows);
  const exportedAt = new Date();

  // "everything" mode is the only one that doesn't update export state.
  if (input.mode !== "everything") {
    // Upsert the per-user export rows. ON CONFLICT (contact_id, clerk_user_id)
    // refreshes exported_at — useful when re-exporting the full list so the
    // user can see "last exported on …" in the UI later.
    if (rows.length > 0) {
      await db
        .insert(municipalityContactExports)
        .values(
          rows.map((r) => ({
            contactId: r.id,
            clerkUserId: profile.clerkUserId,
            exportedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            municipalityContactExports.contactId,
            municipalityContactExports.clerkUserId,
          ],
          set: { exportedAt },
        });
    }

    // Also update the legacy `municipality_contacts.exported_at` column so
    // any older code path (or a SQL viewer) still sees a timestamp. This is
    // informational only — the per-user table is the source of truth.
    await db
      .update(municipalityContacts)
      .set({ exportedAt })
      .where(inArray(municipalityContacts.id, rows.map((r) => r.id)));
  }

  const stamp = exportedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `hubspot-municipal-contacts-search-${input.searchId}-${input.mode}-${stamp}.csv`;

  revalidatePath("/crm/municipal-contacts");

  // Recompute remaining-new for THIS user after the operation.
  let newRemaining = 0;
  if (input.mode === "everything") {
    newRemaining = allRows.length - myExportedIds.size;
  } else {
    // After "new" or "all", everything we just shipped is now exported for
    // this user — so remaining-new is whatever wasn't included this time.
    newRemaining = 0;
  }

  return {
    csv,
    fileName,
    exportedCount: rows.length,
    totalInSearch,
    newRemaining,
  };
}

/**
 * Build a HubSpot-import-ready CSV from a contact list. Each row is a
 * single contact (one person + their municipal context). HubSpot's contact
 * import will create both a Contact and (if Company Name + Domain are set)
 * an associated Company record.
 */
function buildHubspotCsv(
  rows: Array<typeof municipalityContacts.$inferSelect>,
): string {
  const headers = [
    "First Name",
    "Last Name",
    "Email",
    "Phone Number",
    "Job Title",
    "Company",
    "Website",
    "Address",
    "City",
    "State/Region",
    "Country/Region",
    "Lead Source",
    "Department",
    "Services Description",
    "Source URL",
    "Municipality Type",
    "Sector",
    "Notes",
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];

  for (const r of rows) {
    const { firstName, lastName } = splitName(r.name);
    const { city, region, country } = splitAddress(r.address, r.province);
    const company = (r.municipalityName ?? "").trim();
    const phone = formatPhone(r.phone);
    const email = (r.email ?? "").trim();
    const role = (r.role ?? "").trim();
    const dept = (r.department ?? "").trim();
    const services = (r.servicesSummary ?? "").trim();
    const source = (r.sourceUrl ?? "").trim();
    const website = (r.website ?? "").trim();
    const muniType = (r.municipalityType ?? "").trim();
    const category = (r.category ?? "").trim();
    const notes = (r.notes ?? "").trim();

    lines.push(
      [
        firstName,
        lastName,
        email,
        phone,
        role,
        company,
        website,
        // Address: fall back to the raw `address` string if we can't split.
        r.address ?? "",
        city,
        region,
        country,
        "Lightbase municipal lead generator",
        dept,
        services,
        source,
        muniType,
        category,
        notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // CRLF line endings — HubSpot's CSV importer is Excel-friendly, prefers
  // \r\n + UTF-8 BOM. Add the BOM so accented French names (Greffier,
  // Saint-Hyacinthe) render correctly in Excel before re-saving.
  const BOM = "﻿";
  return BOM + lines.join("\r\n") + "\r\n";
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // HubSpot tolerates quoted multiline values; we always quote to be safe.
  return `"${s.replace(/"/g, '""')}"`;
}

function splitName(full: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const t = (full ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { firstName: "", lastName: "" };
  // French ordering is the same as English (Prénom Nom), but accented and
  // hyphenated last names are common ("Saint-Pierre", "Lajoie-Bergeron").
  // Take the first whitespace-separated token as first name, the rest as
  // last name. Single-word entries (e.g. "Direction générale") become the
  // last name only.
  const parts = t.split(" ");
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function splitAddress(
  address: string | null | undefined,
  fallbackProvince: string,
): { city: string; region: string; country: string } {
  // We don't try to parse the street out of free-form addresses — HubSpot's
  // import accepts the full address in the "Address" column and only needs
  // City / State / Country split for filtering. Best-effort:
  //   "275 Rue Notre-Dame Est, Montréal, QC H2Y 1C6"
  //   "1085, rue de la Concorde, Saint-Hyacinthe (Québec) J2S 5W3"
  if (!address) {
    return { city: "", region: fallbackProvince, country: "Canada" };
  }
  const t = address.trim();
  // Pull the postal code (e.g., "H2Y 1C6") to anchor the right-side split
  const cityMatch = t.match(/,\s*([A-Za-zÀ-ÿ\s'-]+?)(?:,|\s*\(|\s+[A-Z]{2}\b|\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d)/);
  const city = cityMatch ? cityMatch[1].trim() : "";
  return { city, region: fallbackProvince, country: "Canada" };
}

function formatPhone(p: string | null | undefined): string {
  // HubSpot tolerates any human-readable form. Strip cruft (extension labels,
  // duplicated parentheses) and standardize separators.
  if (!p) return "";
  return p.trim().replace(/\s+/g, " ");
}

/**
 * Per-user export status for a search. Drives the export button labels —
 * "↓ HubSpot — N new" when there are unexported leads for this user, etc.
 * Each user has independent state.
 */
export async function getHubspotExportStatus(searchId: number): Promise<{
  total: number;
  exported: number;
  notExported: number;
  lastExportedAt: Date | null;
}> {
  const profile = await getOrCreateProfile();
  if (!profile) {
    // Anonymous viewer (shouldn't normally happen on this page) — every
    // contact looks "new" because they have no per-user state.
    const total = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(municipalityContacts)
      .where(eq(municipalityContacts.searchId, searchId));
    const t = total[0]?.c ?? 0;
    return { total: t, exported: 0, notExported: t, lastExportedAt: null };
  }

  const contactRows = await db
    .select({ id: municipalityContacts.id })
    .from(municipalityContacts)
    .where(eq(municipalityContacts.searchId, searchId));
  const total = contactRows.length;
  if (total === 0) {
    return { total: 0, exported: 0, notExported: 0, lastExportedAt: null };
  }
  const ids = contactRows.map((c) => c.id);
  const exports = await db
    .select({
      contactId: municipalityContactExports.contactId,
      exportedAt: municipalityContactExports.exportedAt,
    })
    .from(municipalityContactExports)
    .where(
      and(
        eq(municipalityContactExports.clerkUserId, profile.clerkUserId),
        inArray(municipalityContactExports.contactId, ids),
      ),
    );
  let lastAt: Date | null = null;
  for (const e of exports) {
    if (!lastAt || e.exportedAt > lastAt) lastAt = e.exportedAt;
  }
  return {
    total,
    exported: exports.length,
    notExported: total - exports.length,
    lastExportedAt: lastAt,
  };
}

export async function deleteMunicipalitySearch(searchId: number): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  if (!canEdit(profile)) throw new Error("Insufficient permissions");
  await db
    .delete(municipalitySearches)
    .where(eq(municipalitySearches.id, searchId));
  revalidatePath("/crm/municipal-contacts");
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
  revalidatePath("/crm/municipal-contacts");
}

/**
 * Bulk-delete every contact in a given category (e.g. all "police" or all
 * "elected") within a search. Returns the number of rows removed so the UI
 * can show "Removed 7 Elected officials" in its toast. After deletion, the
 * canonical search row's title + count is refreshed in step.
 */
export async function deleteContactsByCategory(input: {
  searchId: number;
  category: string;
}): Promise<{ deleted: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  if (!canEdit(profile)) throw new Error("Insufficient permissions");

  const deleted = await db
    .delete(municipalityContacts)
    .where(
      and(
        eq(municipalityContacts.searchId, input.searchId),
        eq(municipalityContacts.category, input.category),
      ),
    )
    .returning({ id: municipalityContacts.id });

  // Keep the canonical "(N verified)" title in sync after a bulk delete.
  const totalRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(municipalityContacts)
    .where(eq(municipalityContacts.searchId, input.searchId));
  const total = totalRow[0]?.c ?? 0;
  // Find the search row to determine if it follows the canonical title shape.
  const [search] = await db
    .select()
    .from(municipalitySearches)
    .where(eq(municipalitySearches.id, input.searchId))
    .limit(1);
  if (search) {
    const titlePrefix = `${search.province} municipalities — comprehensive lead list`;
    if (search.title?.startsWith(titlePrefix)) {
      await db
        .update(municipalitySearches)
        .set({
          title: `${titlePrefix} (${total} verified)`,
          requestedCount: total,
          updatedAt: new Date(),
        })
        .where(eq(municipalitySearches.id, input.searchId));
    }
  }

  revalidatePath("/crm/municipal-contacts");
  return { deleted: deleted.length };
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
