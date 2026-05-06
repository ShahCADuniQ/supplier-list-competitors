// One-off seed: add "Lightline 5050" as an ideation product and link it to
// every existing ideation item (Pinterest card or otherwise) in the same
// collection. Idempotent — re-running won't create duplicates.
//
// Usage: npx tsx --env-file=.env scripts/seed-lightline-5050.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}
const sql = neon(url);

const PRODUCT_NAME = "Lightline 5050";
const PRODUCT_COLOR = "#2563ff"; // cobalt — first slot in the SaaS palette

async function main() {
  console.log("Connecting to database…");

  // 1. Find the target collection. If there's only one, use it.
  //    Otherwise, prefer "Linear Lighting" (the seeded default), else
  //    fall back to the first collection by id.
  const collections = (await sql.query(
    `SELECT id, name FROM competitor_collections ORDER BY id`,
  )) as Array<{ id: number; name: string }>;
  if (collections.length === 0) {
    console.error(
      "No competitor_collections found. Create a collection in the app first.",
    );
    process.exit(1);
  }
  console.log(
    `Found ${collections.length} collection(s):`,
    collections.map((c) => `${c.id}=${c.name}`).join(", "),
  );
  const target =
    collections.find((c) => /linear lighting/i.test(c.name)) ?? collections[0];
  console.log(`→ Using collection #${target.id} (${target.name})`);

  // 2. Insert the product if it doesn't already exist for this collection.
  const existing = (await sql.query(
    `SELECT id FROM ideation_products WHERE collection_id = $1 AND name = $2 LIMIT 1`,
    [target.id, PRODUCT_NAME],
  )) as Array<{ id: number }>;

  let productId: number;
  if (existing.length > 0) {
    productId = existing[0].id;
    console.log(`  Product "${PRODUCT_NAME}" already exists (id=${productId}).`);
  } else {
    const inserted = (await sql.query(
      `INSERT INTO ideation_products (collection_id, name, color)
       VALUES ($1, $2, $3) RETURNING id`,
      [target.id, PRODUCT_NAME, PRODUCT_COLOR],
    )) as Array<{ id: number }>;
    productId = inserted[0].id;
    console.log(`  Inserted product "${PRODUCT_NAME}" (id=${productId}).`);
  }

  // 3. Pull every ideation item in this collection.
  const items = (await sql.query(
    `SELECT id, title FROM competitor_ideation_items WHERE collection_id = $1`,
    [target.id],
  )) as Array<{ id: number; title: string | null }>;
  console.log(`  ${items.length} ideation item(s) in this collection.`);

  if (items.length === 0) {
    console.log("Done. Product added with no items to link.");
    return;
  }

  // 4. Insert junction rows linking the product to each item. Composite PK
  //    means a row already linking this pair will be a conflict — we skip
  //    those silently so the script stays idempotent.
  const values = items.map((i) => `(${i.id}, ${productId})`).join(",");
  const result = (await sql.query(
    `INSERT INTO ideation_item_products (ideation_item_id, product_id)
     VALUES ${values}
     ON CONFLICT (ideation_item_id, product_id) DO NOTHING`,
  )) as unknown;
  // Postgres reports the number of rows affected via @neondatabase result
  // metadata; we just log the input size.
  void result;
  console.log(
    `  Linked product to ${items.length} item(s) (existing links left untouched).`,
  );

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("\nSeed failed:", e);
  process.exit(1);
});
