// Iterative lead generator for Quebec engineering services.
//
// Goal: 5 verified leads, each with:
//   - a real, reachable sourceUrl (HEAD/GET-checks pass)
//   - a real, reachable website
//   - a 2-3 sentence services_summary describing what the department does
//   - identifying contact (department + role at minimum, name when public)
//
// Strategy:
//   1. Ask Perplexity for ~12 candidate contacts (over-fetch for buffer)
//   2. Verify every URL in parallel
//   3. Drop candidates with broken sourceUrl AND no recoverable substitute
//      from Perplexity's citations
//   4. For any candidate missing services_summary, ask Perplexity to
//      summarize that municipality's engineering services in 2-3 sentences
//      with a follow-up search
//   5. Run Claude over the survivors to normalize / categorize
//   6. Take the top 5; if fewer than 5 pass, loop with a different angle
//      (broader scope, different example municipalities) until we have 5
//   7. Insert as a single municipality_searches row with 5 contacts
//
// Usage: npx tsx --env-file=.env scripts/lead-quebec-engineering.ts

import { neon } from "@neondatabase/serverless";
import { perplexityChat } from "../src/lib/ai/perplexity";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "../src/lib/ai/claude";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

const TARGET = 5;
const MAX_ITERATIONS = 4;
const URL_TIMEOUT_MS = 8_000;
const URL_CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

type Contact = {
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
  category?: string;
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
          servicesSummary: { type: "string" },
          notes: { type: "string" },
        },
        required: [
          "municipalityName","municipalityType","department","role","name",
          "email","phone","address","website","sourceUrl","servicesSummary","notes",
        ],
      },
    },
  },
  required: ["contacts"],
};

const SYSTEM_PROMPT =
  "You are a public-records research assistant for Canadian municipalities. Take time to actually search the web for each municipality before answering. Search BOTH English and French municipal websites — Quebec directories are predominantly in French. Use ONLY publicly-listed municipal contacts. Do not include personal cell numbers. Only return URLs that you actually visited and that appear in your citations. Each servicesSummary must be specific to that municipality's engineering department, not boilerplate.";

function buildPrompt(args: {
  count: number;
  excluded: string[];
  iteration: number;
}): string {
  const { count, excluded, iteration } = args;
  const excludeBlock = excluded.length
    ? `\nDO NOT return contacts for these municipalities — already covered: ${excluded.join(", ")}.\n`
    : "";
  const angleBlock =
    iteration === 0
      ? `Pick a mix of small, mid-size, and large Quebec municipalities. Avoid only listing the four biggest cities.`
      : iteration === 1
        ? `Focus on municipalities OUTSIDE the Montreal CMA — South Shore, Laurentides, Estrie, Mauricie, Saguenay, Quebec City region. Mid-size cities preferred.`
        : iteration === 2
          ? `Focus on municipalities in the Outaouais, Centre-du-Québec, and Bas-Saint-Laurent regions. Smaller cities and towns acceptable.`
          : `Any Quebec municipality with a public engineering / génie / travaux publics directory page. Prefer ones not in the previous list.`;

  return `Find ${count} verified public engineering / génie municipal contacts from Quebec, Canada.

${angleBlock}
${excludeBlock}
Quebec municipal websites are in French. Search for: "Service du génie", "Direction du génie", "Service de l'ingénierie", "Travaux publics et génie", "Director of Engineering" on .qc.ca / .ca / .org domains.

For each contact, return:
  - municipalityName: as written on the source ("Ville de Saint-Hyacinthe", "Town of Mont-Royal").
  - municipalityType: city / town / village / municipality.
  - department: department name as listed (e.g. "Service du génie", "Direction des services techniques").
  - role: official title.
  - name: full name if listed publicly. Empty string if directory only lists role.
  - email: official email. Empty string if unlisted.
  - phone: main phone with extension. Empty string if unlisted.
  - address: city hall mailing address. Empty if not on the source.
  - website: the municipality HOMEPAGE URL. Verify the host actually exists in your citations.
  - sourceUrl: REQUIRED. MUST be a URL you actually visited that appears in your citations. If a deep page doesn't exist, give the directory landing-page citation instead. NEVER invent paths.
  - servicesSummary: REQUIRED. 2-3 specific sentences about what this engineering department actually does (e.g. "Plans and oversees roadway, drainage, water, and sewer infrastructure projects. Reviews engineering submittals from developers and manages public-works tenders. Operates the city's GIS / cartography service."). Base it on the source page — don't write boilerplate.
  - notes: anything else relevant.

Return JSON: { "contacts": [...] }`;
}

