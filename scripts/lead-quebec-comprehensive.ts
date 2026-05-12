// Comprehensive Quebec municipal lead generator — for parks-and-recreation
// lighting sales. Targets every administrative region of Quebec across four
// buyer-relevant sectors (Engineering, Parks & Recreation, Public Works,
// Administration), runs the full iterative validation pipeline on each
// batch, and assembles one big saved-search row with whatever passes the
// gates.
//
// Pipeline per (region × sector):
//   1. Perplexity Pass B (free-form) — Pass A schema-mode is unreliable for
//      Quebec/French queries. Skip it and go straight to free-form parsing.
//   2. GET-verify every sourceUrl + website + every Perplexity citation.
//      Lenient classifier (401/403 = bot wall, kept; 404/410/5xx = broken).
//   3. Substitute broken URLs with the closest resolved citation.
//   4. Fill missing services_summary with a per-record follow-up call
//      (skipped if Perplexity already provided one, ≥40 chars).
//   5. Gate: drop records missing sourceUrl, website, services_summary,
//      department, or role.
//   6. Dedupe by `${municipalityName}::${role}`.
//
// At the end, Claude normalizes the survivors and writes one search row.
//
// Usage: npx tsx --env-file=.env scripts/lead-quebec-comprehensive.ts

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

const PER_BATCH = 8; // candidates per region × sector
const URL_TIMEOUT_MS = 8_000;
const URL_CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

// 17 Quebec administrative regions plus the (often-distinct) Quebec City
// metro and the Greater Montreal off-island municipalities.
const REGIONS = [
  { code: "montreal-island", label: "Île de Montréal (boroughs + city)" },
  { code: "laval", label: "Laval" },
  { code: "montreal-south-shore", label: "Montérégie — Rive-Sud (Longueuil, Brossard, Saint-Lambert, Boucherville, Saint-Bruno, etc.)" },
  { code: "montreal-north-shore", label: "Laurentides + Lanaudière (off-island northern crown)" },
  { code: "monteregie-east", label: "Montérégie — Est (Saint-Hyacinthe, Granby, Cowansville, etc.)" },
  { code: "monteregie-west", label: "Montérégie — Ouest (Salaberry-de-Valleyfield, Châteauguay, Vaudreuil-Dorion, etc.)" },
  { code: "quebec-city", label: "Capitale-Nationale (Québec, L'Ancienne-Lorette, Saint-Augustin, etc.)" },
  { code: "chaudiere-appalaches", label: "Chaudière-Appalaches (Lévis, Saint-Georges, Thetford Mines, Montmagny, etc.)" },
  { code: "estrie", label: "Estrie / Cantons-de-l'Est (Sherbrooke, Magog, Lac-Mégantic, Coaticook, etc.)" },
  { code: "centre-du-quebec", label: "Centre-du-Québec (Drummondville, Victoriaville, Bécancour, etc.)" },
  { code: "mauricie", label: "Mauricie (Trois-Rivières, Shawinigan, La Tuque)" },
  { code: "outaouais", label: "Outaouais (Gatineau, Cantley, Chelsea, etc.)" },
  { code: "saguenay-lac-saint-jean", label: "Saguenay–Lac-Saint-Jean (Saguenay, Alma, Dolbeau-Mistassini, etc.)" },
  { code: "bas-saint-laurent", label: "Bas-Saint-Laurent (Rimouski, Rivière-du-Loup, Matane, etc.)" },
  { code: "gaspesie", label: "Gaspésie–Îles-de-la-Madeleine (Gaspé, Sainte-Anne-des-Monts, Carleton-sur-Mer, etc.)" },
  { code: "cote-nord", label: "Côte-Nord (Sept-Îles, Baie-Comeau, Port-Cartier, etc.)" },
  { code: "abitibi-temiscamingue", label: "Abitibi-Témiscamingue (Rouyn-Noranda, Val-d'Or, Amos, etc.)" },
] as const;

const SECTORS = [
  {
    code: "engineering",
    label: "Engineering services",
    promptHint: "Service du génie / Direction du génie / Service de l'ingénierie / Travaux publics et génie. Director of Engineering, Chef de service, Ingénieur municipal.",
  },
  {
    code: "parks",
    label: "Parks & Recreation",
    promptHint: "Service des loisirs / Loisirs, sports et culture / Parcs et espaces verts / Sports et plein air. Directeur des loisirs, Chef de service Loisirs, Régisseur sports et parcs.",
  },
  {
    code: "public-works",
    label: "Public Works",
    promptHint: "Service des travaux publics / Voirie / Infrastructures / Eau et assainissement. Directeur des travaux publics, Chef de service Voirie.",
  },
  {
    code: "administration",
    label: "Administration",
    promptHint: "Direction générale / Greffe / Mairie. Directeur général (DG), Greffier(ère), Maire / Mairesse, Trésorier.",
  },
] as const;

