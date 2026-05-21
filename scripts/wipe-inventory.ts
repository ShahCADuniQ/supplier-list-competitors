// One-off cleanup: delete every inventory_items row (both parts AND
// assemblies — both live in the same table, distinguished by `kind`).
// Also clears the inventoryItemId / parentAssemblyId references on rfq_items
// so the rest of the order history doesn't dangle.
//
// User explicitly requested this in the chat ("delete everything that is in
// the inventory and assembly currently please").
//
// Run with: npx tsx --env-file=.env scripts/wipe-inventory.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

async function main() {
  const before = await sql.query(
    `SELECT
       COUNT(*)::int                                    AS total,
       COUNT(*) FILTER (WHERE kind = 'part')::int       AS parts,
       COUNT(*) FILTER (WHERE kind = 'assembly')::int   AS assemblies
     FROM inventory_items`,
  ) as Array<{ total: number; parts: number; assemblies: number }>;
  const { total, parts, assemblies } = before[0];
  console.log(`Before: ${total} inventory row(s) — ${parts} part(s), ${assemblies} assembl${assemblies === 1 ? "y" : "ies"}`);

  const orphans = await sql.query(
    `SELECT COUNT(*)::int AS n FROM rfq_items WHERE inventory_item_id IS NOT NULL`,
  ) as Array<{ n: number }>;
  console.log(`RFQ lines currently referencing inventory: ${orphans[0].n}`);

  if (total === 0 && orphans[0].n === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  // Null out references on rfq_items + purchase_order_lines so the surviving
  // order history doesn't dangle. (rfq_items.inventory_item_id has no FK so
  // a raw DELETE on inventory wouldn't cascade — clear it explicitly.)
  await sql.query(`UPDATE rfq_items SET inventory_item_id = NULL, lightbase_ref = NULL`);
  await sql.query(`UPDATE purchase_order_lines SET inventory_item_id = NULL, lightbase_ref = NULL`);
  // Then drop every inventory row. Parts AND assemblies are both in this
  // table (kind = 'part' or kind = 'assembly').
  await sql.query(`DELETE FROM inventory_items`);

  const after = await sql.query(
    `SELECT COUNT(*)::int AS n FROM inventory_items`,
  ) as Array<{ n: number }>;
  console.log(`After:  ${after[0].n} inventory row(s)`);
  console.log(`\nDeleted ${total} row(s). RFQ/PO references cleared. Done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
