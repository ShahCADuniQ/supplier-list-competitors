// Add 5 fresh Quebec engineering services contacts to the canonical
// "Quebec municipalities — comprehensive lead list" row. Deduped against
// every existing Quebec contact already in the DB so the new ones are
// genuinely new municipalities. Verifies URLs and fills services_summary
// before insert.
//
// Usage: npx tsx --env-file=.env scripts/add-5-engineering-leads.ts

import { neon } from "@neondatabase/serverless";
import { perplexityChat } from "../src/lib/ai/perplexity";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "../src/lib/ai/claude";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = neon(url);

const TARGET = 5;
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

function dedupKey(name: string, role: string): string {
  const fold = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  return `${fold(name)}::${fold(role)}`;
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
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
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

function bestCitationFor(municipalityName: string, citations: string[], status: Map<string, boolean>): string | null {
  const name = municipalityName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = name.split(/\s+/).filter((t) => t.length >= 4);
  let best: { url: string; score: number } | null = null;
  for (const u of citations) {
    if (!status.get(u)) continue;
    const lower = u.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score += 2;
    if (/\.qc\.ca\b/i.test(lower)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { url: u, score };
  }
  return best?.url ?? null;
}

async function main() {
  // Find canonical Quebec search row.
  const rows = (await sql.query(
    `SELECT id, title FROM municipality_searches
       WHERE province = 'Quebec' AND title LIKE 'Quebec municipalities — comprehensive%'
       ORDER BY id ASC LIMIT 1`,
  )) as Array<{ id: number; title: string }>;
  if (rows.length === 0) {
    console.error("No canonical 'Quebec municipalities — comprehensive…' row found.");
    process.exit(1);
  }
  const searchId = rows[0].id;
  console.log(`Target canonical search: #${searchId}`);

  // Load existing keys + municipality names (excluded list for Perplexity).
  const existing = (await sql.query(
    `SELECT municipality_name, role FROM municipality_contacts
       WHERE province = 'Quebec'`,
  )) as Array<{ municipality_name: string; role: string | null }>;
  const acceptedKeys = new Set<string>();
  const excludedMunis = new Set<string>();
  for (const r of existing) {
    acceptedKeys.add(dedupKey(r.municipality_name, r.role ?? ""));
    if (r.municipality_name) excludedMunis.add(r.municipality_name);
  }
  console.log(`${acceptedKeys.size} existing contacts in ${excludedMunis.size} municipalities — those will be excluded.\n`);

  const accepted: Contact[] = [];
  const acceptedThisRun = new Set<string>();
  let iter = 0;

  while (accepted.length < TARGET && iter < 4) {
    iter++;
    const remaining = TARGET - accepted.length;
    const overFetch = Math.max(8, remaining * 3);
    console.log(`━━━ Iteration ${iter} (need ${remaining}, fetching ${overFetch}) ━━━`);

    const excludeList = [...excludedMunis].sort().slice(0, 100);
    const angle =
      iter === 1 ? `Pick small and mid-size Quebec municipalities, NOT the big metros (Montreal, Quebec City, Laval already have many entries).`
      : iter === 2 ? `Focus on the Outaouais, Bas-Saint-Laurent, and Gaspésie regions.`
      : iter === 3 ? `Focus on Côte-Nord, Abitibi-Témiscamingue, and Saguenay regions.`
      : `Any Quebec municipality whose engineering directory is publicly listed.`;

    const userPrompt = `Find UP TO ${overFetch} verified public engineering / génie municipal contacts from Quebec, Canada.

${angle}

DO NOT return contacts from these municipalities — already in the directory:
${excludeList.join(", ")}${excludedMunis.size > excludeList.length ? `, …and ${excludedMunis.size - excludeList.length} more` : ""}

Pick OTHER Quebec municipalities. Smaller cities, towns, MRC seats, and agglomeration members are all fair game.

Quebec municipal websites are in French. Search for: "Service du génie", "Direction du génie", "Service de l'ingénierie", "Travaux publics et génie".

For each contact, return:
  - municipalityName, municipalityType (city/town/village/municipality)
  - department, role (e.g. "Directeur du Service du génie")
  - name (or empty), email (or empty), phone (or empty), address (or empty)
  - website (homepage URL), sourceUrl (MUST appear in your citations — never invent paths)
  - servicesSummary: 2-3 specific sentences about what THIS engineering department actually does for THIS municipality
  - notes (or empty)

Output FORMAT — fenced JSON block, no preamble:

\`\`\`json
{
  "contacts": [
    {"municipalityName":"...","municipalityType":"city","department":"...","role":"...","name":"...","email":"...","phone":"...","address":"...","website":"...","sourceUrl":"...","servicesSummary":"...","notes":""}
  ]
}
\`\`\``;

    let candidates: Contact[] = [];
    let citations: string[] = [];
    try {
      const r = await perplexityChat<string>({
        systemPrompt: "You are a public-records research assistant for Canadian municipalities. Take time to actually search the web. Search BOTH English and French municipal directories. Use ONLY publicly-listed contacts. Never invent URLs.",
        userPrompt,
        maxTokens: Math.min(32_000, 1500 + overFetch * 280),
      });
      const text = r.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { contacts?: Contact[] };
          candidates = parsed.contacts ?? [];
        } catch (e) {
          console.warn(`  JSON parse failed: ${(e as Error).message}`);
        }
      }
      citations = r.citations ?? [];
      console.log(`  Perplexity returned ${candidates.length} candidates, ${citations.length} citations`);
    } catch (e) {
      console.warn(`  Perplexity failed: ${(e as Error).message}`);
      continue;
    }
    if (candidates.length === 0) continue;

    const allUrls = [
      ...candidates.flatMap((c) => [c.sourceUrl, c.website].filter(Boolean)),
      ...citations,
    ];
    const status = await verifyUrls(allUrls);
    console.log(`  verified ${status.size} URL(s); ${[...status.values()].filter(Boolean).length} resolved`);

    for (const c of candidates) {
      if (accepted.length >= TARGET) break;
      const key = dedupKey(c.municipalityName, c.role);
      if (acceptedKeys.has(key) || acceptedThisRun.has(key)) {
        console.log(`  ✗ ${c.municipalityName} — duplicate`);
        continue;
      }

      // Repair sourceUrl
      if (c.sourceUrl && !status.get(c.sourceUrl)) {
        const sub = bestCitationFor(c.municipalityName, citations, status);
        if (sub) c.sourceUrl = sub;
        else c.sourceUrl = "";
      }
      // Repair website
      if (c.website && !status.get(c.website)) {
        try {
          const host = new URL(c.website).host;
          const root = `https://${host}/`;
          if (status.get(root)) c.website = root;
          else c.website = "";
        } catch { c.website = ""; }
      }

      // Gate
      if (!c.municipalityName?.trim()) { console.log(`  ✗ no municipalityName`); continue; }
      if (!c.sourceUrl?.trim()) { console.log(`  ✗ ${c.municipalityName} — no sourceUrl`); continue; }
      if (!c.website?.trim()) { console.log(`  ✗ ${c.municipalityName} — no website`); continue; }
      if (!c.department?.trim()) { console.log(`  ✗ ${c.municipalityName} — no department`); continue; }
      if (!c.role?.trim()) { console.log(`  ✗ ${c.municipalityName} — no role`); continue; }
      if (!c.servicesSummary?.trim() || c.servicesSummary.trim().length < 40) {
        console.log(`  ✗ ${c.municipalityName} — thin services_summary`);
        continue;
      }
      acceptedThisRun.add(key);
      accepted.push(c);
      console.log(`  ✓ ${c.municipalityName} — ${c.role}`);
    }
    console.log(`  iteration end: ${accepted.length} / ${TARGET} accepted\n`);
  }

  if (accepted.length === 0) {
    console.warn("⚠ No leads passed all gates.");
    process.exit(1);
  }

  // Claude normalize
  let categorized: Contact[] = accepted.map((c) => ({ ...c, category: "engineering" }));
  if (hasClaudeKey()) {
    try {
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
                  category: { type: "string", enum: ["engineering","public-works","administration","elected","planning","parks","environment","fire","police","other"] },
                },
                required: ["municipalityName","municipalityType","department","role","name","email","phone","address","website","sourceUrl","servicesSummary","notes","category"],
              },
            },
          },
          required: ["contacts"],
        },
      }];
      for (const model of [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS]) {
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 6000,
            system: "Normalize each contact. Trim. Strip mailto:. Don't invent fields. Pick \"engineering\" as category for génie / ingénierie / civil.",
            messages: [{ role: "user", content: `Normalize:\n\n${JSON.stringify(accepted, null, 2)}` }],
            tools,
            tool_choice: { type: "tool", name: "record_contacts" },
          });
          const block = res.content.find((b: any) => b.type === "tool_use") as any;
          if (block) {
            categorized = (block.input as { contacts: Contact[] }).contacts;
            console.log(`Claude normalized via ${model}`);
            break;
          }
        } catch (e) {
          console.warn(`Claude ${model} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`Claude pass failed: ${(e as Error).message}`);
    }
  }

  // Insert into canonical row
  for (const c of categorized) {
    await sql.query(
      `INSERT INTO municipality_contacts
         (search_id, municipality_name, municipality_type, province,
          department, role, category, name, email, phone, address,
          website, source_url, services_summary, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        searchId,
        c.municipalityName.trim(),
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

  // Refresh canonical title
  const total = (await sql.query(
    `SELECT count(*)::int AS c FROM municipality_contacts WHERE search_id = $1`,
    [searchId],
  )) as Array<{ c: number }>;
  await sql.query(
    `UPDATE municipality_searches
       SET title = $1, requested_count = $2, updated_at = NOW()
       WHERE id = $3`,
    [
      `Quebec municipalities — comprehensive lead list (${total[0].c} verified)`,
      total[0].c,
      searchId,
    ],
  );

  console.log(`\n✓ Inserted ${categorized.length} engineering leads into search #${searchId}`);
  console.log(`  canonical row now has ${total[0].c} total contact(s)`);
  for (const c of categorized) {
    console.log(`\n• ${c.municipalityName} — ${c.role}`);
    console.log(`  src: ${c.sourceUrl}`);
    console.log(`  web: ${c.website}`);
    console.log(`  svc: ${(c.servicesSummary ?? "").slice(0, 140)}…`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
