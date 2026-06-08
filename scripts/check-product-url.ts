// Diagnostic: does the supplier_products.product_url column exist, and how
// many rows have it set? Run with:
//   npx tsx --env-file=.env scripts/check-product-url.ts
import { db } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1) Does the column exist?
  const cols = (await db.execute(
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'supplier_products'
          AND column_name = 'product_url'`,
  )) as unknown as { rows?: Array<{ column_name: string }> } | Array<{ column_name: string }>;
  const colRows = Array.isArray(cols) ? cols : (cols.rows ?? []);
  const hasColumn = colRows.length > 0;
  console.log(`product_url column exists: ${hasColumn ? "YES" : "NO"}`);

  if (!hasColumn) {
    console.log("\nAdding the column now (idempotent ALTER):");
    await db.execute(
      sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "product_url" text`,
    );
    console.log("Done. Restart the dev server so the cached schema-ensure promise resets.");
    return;
  }

  // 2) Counts
  const counts = (await db.execute(
    sql`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE product_url IS NOT NULL AND product_url <> '') AS with_url,
          COUNT(*) FILTER (WHERE parent_product_id IS NULL) AS parts,
          COUNT(*) FILTER (WHERE parent_product_id IS NOT NULL) AS configs
        FROM supplier_products
        WHERE archived = false`,
  )) as unknown as { rows?: Array<Record<string, string | number>> } | Array<Record<string, string | number>>;
  const countRow = (Array.isArray(counts) ? counts : counts.rows ?? [])[0] ?? {};
  console.log(`\nRow counts:`);
  console.log(`  total:    ${countRow.total}`);
  console.log(`  parts:    ${countRow.parts}`);
  console.log(`  configs:  ${countRow.configs}`);
  console.log(`  with URL: ${countRow.with_url}`);

  // 3) Most recently created products + their URL state
  const recent = (await db.execute(
    sql`SELECT id, name, product_code, parent_product_id, product_url, created_at
        FROM supplier_products
        WHERE archived = false
        ORDER BY created_at DESC
        LIMIT 10`,
  )) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const recentRows = Array.isArray(recent) ? recent : recent.rows ?? [];
  console.log(`\nMost recent 10 products:`);
  for (const r of recentRows) {
    const url = r.product_url ? String(r.product_url).slice(0, 60) : "(null)";
    const kind = r.parent_product_id == null ? "part  " : "config";
    console.log(`  [${kind}] #${r.id}  ${String(r.name).slice(0, 40).padEnd(40)}  ${url}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
