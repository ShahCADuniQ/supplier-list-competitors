// Merge multiple "Quebec municipalities — comprehensive lead list" search
// rows into a single canonical row, deduplicating contacts by
// `lower(municipality_name)::lower(role)`.
//
// Usage: npx tsx --env-file=.env scripts/merge-comprehensive-searches.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = neon(url);

function dedupKey(name: string | null, role: string | null): string {
  const m = (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const r = (role ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${m}::${r}`;
}

async function main() {
  const searches = (await sql.query(
    `SELECT id, title, created_at, (SELECT count(*) FROM municipality_contacts WHERE search_id = ms.id) AS contacts
       FROM municipality_searches ms
      WHERE province = 'Quebec' AND title LIKE 'Quebec municipalities — comprehensive%'
      ORDER BY id ASC`,
  )) as Array<{ id: number; title: string; created_at: string; contacts: string }>;

  if (searches.length < 2) {
    console.log(`Found ${searches.length} comprehensive search(es). Nothing to merge.`);
    return;
  }
  console.log(`Found ${searches.length} comprehensive searches:`);
  for (const s of searches) console.log(`  #${s.id} · ${s.contacts} contacts · ${s.created_at}`);

  // Use the OLDEST search row as the canonical id (smaller id, earlier date),
  // so links / saved-search positions stay stable for users who already have
  // that view open.
  const target = searches[0];
  const others = searches.slice(1);
  console.log(`\nKeeping #${target.id} as the canonical row; folding others into it.`);

  // Step 1: re-parent every contact from the other searches to the target.
  for (const s of others) {
    const moved = (await sql.query(
      `UPDATE municipality_contacts SET search_id = $1 WHERE search_id = $2 RETURNING id`,
      [target.id, s.id],
    )) as Array<{ id: number }>;
    console.log(`  re-parented ${moved.length} contact(s) from #${s.id} → #${target.id}`);
  }

  // Step 2: dedupe — within the merged set, keep the lowest id per
  // (municipality_name, role) tuple and delete the rest.
  const all = (await sql.query(
    `SELECT id, municipality_name, role
       FROM municipality_contacts WHERE search_id = $1
       ORDER BY id ASC`,
    [target.id],
  )) as Array<{ id: number; municipality_name: string; role: string | null }>;
  const seen = new Map<string, number>();
  const toDelete: number[] = [];
  for (const c of all) {
    const k = dedupKey(c.municipality_name, c.role);
    if (seen.has(k)) toDelete.push(c.id);
    else seen.set(k, c.id);
  }
  if (toDelete.length > 0) {
    // Delete in chunks to keep query small.
    for (let i = 0; i < toDelete.length; i += 100) {
      const chunk = toDelete.slice(i, i + 100);
      await sql.query(
        `DELETE FROM municipality_contacts WHERE id = ANY($1::int[])`,
        [chunk],
      );
    }
    console.log(`  deleted ${toDelete.length} duplicate(s) within merged set`);
  } else {
    console.log(`  no duplicates between merged sets`);
  }

  // Step 3: delete the now-empty other search rows.
  for (const s of others) {
    await sql.query(`DELETE FROM municipality_searches WHERE id = $1`, [s.id]);
    console.log(`  deleted empty search #${s.id}`);
  }

  // Step 4: refresh the target search title + count.
  const finalCount = (await sql.query(
    `SELECT count(*)::int AS c FROM municipality_contacts WHERE search_id = $1`,
    [target.id],
  )) as Array<{ c: number }>;
  const newTitle = `Quebec municipalities — comprehensive lead list (${finalCount[0].c} verified)`;
  await sql.query(
    `UPDATE municipality_searches SET title = $1, requested_count = $2, updated_at = NOW() WHERE id = $3`,
    [newTitle, finalCount[0].c, target.id],
  );
  console.log(`\n✓ Merged. Search #${target.id} now has ${finalCount[0].c} unique contact(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
