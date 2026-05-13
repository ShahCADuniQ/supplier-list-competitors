// End-to-end test for the Municipal Contacts tool. Bypasses Clerk auth and
// runs two real Perplexity + Claude generations, prints what each model
// returned, and inserts the results into the live DB so they show up at
// /crm/municipal-contacts.
//
// Usage:
//   npx tsx --env-file=.env scripts/test-municipal-contacts.ts

import { neon } from "@neondatabase/serverless";
import {
  perplexityChat,
  hasPerplexityKey,
} from "../src/lib/ai/perplexity";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "../src/lib/ai/claude";
import { SECTOR_OPTIONS, ALL_SECTOR_CODES } from "../src/app/crm/municipal-contacts/constants";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

if (!hasPerplexityKey()) {
  console.error("PERPLEXITY_API_KEY (or PPLX_API_KEY) not set");
  process.exit(1);
}

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
        },
        required: [
          "municipalityName","municipalityType","department","role","name",
          "email","phone","address","website","sourceUrl","notes",
        ],
      },
    },
  },
  required: ["contacts"],
};

function buildPerplexityPrompt(args: {
  province: string;
  scopeText: string;
  sectors: string[];
  count: number;
}): string {
  const { province, scopeText, sectors, count } = args;
  const sectorBlock =
    sectors.length === 0
      ? `Sectors of interest (no hard filter):
  1. Engineering / génie municipal
  2. Public Works / Travaux publics
  3. Administration
  4. Other relevant departments`
      : `Sectors REQUESTED (return contacts for these sectors only — exclude every other department):
${sectors
  .map((code, i) => {
    const opt = SECTOR_OPTIONS.find((s) => s.code === code);
    return `  ${i + 1}. ${opt?.label ?? code} — ${opt?.promptHint ?? ""}`;
  })
  .join("\n")}

If a municipality has no contact in any of the requested sectors, skip it and pick the next municipality.`;

  const bilingualNote =
    province === "Quebec"
      ? `IMPORTANT: Quebec municipal websites are in French. Search BOTH languages — French department names like "Service du génie", "Travaux publics", "Greffier(ère)", "Directeur général", "Maire" are equally valid sources to the English equivalents. Many municipalities only publish their directories in French.`
      : "";

  return `Find ${count} verified public contacts for municipalities in ${province}, Canada.

${bilingualNote}

Scope: ${scopeText}.

${sectorBlock}

For each contact, return:
  - municipalityName: the municipality name as written on its website (e.g. "Ville de Saint-Hyacinthe").
  - municipalityType: "city" / "town" / "village" / "municipality" (best guess).
  - department: department name as listed.
  - role: official title.
  - name: full name if listed publicly. Empty string if directory only lists the role.
  - email: official email. Empty string if unlisted.
  - phone: main phone. Empty string if unlisted.
  - address: city hall / department mailing address. Empty string if not on the source.
  - website: the municipality's homepage URL.
  - sourceUrl: the exact page where you found this contact.
  - notes: any extra context.

CRITICAL rules:
  - Only Canadian municipalities. Reject anything outside ${province}.
  - Only publicly-listed contacts. No personal cells.
  - Do not invent. If you cannot verify a field on the source page, use empty string.
  - Be exhaustive across municipalities — spread across ${province} where the count permits.

Return JSON: { "contacts": [{ municipalityName, municipalityType, department, role, name, email, phone, address, website, sourceUrl, notes }] }`;
}