type SectorCode = (typeof SECTORS)[number]["code"];

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
  sectorCode?: SectorCode; // injected before Claude pass
  category?: string; // assigned by Claude
};

const SYSTEM_PROMPT =
  "You are a public-records research assistant for Quebec municipalities. Take your time. Search BOTH English and French municipal directories — Quebec sites are mostly in French. Use ONLY publicly-listed municipal contacts (city hall directories, official municipal pages, .qc.ca / .ca / .org domains). Do not include personal cell numbers or unverified emails. Only return URLs you actually visited that appear in your citations. Each servicesSummary must be specific to that municipality's department, never boilerplate.";

function buildPrompt(args: {
  region: string;
  sector: { label: string; promptHint: string };
  count: number;
  excludedMunicipalities: string[];
  excludedKeys: Set<string>;
}): string {
  const { region, sector, count, excludedMunicipalities } = args;

  // Truncate the excluded-municipalities list to keep the prompt under control.
  // Sorted by name so successive sweeps see a stable list and don't oscillate.
  const excludeSample = [...excludedMunicipalities].sort().slice(0, 80);
  const excludeBlock = excludeSample.length
    ? `

DO NOT return contacts from these municipalities — they are already in the directory:
${excludeSample.join(", ")}${excludedMunicipalities.length > excludeSample.length ? `, …and ${excludedMunicipalities.length - excludeSample.length} more` : ""}

Pick OTHER Quebec municipalities in the region. Smaller cities, towns, villages, MRC seats, and agglomeration members are all fair game.`
    : "";

  return `Find UP TO ${count} verified public ${sector.label} contacts for Quebec municipalities in this region: ${region}.

Even returning 1-3 high-quality contacts is fine — quality matters more than hitting the count exactly. If the region is dominated by one large city (e.g. Laval is a single municipality), include multiple roles within that one city across the relevant department, plus any nearby agglomeration members.${excludeBlock}

What to look for: ${sector.promptHint}

For each contact, return:
  - municipalityName: as written on the source ("Ville de Saint-Hyacinthe", "Municipalité de Lac-Beauport").
  - municipalityType: city / town / village / municipality.
  - department: department name as listed (e.g. "Service des loisirs et de la culture", "Service du génie").
  - role: official title.
  - name: full name if listed publicly. Empty string if directory only lists role.
  - email: official department or person email. Empty string if unlisted.
  - phone: main phone with extension. Empty string if unlisted.
  - address: city hall mailing address. Empty if not on the source.
  - website: the municipality HOMEPAGE URL.
  - sourceUrl: REQUIRED. MUST appear in your citations — a URL you actually visited. NEVER invent paths. Falling back to a directory landing page is preferred over inventing a deep link.
  - servicesSummary: REQUIRED. 2-3 SPECIFIC sentences describing what THIS department does for THIS municipality (e.g. for Parks & Recreation: "Manages public parks, sports facilities, splash pads, the municipal arena, and seasonal recreation programs. Coordinates park lighting upgrades and capital projects with the public-works team."). Base it on the source page — never write boilerplate.
  - notes: any relevant context.

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
      "servicesSummary": "2-3 specific sentences",
      "notes": ""
    }
  ]
}
\`\`\`

Empty string is acceptable for any field except servicesSummary, sourceUrl, website, department, role. Spread across MULTIPLE municipalities — don't return all ${count} from one big city.`;
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
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
  const distinct = [...new Set(urls.filter(Boolean))];
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

// JSON schema for Pass-A schema mode. Same fields as the free-form example.
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

async function fetchBatch(args: {
  region: string;
  sector: { label: string; promptHint: string };
  count: number;
  excludedMunicipalities: string[];
  excludedKeys: Set<string>;
}): Promise<{ contacts: Contact[]; citations: string[] }> {
  const userPrompt = buildPrompt(args);
  const maxTokens = Math.min(32_000, 1500 + args.count * 280);

  // Pass B (free-form) — works most reliably for Quebec but sometimes
  // returns no JSON block.
  let contacts: Contact[] = [];
  let citations: string[] = [];
  try {
    const r = await perplexityChat<string>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens,
    });
    citations = r.citations ?? [];
    const text = r.content ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as { contacts?: Contact[] };
        contacts = parsed.contacts ?? [];
      } catch (e) {
        console.warn(`    [B] JSON parse failed: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.warn(`    [B] Perplexity failed: ${(e as Error).message}`);
  }

  if (contacts.length === 0) {
    // Pass A — schema mode. Sometimes succeeds when free-form returns text.
    try {
      const r = await perplexityChat<{ contacts: Contact[] }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        schema: PERPLEXITY_SCHEMA,
        schemaName: "qc_municipal_contacts",
        maxTokens,
      });
      contacts = r.content?.contacts ?? [];
      if (r.citations?.length) citations = r.citations;
    } catch (e) {
      console.warn(`    [A] Perplexity failed: ${(e as Error).message}`);
    }
  }

  return { contacts, citations };
}

async function fillMissingServices(c: Contact): Promise<string> {
  try {
    const r = await perplexityChat<string>({
      systemPrompt:
        "You are a public-records research assistant. Reply with 2-3 specific sentences in plain prose — no markdown, no bullets, no preamble.",
      userPrompt: `Summarize what the "${c.department}" department of "${c.municipalityName}" (Quebec, Canada) does. Be specific to this municipality based on what their website says — what services do they offer, what projects do they run, who do they serve.${c.sourceUrl ? ` Their listing: ${c.sourceUrl}` : ""}${c.website ? ` Their homepage: ${c.website}` : ""}`,
      maxTokens: 600,
    });
    return (r.content ?? "").trim().replace(/^"|"$/g, "");
  } catch {
    return "";
  }
}

function isComplete(c: Contact): { ok: boolean; reason?: string } {
  if (!c.municipalityName?.trim()) return { ok: false, reason: "no municipality" };
  if (!c.sourceUrl?.trim()) return { ok: false, reason: "no sourceUrl" };
  if (!c.website?.trim()) return { ok: false, reason: "no website" };
  if (!c.department?.trim()) return { ok: false, reason: "no department" };
  if (!c.role?.trim()) return { ok: false, reason: "no role" };
  if (!c.servicesSummary?.trim() || c.servicesSummary.trim().length < 40) {
    return { ok: false, reason: "no/thin services_summary" };
  }
  return { ok: true };
}

function dedupKey(c: Contact): string {
  const m = (c.municipalityName ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const r = (c.role ?? "").toLowerCase().trim();
  return `${m}::${r}`;
}

async function categorizeWithClaude(contacts: Contact[]): Promise<Contact[]> {
  if (!hasClaudeKey() || contacts.length === 0) {
    return contacts.map((c) => ({ ...c, category: c.sectorCode ?? "other" }));
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
  // System + tools are identical across every batch in this run — mark
  // them ephemeral so Anthropic serves them from cache on batches 2…N.
  const SYSTEM_PROMPT =
    'Normalize each contact and assign category from this enum: engineering, public-works, administration, elected, planning, parks, environment, fire, police, other. Pick "engineering" for génie / ingénierie / civil engineering. Pick "parks" for loisirs / parcs / sports / recreation. Pick "public-works" for travaux publics / voirie / infrastructures. Pick "administration" for direction générale / greffe / mairie. Trim whitespace. Strip mailto: prefixes. Don\'t invent fields.';
  const cachedTools = tools.map((t, i, arr) =>
    i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
  );

  // Batch by 25 to stay under output-token caps.
  const out: Contact[] = [];
  for (let i = 0; i < contacts.length; i += 25) {
    const batch = contacts.slice(i, i + 25);
    let ok = false;
    for (const model of models) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 8000,
          system: [
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: `Normalize:\n\n${JSON.stringify(batch, null, 2)}` }],
          tools: cachedTools,
          tool_choice: { type: "tool", name: "record_contacts" },
        });
        const block = res.content.find((b: any) => b.type === "tool_use") as any;
        if (!block) throw new Error("no tool_use");
        const parsed = (block.input as { contacts: Contact[] }).contacts;
        out.push(...parsed);
        console.log(`    Claude normalized batch ${i / 25 + 1} via ${model} (${parsed.length})`);
        ok = true;
        break;
      } catch (e) {
        console.warn(`    Claude ${model} batch ${i / 25 + 1} failed: ${(e as Error).message}`);
      }
    }
    if (!ok) {
      // keep raw with sector-derived category
      out.push(...batch.map((c) => ({ ...c, category: c.sectorCode ?? "other" })));
    }
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log("=== Quebec municipal leads — comprehensive sweep ===");
  console.log(`Regions: ${REGIONS.length} · Sectors: ${SECTORS.length} · per-batch: ${PER_BATCH}`);
  console.log(`Estimated max candidates: ${REGIONS.length * SECTORS.length * PER_BATCH}\n`);

  // Load every existing Quebec contact so we (a) can ask Perplexity to skip
  // those municipalities in its research and (b) reject duplicates before
  // they hit the DB. Keys are `lower(municipality_name)::lower(role)` so
  // the same person at two roles or two people in one municipality each
  // count as separate leads.
  const existingRows = (await sql.query(
    `SELECT municipality_name, role FROM municipality_contacts
       WHERE province = 'Quebec'`,
  )) as Array<{ municipality_name: string; role: string | null }>;
  const accepted: Contact[] = [];
  const acceptedKeys = new Set<string>();
  for (const r of existingRows) {
    const k = dedupKey({
      municipalityName: r.municipality_name ?? "",
      role: r.role ?? "",
    } as Contact);
    acceptedKeys.add(k);
  }
  // Distinct municipality names already covered (for the exclude block in
  // the prompt). Use original casing — Perplexity matches better that way.
  const existingMunicipalities = [
    ...new Set(existingRows.map((r) => r.municipality_name).filter(Boolean)),
  ];
  console.log(
    `Loaded ${existingRows.length} existing contact(s) covering ${existingMunicipalities.length} municipalities — those will be excluded from this sweep.\n`,
  );
  const stats: Record<string, number> = {
    candidates: 0,
    "drop:sourceUrl": 0,
    "drop:website": 0,
    "drop:summary": 0,
    "drop:department": 0,
    "drop:role": 0,
    "drop:dup": 0,
    "drop:other": 0,
    "fix:sourceUrl": 0,
    "fix:website": 0,
    "fix:summary": 0,
  };

  let pairIdx = 0;
  const totalPairs = REGIONS.length * SECTORS.length;

  for (const region of REGIONS) {
    for (const sector of SECTORS) {
      pairIdx++;
      console.log(
        `\n[${pairIdx}/${totalPairs}] ${region.code} × ${sector.code}`,
      );
      const { contacts: candidates, citations } = await fetchBatch({
        region: region.label,
        sector,
        count: PER_BATCH,
        excludedMunicipalities: [
          ...existingMunicipalities,
          ...accepted.map((c) => c.municipalityName),
        ],
        excludedKeys: acceptedKeys,
      });
      console.log(
        `  Perplexity returned ${candidates.length} candidates, ${citations.length} citations`,
      );
      stats.candidates += candidates.length;
      if (candidates.length === 0) continue;

      // Verify all distinct URLs in this batch (sourceUrl + website + citations)
      const allUrls = [
        ...candidates.flatMap((c) => [c.sourceUrl, c.website].filter(Boolean)),
        ...citations,
      ];
      const status = await verifyUrls(allUrls);
      const okCount = [...status.values()].filter(Boolean).length;
      console.log(`  verified ${status.size} URL(s) — ${okCount} resolved`);

      for (const c of candidates) {
        // Substitute broken sourceUrl / website
        if (c.sourceUrl && !status.get(c.sourceUrl)) {
          const sub = bestCitationFor(c.municipalityName, citations, status);
          if (sub) {
            c.sourceUrl = sub;
            stats["fix:sourceUrl"]++;
          } else {
            c.sourceUrl = "";
          }
        }
        if (c.website && !status.get(c.website)) {
          try {
            const host = new URL(c.website).host;
            const root = `https://${host}/`;
            if (status.get(root)) {
              c.website = root;
              stats["fix:website"]++;
            } else {
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
              if (pick) stats["fix:website"]++;
            }
          } catch {
            c.website = "";
          }
        }

        // Fill missing services_summary
        if (!c.servicesSummary || c.servicesSummary.trim().length < 40) {
          c.servicesSummary = await fillMissingServices(c);
          if (c.servicesSummary && c.servicesSummary.length >= 40) {
            stats["fix:summary"]++;
          }
        }

        // Tag with sector code so Claude has context
        c.sectorCode = sector.code;

        // Gate
        const verdict = isComplete(c);
        if (!verdict.ok) {
          stats[`drop:${verdict.reason?.split(/[\s/]+/)[0] ?? "other"}`] =
            (stats[`drop:${verdict.reason?.split(/[\s/]+/)[0] ?? "other"}`] ?? 0) + 1;
          continue;
        }

        // Dedupe
        const key = dedupKey(c);
        if (acceptedKeys.has(key)) {
          stats["drop:dup"]++;
          continue;
        }
        acceptedKeys.add(key);
        accepted.push(c);
      }
      console.log(`  → ${accepted.length} accepted overall`);
    }
  }

  const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
  console.log(`\n=== Sweep complete in ~${elapsedMin}m ===`);
  console.log(`  total candidates: ${stats.candidates}`);
  console.log(`  fixes — sourceUrl: ${stats["fix:sourceUrl"]} · website: ${stats["fix:website"]} · summary: ${stats["fix:summary"]}`);
  console.log(`  dropped — sourceUrl: ${stats["drop:sourceUrl"]} · website: ${stats["drop:website"]} · summary: ${stats["drop:summary"]} · dept: ${stats["drop:department"]} · role: ${stats["drop:role"]} · dup: ${stats["drop:dup"]} · other: ${stats["drop:other"]}`);
  console.log(`  ACCEPTED: ${accepted.length}`);

  if (accepted.length === 0) {
    console.warn("\n⚠ No leads accepted — aborting insert.");
    return;
  }

  console.log(`\nNormalizing ${accepted.length} new leads with Claude…`);
  const categorized = await categorizeWithClaude(accepted);

  // Append to the canonical comprehensive search row if one exists; otherwise
  // create it. Title gets refreshed at the end with the post-merge count.
  const existingSearch = (await sql.query(
    `SELECT id FROM municipality_searches
       WHERE province = 'Quebec'
         AND title LIKE 'Quebec municipalities — comprehensive%'
       ORDER BY id ASC LIMIT 1`,
  )) as Array<{ id: number }>;

  let searchId: number;
  if (existingSearch.length > 0) {
    searchId = existingSearch[0].id;
    console.log(`Appending to canonical search #${searchId}`);
  } else {
    const created = (await sql.query(
      `INSERT INTO municipality_searches
         (country, province, scope_types, sectors, requested_count, title, created_by_clerk_id)
       VALUES ('Canada', 'Quebec', 'all', $1, $2, $3, $4)
       RETURNING id`,
      [
        "engineering,parks,public-works,administration",
        categorized.length,
        `Quebec municipalities — comprehensive lead list (${categorized.length} verified)`,
        "script:lead-quebec-comprehensive",
      ],
    )) as Array<{ id: number }>;
    searchId = created[0].id;
    console.log(`Created canonical search #${searchId}`);
  }

  // Insert in chunks to stay under any single-statement size cap.
  const chunkSize = 50;
  for (let i = 0; i < categorized.length; i += chunkSize) {
    const chunk = categorized.slice(i, i + chunkSize);
    for (const c of chunk) {
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
          c.category || c.sectorCode || "other",
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
    console.log(`  inserted ${Math.min(i + chunkSize, categorized.length)} / ${categorized.length}`);
  }

  // Refresh canonical title + count to match the post-merge total.
  const finalCount = (await sql.query(
    `SELECT count(*)::int AS c FROM municipality_contacts WHERE search_id = $1`,
    [searchId],
  )) as Array<{ c: number }>;
  const finalTitle = `Quebec municipalities — comprehensive lead list (${finalCount[0].c} verified)`;
  await sql.query(
    `UPDATE municipality_searches SET title = $1, requested_count = $2, updated_at = NOW() WHERE id = $3`,
    [finalTitle, finalCount[0].c, searchId],
  );

  // By-sector summary across the whole canonical row (not just this run).
  const bySector = (await sql.query(
    `SELECT category, count(*)::int AS n FROM municipality_contacts
       WHERE search_id = $1 GROUP BY category ORDER BY n DESC`,
    [searchId],
  )) as Array<{ category: string | null; n: number }>;
  console.log(`\nCanonical row #${searchId} now has ${finalCount[0].c} total contact(s).`);
  console.log(`By sector:`);
  for (const r of bySector) console.log(`  ${r.category ?? "(null)"}: ${r.n}`);
  console.log(`\nView at: /tools/municipal-contacts (search #${searchId})`);
}

main().catch((e) => {
  console.error("\nFailed:", e);
  process.exit(1);
});