async function checkUrl(u: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(u)) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
      },
    }).catch(() => null);
    if (!res) return false;
    if (res.status < 400) return true;
    if (res.status === 401 || res.status === 403) return true;
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function verifyUrls(urls: string[]): Promise<Map<string, boolean>> {
  const distinct = [...new Set(urls)];
  const status = new Map<string, boolean>();
  const queue = [...distinct];
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u) return;
      status.set(u, await checkUrl(u));
    }
  }
  await Promise.all(Array.from({ length: URL_CONCURRENCY }, () => worker()));
  return status;
}

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
    if (!status.get(u)) continue;
    const lower = u.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score += 2;
    if (/\.qc\.ca\b/i.test(lower)) score += 1;
    if (/\b(ville|town|city|village|municipalit)\b/i.test(lower)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { url: u, score };
  }
  return best?.url ?? null;
}

async function fetchCandidates(args: {
  count: number;
  excluded: string[];
  iteration: number;
}): Promise<{ contacts: Contact[]; citations: string[] }> {
  const userPrompt = buildPrompt(args);
  console.log(`  → Pass A (schema, count=${args.count})`);
  const tA = Date.now();
  const passA = await perplexityChat<{ contacts: Contact[] }>({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: PERPLEXITY_SCHEMA,
    schemaName: "quebec_engineering",
    maxTokens: Math.min(32_000, 1500 + args.count * 220),
  });
  let contacts = passA.content?.contacts ?? [];
  let citations = passA.citations ?? [];
  console.log(
    `    ${Date.now() - tA}ms · contacts=${contacts.length} · citations=${citations.length}`,
  );

  if (contacts.length === 0) {
    console.log(`  → Pass B (free-form fallback)`);
    const tB = Date.now();
    const freePrompt = `${userPrompt}

Output FORMAT (must be exactly this — a fenced JSON block):

\`\`\`json
{
  "contacts": [
    {
      "municipalityName": "Ville de …",
      "municipalityType": "city",
      "department": "Service du génie",
      "role": "Directeur du Service du génie",
      "name": "...",
      "email": "...",
      "phone": "...",
      "address": "...",
      "website": "...",
      "sourceUrl": "...",
      "servicesSummary": "2-3 specific sentences about what this department does for the municipality",
      "notes": ""
    }
  ]
}
\`\`\``;
    const passB = await perplexityChat<string>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: freePrompt,
      maxTokens: Math.min(32_000, 1500 + args.count * 220),
    });
    const text = passB.content ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as { contacts?: Contact[] };
        contacts = parsed.contacts ?? [];
        citations = passB.citations ?? citations;
      } catch (e) {
        console.warn(`    JSON parse failed: ${(e as Error).message}`);
      }
    }
    console.log(
      `    ${Date.now() - tB}ms · contacts=${contacts.length} · citations=${citations.length}`,
    );
  }
  return { contacts, citations };
}

