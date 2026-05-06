// Quick fix-up: lock the "parlaq interior" card (the one the user was
// viewing in the screenshot) to Lightline 5050 only. Same shape as
// test-link-card-to-lightline but matches by title.
//
// Usage: npx tsx --env-file=.env scripts/lock-parlaq-to-lightline.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}
const sql = neon(url);

async function main() {
  const products = (await sql.query(
    `SELECT id FROM ideation_products WHERE name = 'Lightline 5050' LIMIT 1`,
  )) as Array<{ id: number }>;
  if (products.length === 0) {
    console.error("Lightline 5050 not found.");
    process.exit(1);
  }
  const productId = products[0].id;

  const cards = (await sql.query(
    `SELECT id, title FROM competitor_ideation_items
     WHERE LOWER(title) LIKE '%parlaq%'
     ORDER BY id`,
  )) as Array<{ id: number; title: string }>;
  if (cards.length === 0) {
    console.error("No card with 'parlaq' in title found.");
    process.exit(1);
  }
  for (const c of cards) {
    await sql.query(
      `UPDATE competitor_ideation_items SET is_global = false, updated_at = now()
       WHERE id = $1`,
      [c.id],
    );
    await sql.query(
      `DELETE FROM ideation_item_products WHERE ideation_item_id = $1`,
      [c.id],
    );
    await sql.query(
      `INSERT INTO ideation_item_products (ideation_item_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [c.id, productId],
    );
    console.log(`✓ #${c.id} "${c.title}" → Lightline 5050 only`);
  }

  // Final summary
  const all = (await sql.query(
    `SELECT i.id, i.title, i.is_global,
            COALESCE(array_agg(p.product_id) FILTER (WHERE p.product_id IS NOT NULL), '{}') AS product_ids
     FROM competitor_ideation_items i
     LEFT JOIN ideation_item_products p ON p.ideation_item_id = i.id
     WHERE i.collection_id = (
       SELECT collection_id FROM ideation_products WHERE id = $1
     )
     GROUP BY i.id, i.title, i.is_global
     ORDER BY i.id`,
    [productId],
  )) as Array<{
    id: number;
    title: string | null;
    is_global: boolean;
    product_ids: number[];
  }>;
  console.log("\nFinal state of all cards in this collection:");
  for (const r of all) {
    console.log(
      `  #${r.id} "${r.title ?? "(no title)"}" — is_global=${r.is_global} — products=[${r.product_ids.join(",")}]`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
