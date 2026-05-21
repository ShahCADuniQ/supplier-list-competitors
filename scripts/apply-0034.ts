// One-off: apply migration 0034 only (the bulk apply-migrations script
// chokes on older multi-statement files that drizzle-kit actually ran
// outside its bookkeeping).

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = neon(url);

async function main() {
  const raw = readFileSync("drizzle/0034_supplier_inventory.sql", "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Applying 0034: ${statements.length} statement(s)`);
  for (let i = 0; i < statements.length; i++) {
    try {
      await sql.query(statements[i]);
      console.log(`  [${i + 1}] ok`);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/already exists|duplicate_object/i.test(msg)) {
        console.log(`  [${i + 1}] skipped (already exists)`);
        continue;
      }
      console.error(`  [${i + 1}] FAILED:`, msg);
      console.error(`  statement: ${statements[i].slice(0, 200)}…`);
      throw e;
    }
  }

  await sql.query(
    `INSERT INTO __applied_migrations (filename) VALUES ('0034_supplier_inventory.sql') ON CONFLICT DO NOTHING`,
  );

  // Sanity-check.
  const rows = await sql.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('supplier_products','supplier_product_attachments')`,
  );
  console.log("\nTables present:", rows);
}
main().catch((e) => { console.error(e); process.exit(1); });