async function fillMissingServices(c: Contact): Promise<string> {
  console.log(`    fetching services for ${c.municipalityName}`);
  const r = await perplexityChat<string>({
    systemPrompt:
      "You are a public-records research assistant. Search the municipality's website and its engineering department page. Reply with 2-3 specific sentences in plain prose — no markdown, no bullets.",
    userPrompt: `Summarize what the engineering department of "${c.municipalityName}" (Quebec, Canada) does. Be specific to this municipality based on what their website says.${c.sourceUrl ? ` Their listing is at: ${c.sourceUrl}` : ""}${c.website ? ` Their homepage is: ${c.website}` : ""}

Return 2-3 sentences. No preamble. Example: "Plans and oversees the city's roadway, drainage, water and sewer infrastructure. Reviews engineering submittals from private developers and manages tenders for public works. Coordinates traffic studies and the municipal GIS service."`,
    maxTokens: 600,
  });
  return (r.content ?? "").trim().replace(/^"|"$/g, "");
}

async function categorizeWithClaude(contacts: Contact[]): Promise<Contact[]> {
  if (!hasClaudeKey() || contacts.length === 0) {
    return contacts.map((c) => ({ ...c, category: "engineering" }));
  }
  const client = claudeClient();
  const tools = [{
    name: "record_contacts",
    description: "Cleaned contacts.",
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
              servicesSummary: { type: "string" },
              notes: { type: "string" },
              category: {
                type: "string",
                enum: ["engineering","public-works","administration","elected","planning","parks","environment","fire","police","other"],
              },
            },
            required: [
              "municipalityName","municipalityType","department","role","name",
              "email","phone","address","website","sourceUrl","servicesSummary","notes","category",
            ],
          },
        },
      },
      required: ["contacts"],
    },
  }];
  const models = [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS];
  for (const model of models) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 8000,
        system:
          'Normalize each contact and assign category. Pick "engineering" when the department is engineering / génie / ingénierie / civil. Trim whitespace. Strip "mailto:" prefixes. Don\'t invent fields.',
        messages: [{ role: "user", content: `Normalize:\n\n${JSON.stringify(contacts, null, 2)}` }],
        tools,
        tool_choice: { type: "tool", name: "record_contacts" },
      });
      const block = res.content.find((b: any) => b.type === "tool_use") as any;
      if (!block) throw new Error("no tool_use");
      return (block.input as { contacts: Contact[] }).contacts;
    } catch (e) {
      console.warn(`    Claude ${model} failed: ${(e as Error).message}`);
    }
  }
  return contacts.map((c) => ({ ...c, category: "engineering" }));
}

function isComplete(c: Contact): { ok: boolean; reason?: string } {
  if (!c.municipalityName?.trim()) return { ok: false, reason: "no municipality" };
  if (!c.sourceUrl?.trim()) return { ok: false, reason: "no sourceUrl" };
  if (!c.website?.trim()) return { ok: false, reason: "no website" };
  if (!c.servicesSummary?.trim() || c.servicesSummary.trim().length < 40) {
    return { ok: false, reason: "no services summary" };
  }
  if (!c.department?.trim()) return { ok: false, reason: "no department" };
  return { ok: true };
}

