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

  // Build the Perplexity prompt — explicit about only Canada, only public
  // contacts, only the requested scope, and the sectors we want filled.
  const userPrompt = buildPerplexityPrompt({
    province,
    scopeText,
    sectors,
    cityFilter,
    count,
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

  const r = await perplexityChat<{ contacts: PerplexityContact[] }>({
    systemPrompt:
      "You are a public-records research assistant. Return only valid JSON matching the schema. Use ONLY publicly-listed municipal contacts (city hall directories, official .ca / .gov.qc.ca pages). Do not include personal cell numbers or unverified emails.",
    userPrompt,
    schema: PERPLEXITY_SCHEMA,
    schemaName: "municipal_contacts",
    maxTokens,
    // Light bias toward .ca and .gouv domains — Perplexity treats this as
    // a hint, not a hard filter.
    searchDomains: ["ca", "gouv.qc.ca", "gc.ca"],
  });

  const rawContacts = r.content?.contacts ?? [];
  if (!rawContacts.length) {
    throw new Error(
      "Perplexity returned no contacts. Try a broader scope or smaller count.",
    );
  }

  // Claude normalizes + categorizes (or keyword fallback if Claude is down).
  const categorized = await categorizeWithClaude(rawContacts);

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

  if (categorized.length > 0) {
    await db.insert(municipalityContacts).values(
      categorized.map((c) => ({
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
        notes: nullIfEmpty(c.notes),
      })),
    );
  }

  revalidatePath("/tools/municipal-contacts");
  return {
    searchId: searchRow.id,
    contactCount: categorized.length,
    citations: r.citations ?? [],
  };
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
}): string {
  const { province, scopeText, sectors, cityFilter, count } = args;

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

  return `Find ${count} verified public contacts for municipalities in ${province}, Canada${
    cityFilter
      ? ` (focus on the municipality named "${cityFilter}" — return contacts only for that municipality and its closest neighbours)`
      : ""
  }.

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
  - website: the municipality's website (homepage URL).
  - sourceUrl: the exact page where you found this contact.
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
