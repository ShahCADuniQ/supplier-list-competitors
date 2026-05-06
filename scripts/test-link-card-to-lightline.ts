// Test seed: pick one ideation card and make it linked *only* to
// Lightline 5050 (not global). Verifies the per-product linkage flow
// end-to-end: is_global=false on the card + one ideation_item_products
// junction row pointing at Lightline 5050.
//
// Idempotent. Safe to re-run; it just re-asserts the same state.
//
// Usage: npx tsx --env-file=.env scripts/test-link-card-to-lightline.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}
const sql = neon(url);

const PRODUCT_NAME = "Lightline 5050";

async function main() {
  console.log("Connecting to database…");

  // 1. Find the Lightline 5050 product.
  const products = (await sql.query(
    `SELECT id, collection_id, name FROM ideation_products WHERE name = $1 LIMIT 1`,
    [PRODUCT_NAME],
  )) as Array<{ id: number; collection_id: number; name: string }>;
  if (products.length === 0) {
    console.error(
      `Product "${PRODUCT_NAME}" not found. Run seed-lightline-5050.ts first.`,
    );
    process.exit(1);
  }
  const product = products[0];
  console.log(
    `Found product #${product.id} "${product.name}" in collection #${product.collection_id}`,
  );

  // 2. Find ideation cards in the same collection.
  const cards = (await sql.query(
    `SELECT id, title, is_global FROM competitor_ideation_items
     WHERE collection_id = $1 ORDER BY id LIMIT 10`,
    [product.collection_id],
  )) as Array<{ id: number; title: string | null; is_global: boolean }>;
  if (cards.length === 0) {
    console.error("No ideation cards found in this collection.");
    process.exit(1);
  }
  console.log(`Found ${cards.length} cards in this collection:`);
  for (const c of cards) {
    console.log(
      `  #${c.id} "${c.title ?? "(no title)"}" — is_global=${c.is_global}`,
    );
  }

  // 3. Pick the first card (by id) and lock it to Lightline 5050 only.
  const target = cards[0];
  console.log(
    `\n→ Locking card #${target.id} "${target.title ?? "(no title)"}" to ${PRODUCT_NAME} only.`,
  );

  // a) Flip is_global to false.
  await sql.query(
    `UPDATE competitor_ideation_items SET is_global = false, updated_at = now()
     WHERE id = $1`,
    [target.id],
  );
  console.log(`  ✓ Set is_global = false on card #${target.id}`);

  // b) Wipe any existing junction rows for this card, then insert exactly one.
  await sql.query(
    `DELETE FROM ideation_item_products WHERE ideation_item_id = $1`,
    [target.id],
  );
  await sql.query(
    `INSERT INTO ideation_item_products (ideation_item_id, product_id)
     VALUES ($1, $2)
     ON CONFLICT (ideation_item_id, product_id) DO NOTHING`,
    [target.id, product.id],
  );
  console.log(`  ✓ Junction row: card #${target.id} → product #${product.id}`);

  // 4. Verify final state.
  const verifyCard = (await sql.query(
    `SELECT id, is_global FROM competitor_ideation_items WHERE id = $1`,
    [target.id],
  )) as Array<{ id: number; is_global: boolean }>;
  const verifyJunction = (await sql.query(
    `SELECT product_id FROM ideation_item_products WHERE ideation_item_id = $1`,
    [target.id],
  )) as Array<{ product_id: number }>;
  console.log("\nVerification:");
  console.log(
    `  card #${target.id}: is_global=${verifyCard[0]?.is_global}` +
      ` (expected false)`,
  );
  console.log(
    `  junction rows: ${verifyJunction
      .map((r) => `→${r.product_id}`)
      .join(", ")} (expected →${product.id})`,
  );

  // 5. Quick summary of what each pill should now show.
  const counts = (await sql.query(
    `SELECT
       (SELECT COUNT(*) FROM competitor_ideation_items WHERE collection_id = $1) AS total,
       (SELECT COUNT(*) FROM competitor_ideation_items WHERE collection_id = $1 AND is_global = true) AS global_count,
       (SELECT COUNT(*) FROM ideation_item_products WHERE product_id = $2) AS lightline_junction_count`,
    [product.collection_id, product.id],
  )) as Array<{
    total: string;
    global_count: string;
    lightline_junction_count: string;
  }>;
  const c = counts[0];
  console.log("\nExpected pill counts in the UI:");
  console.log(`  All ideas: ${c.total}`);
  console.log(`  Global only: ${c.global_count}`);
  console.log(
    `  ${PRODUCT_NAME}: ${c.global_count} (global) + ${c.lightline_junction_count} (explicit) = ${
      Number(c.global_count) + Number(c.lightline_junction_count)
    }`,
  );

  console.log("\nDone. Refresh the Ideation board to see the new state.");
}

main().catch((e) => {
  console.error("\nTest seed failed:", e);
  process.exit(1);
});