async function main() {
  console.log("=== Quebec engineering services — 5 verified leads ===\n");
  const accepted: Contact[] = [];
  const acceptedKeys = new Set<string>();

  for (let i = 0; i < MAX_ITERATIONS && accepted.length < TARGET; i++) {
    const remaining = TARGET - accepted.length;
    const overFetch = Math.max(8, remaining * 3);
    console.log(`\n━━━ Iteration ${i + 1} (need ${remaining} more, fetching ${overFetch}) ━━━`);
    const excluded = [...new Set(accepted.map((c) => c.municipalityName))];

    const { contacts: candidates, citations } = await fetchCandidates({
      count: overFetch,
      excluded,
      iteration: i,
    });
    if (candidates.length === 0) {
      console.log(`  no candidates returned — moving on`);
      continue;
    }

    // Verify every URL across all candidates + citations.
    const allUrls = [
      ...candidates.flatMap((c) => [c.sourceUrl, c.website].filter(Boolean)),
      ...citations,
    ];
    const status = await verifyUrls(allUrls);
    console.log(
      `  verified ${status.size} URL(s); ${[...status.values()].filter(Boolean).length} resolved`,
    );

    for (const c of candidates) {
      if (accepted.length >= TARGET) break;
      const key = (c.municipalityName || "").toLowerCase().trim();
      if (acceptedKeys.has(key)) continue;

      // Fix sourceUrl
      if (c.sourceUrl && !status.get(c.sourceUrl)) {
        const sub = bestCitationFor(c.municipalityName, citations, status);
        c.sourceUrl = sub ?? "";
      }
      // Fix website
      if (c.website && !status.get(c.website)) {
        try {
          const host = new URL(c.website).host;
          const root = `https://${host}/`;
          if (status.get(root)) {
            c.website = root;
          } else {
            // Try a citation on the same host
            let pick = "";
            for (const u of citations) {
              if (!status.get(u)) continue;
              try {
                if (new URL(u).host === host) {
                  pick = u;
                  break;
                }
              } catch {/* skip */}
            }
            c.website = pick;
          }
        } catch {
          c.website = "";
        }
      }

      // Fill missing services_summary via Perplexity follow-up
      if (!c.servicesSummary || c.servicesSummary.trim().length < 40) {
        try {
          c.servicesSummary = await fillMissingServices(c);
        } catch (e) {
          console.warn(`    services fetch failed for ${c.municipalityName}: ${(e as Error).message}`);
        }
      }

      const verdict = isComplete(c);
      if (!verdict.ok) {
        console.log(`  ✗ ${c.municipalityName} — ${verdict.reason}`);
        continue;
      }
      accepted.push(c);
      acceptedKeys.add(key);
      console.log(`  ✓ ${c.municipalityName} — ${c.role || c.department}`);
    }
    console.log(`  iteration end: ${accepted.length} / ${TARGET} accepted`);
  }

  if (accepted.length < TARGET) {
    console.warn(
      `\n⚠ Only ${accepted.length} leads passed all gates after ${MAX_ITERATIONS} iterations.`,
    );
  }

  // Claude pass for normalization + categorization
  console.log(`\nNormalizing ${accepted.length} leads with Claude…`);
  const categorized = await categorizeWithClaude(accepted);

  // Insert as one search row
  const search = (await sql.query(
    `INSERT INTO municipality_searches
       (country, province, scope_types, sectors, requested_count, title, created_by_clerk_id)
     VALUES ('Canada', 'Quebec', 'all', 'engineering', $1, $2, $3)
     RETURNING id`,
    [
      TARGET,
      `Quebec engineering services — ${categorized.length} verified leads`,
      "script:lead-quebec-engineering",
    ],
  )) as Array<{ id: number }>;
  const searchId = search[0].id;
  console.log(`Inserted search #${searchId}`);

  for (const c of categorized) {
    await sql.query(
      `INSERT INTO municipality_contacts
         (search_id, municipality_name, municipality_type, province,
          department, role, category, name, email, phone, address,
          website, source_url, services_summary, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        searchId,
        c.municipalityName?.trim() || "Unknown",
        c.municipalityType || null,
        "Quebec",
        c.department || null,
        c.role || null,
        c.category || "engineering",
        c.name || null,
        c.email || null,
        c.phone || null,
        c.address || null,
        c.website || null,
        c.sourceUrl || null,
        c.servicesSummary || null,
        c.notes || null,
      ],
    );
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  saved search #${searchId} with ${categorized.length} contacts`);
  for (const c of categorized) {
    console.log(`  • ${c.municipalityName} — ${c.role || c.department}`);
    console.log(`    src: ${c.sourceUrl}`);
    console.log(`    web: ${c.website}`);
    console.log(`    svc: ${(c.servicesSummary ?? "").slice(0, 140)}…`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("\nFailed:", e);
  process.exit(1);
});
