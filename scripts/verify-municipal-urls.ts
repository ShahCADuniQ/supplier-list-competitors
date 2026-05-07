// One-shot: HEAD-check every sourceUrl + website on existing
// municipality_contacts rows and null out the dead ones. Run after
// the URL-verification fix lands so the seed test rows from earlier
// stop showing 404 links in the UI.
//
// Usage: npx tsx --env-file=.env scripts/verify-municipal-urls.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

async function check(u: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(u)) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
      },
    }).catch(() => null);
    if (!res) return false;
    if (res.status < 400) return true;
    if (res.status === 401 || res.status === 403) return true; // bot wall
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const rows = (await sql.query(
    `SELECT id, source_url, website FROM municipality_contacts
       WHERE source_url IS NOT NULL OR website IS NOT NULL`,
  )) as Array<{ id: number; source_url: string | null; website: string | null }>;
  console.log(`Verifying ${rows.length} contact row(s)…`);

  // Distinct URLs first.
  const allUrls = new Set<string>();
  for (const r of rows) {
    if (r.source_url) allUrls.add(r.source_url);
    if (r.website) allUrls.add(r.website);
  }
  const status = new Map<string, boolean>();
  const queue = [...allUrls];
  console.log(`  ${queue.length} unique URL(s) to check`);

  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u) return;
      const ok = await check(u);
      status.set(u, ok);
      if (!ok) console.log(`  ✗ ${u}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Apply: null out columns where the URL didn't resolve.
  let updates = 0;
  for (const r of rows) {
    const patches: string[] = [];
    const params: Array<unknown> = [];
    if (r.source_url && !status.get(r.source_url)) {
      patches.push(`source_url = NULL`);
    }
    if (r.website && !status.get(r.website)) {
      patches.push(`website = NULL`);
    }
    if (patches.length === 0) continue;
    params.push(r.id);
    await sql.query(
      `UPDATE municipality_contacts SET ${patches.join(", ")} WHERE id = $${params.length}`,
      params,
    );
    updates++;
  }
  console.log(`\nUpdated ${updates} contact row(s) — removed broken URLs.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