async function runOne(args: {
  province: string;
  sectors: string[];
  count: number;
  title: string;
  scopeTypes?: string[];
}): Promise<{ searchId: number; contactCount: number }> {
  const { province, sectors, count, title } = args;
  const scopeTypes = args.scopeTypes ?? [];
  const scopeText = scopeTypes.length === 0
    ? "cities, towns, villages, and other municipalities"
    : scopeTypes.join(", ");

  console.log(`\n━━━ "${title}" ━━━`);
  console.log(`  province=${province}  sectors=${sectors.join(",") || "all"}  count=${count}`);

  const userPrompt = buildPerplexityPrompt({
    province,
    scopeText,
    sectors,
    count,
  });
  const maxTokens = Math.min(32_000, 1500 + count * 180);

  const systemPrompt =
    "You are a public-records research assistant for Canadian municipalities. You take time to actually search the web for each municipality before answering. Search BOTH English and French municipal websites. Return your answer as a JSON code block. Use ONLY publicly-listed municipal contacts. Do not include personal cells.";

  // Try schema-mode first; if it returns 0 (fast bail), fall back to free-form
  // and parse the JSON out of the model's reply ourselves.
  console.log(`  → Pass A: schema mode`);
  const tA = Date.now();
  let r = await perplexityChat<{ contacts: PerplexityContact[] }>({
    systemPrompt,
    userPrompt,
    schema: PERPLEXITY_SCHEMA,
    schemaName: "municipal_contacts",
    maxTokens,
  });
  console.log(`    OK in ${Date.now() - tA}ms · citations=${(r.citations ?? []).length} · contacts=${r.content?.contacts?.length ?? 0}`);
  let raw = r.content?.contacts ?? [];

  if (raw.length === 0) {
    console.log(`  → Pass B: free-form (no JSON schema)`);
    const tB = Date.now();
    const freePrompt = `${userPrompt}

Output FORMAT (must be exactly this — a fenced JSON block):

\`\`\`json
{
  "contacts": [
    { "municipalityName": "...", "municipalityType": "city", "department": "...", "role": "...", "name": "...", "email": "...", "phone": "...", "address": "...", "website": "...", "sourceUrl": "...", "notes": "..." }
  ]
}
\`\`\`

Take your time. Visit municipal directory pages. Each contact must have a real sourceUrl you visited. Empty string is acceptable for ANY field you can't verify.`;
    const free = await perplexityChat<string>({
      systemPrompt,
      userPrompt: freePrompt,
      maxTokens,
    });
    console.log(`    OK in ${Date.now() - tB}ms · citations=${(free.citations ?? []).length}`);
    const text = free.content ?? "";
    // Extract first {...} JSON block.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as { contacts?: PerplexityContact[] };
        raw = parsed.contacts ?? [];
        console.log(`    parsed contacts=${raw.length}`);
        r = { content: parsed as any, citations: free.citations, searchResults: free.searchResults };
      } catch (e) {
        console.warn(`    JSON parse failed: ${(e as Error).message}`);
        console.log(`    raw response head: ${text.slice(0, 400)}`);
      }
    } else {
      console.log(`    no JSON block found in response.`);
      console.log(`    raw head: ${text.slice(0, 400)}`);
    }
  }
  if (raw.length > 0) {
    console.log(`  sample[0]: ${JSON.stringify(raw[0]).slice(0, 240)}…`);
  }

  // Categorize with Claude
  let categorized: Array<PerplexityContact & { category: string }> = [];
  if (raw.length > 0 && hasClaudeKey()) {
    try {
      const client = claudeClient();
      const sectorBullets = SECTOR_OPTIONS.map(
        (s) => `  • "${s.code}" — ${s.promptHint}`,
      ).join("\n");
      const tools = [{
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
                  category: { type: "string", enum: [...ALL_SECTOR_CODES] },
                },
                required: [
                  "municipalityName","municipalityType","department","role","name",
                  "email","phone","address","website","sourceUrl","notes","category",
                ],
              },
            },
          },
          required: ["contacts"],
        },
      }];
      const models = [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS];
      const SYSTEM_PROMPT = `You are normalizing a list of Canadian municipal contacts. For each input record, return one record with EVERY field plus a "category" chosen from this fixed set:\n${sectorBullets}\n\nPick the BEST single bucket. Trim and clean every field. Don't invent fields.`;
      const cachedTools = tools.map((t, i, arr) =>
        i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
      );
      let used = "";
      for (const model of models) {
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 8000,
            system: [
              { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
            ],
            messages: [{ role: "user", content: `Normalize and categorize:\n\n${JSON.stringify(raw, null, 2)}` }],
            tools: cachedTools,
            tool_choice: { type: "tool", name: "record_contacts" },
          });
          const block = res.content.find((b: any) => b.type === "tool_use") as any;
          if (!block) throw new Error("Claude did not call the tool");
          categorized = (block.input as { contacts: typeof categorized }).contacts;
          used = model;
          break;
        } catch (e) {
          console.warn(`  Claude ${model} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      console.log(`  Claude categorized ${categorized.length} via ${used}`);
    } catch (e) {
      console.warn(`  Claude categorization fully failed: ${e}`);
    }
  }
  if (categorized.length === 0 && raw.length > 0) {
    console.warn(`  Falling back to keyword categorization`);
    categorized = raw.map((c) => ({ ...c, category: keywordCategory(c) }));
  }

  // Insert into DB
  const inserted = (await sql.query(
    `INSERT INTO municipality_searches
       (country, province, scope_types, sectors, requested_count, title, created_by_clerk_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      "Canada",
      province,
      scopeTypes.length ? scopeTypes.join(",") : "all",
      sectors.length ? sectors.join(",") : "all",
      count,
      title,
      "script:test-municipal-contacts",
    ],
  )) as Array<{ id: number }>;
  const searchId = inserted[0].id;

  if (categorized.length > 0) {
    for (const c of categorized) {
      await sql.query(
        `INSERT INTO municipality_contacts
           (search_id, municipality_name, municipality_type, province,
            department, role, category, name, email, phone, address,
            website, source_url, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          searchId,
          c.municipalityName?.trim() || "Unknown",
          nullIfEmpty(c.municipalityType),
          province,
          nullIfEmpty(c.department),
          nullIfEmpty(c.role),
          c.category || "other",
          nullIfEmpty(c.name),
          nullIfEmpty(c.email),
          nullIfEmpty(c.phone),
          nullIfEmpty(c.address),
          nullIfEmpty(c.website),
          nullIfEmpty(c.sourceUrl),
          nullIfEmpty(c.notes),
        ],
      );
    }
  }
  console.log(`  ✓ inserted search #${searchId} with ${categorized.length} contacts`);
  return { searchId, contactCount: categorized.length };
}

function keywordCategory(c: PerplexityContact): string {
  const hay = `${c.department} ${c.role} ${c.notes}`.toLowerCase();
  if (/police/.test(hay)) return "police";
  if (/fire|incendie|emergency/.test(hay)) return "fire";
  if (/environment|sustainab|sanitation|recycl/.test(hay)) return "environment";
  if (/parks|parcs|recreation|loisirs/.test(hay)) return "parks";
  if (/planning|urbanisme|urbaniste|zoning/.test(hay)) return "planning";
  if (/engineer|génie|ingénieur|civil|traffic/.test(hay)) return "engineering";
  if (/public[\s-]?works|travaux[\s-]?publics|water|sewer|road|infrastructure|voirie/.test(hay)) return "public-works";
  if (/mayor|maire|councill?or|conseiller/.test(hay)) return "elected";
  if (/clerk|greffier|director[\s-]?general|directeur[\s-]?general|city[\s-]?manager|administrator|finance|hr/.test(hay)) return "administration";
  return "other";
}

function nullIfEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

async function main() {
  console.log("=== Municipal Contacts: 2-search test ===");

  const a = await runOne({
    province: "Quebec",
    sectors: ["engineering"],
    count: 10,
    title: "Quebec · Engineering · 10",
  });
  const b = await runOne({
    province: "Ontario",
    sectors: ["engineering", "public-works"],
    count: 10,
    title: "Ontario · Engineering + Public Works · 10",
  });

  console.log(`\n=== SUMMARY ===`);
  console.log(`  Search 1 (Quebec):  #${a.searchId}  ${a.contactCount} contacts`);
  console.log(`  Search 2 (Ontario): #${b.searchId}  ${b.contactCount} contacts`);
  console.log(`\nView at: /crm/municipal-contacts`);
}

main().catch((e) => {
  console.error("\nTest failed:", e);
  process.exit(1);
});
