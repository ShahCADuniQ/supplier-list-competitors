// Backfill: for every competitor row in the DB, ensure there's a
// matching supplier row with category="Competitor" and competitor_id
// linking back. Idempotent — re-running won't duplicate.
//
// Usage: npx tsx --env-file=.env scripts/backfill-competitor-suppliers.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}
const sql = neon(url);

async function main() {
  const competitors = (await sql.query(
    `SELECT id, name, website, country, segment, product_lines, notes
     FROM competitors ORDER BY id`,
  )) as Array<{
    id: number;
    name: string;
    website: string | null;
    country: string | null;
    segment: string | null;
    product_lines: string | null;
    notes: string | null;
  }>;
  console.log(`Found ${competitors.length} competitor(s).`);

  let inserted = 0;
  let already = 0;
  for (const c of competitors) {
    const existing = (await sql.query(
      `SELECT id FROM suppliers WHERE competitor_id = $1 LIMIT 1`,
      [c.id],
    )) as Array<{ id: number }>;
    if (existing.length > 0) {
      already++;
      continue;
    }
    await sql.query(
      `INSERT INTO suppliers
         (name, website, origin, category, sub_category, products, notes,
          status, competitor_id)
       VALUES ($1, $2, $3, 'Competitor', $4, $5, $6, 'Active', $7)`,
      [
        c.name,
        c.website,
        c.country,
        c.segment,
        c.product_lines,
        c.notes,
        c.id,
      ],
    );
    inserted++;
    console.log(`  + supplier mirror for #${c.id} "${c.name}"`);
  }

  console.log(
    `\nDone. Inserted ${inserted} new supplier mirror(s); ${already} already existed.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
