// One-off migration: the user added an Amazon "purchase source" with the
// previous (cluster-based) UI, which created a separate supplier_products
// row sharing the MAKERELE globalProductId. The new UI stores purchase
// sources as a JSONB list on the same product row. This migrates the
// orphan Amazon row into a purchase_sources entry on the MAKERELE part
// (#85), then deletes the orphan row so the catalogue stops showing a
// duplicate card.
//
// Idempotent: re-running won't re-add the entry (matched by URL) and the
// row deletion is a no-op once gone.
//
// Run: npx tsx --env-file=.env scripts/migrate-amazon-source-to-jsonb.ts

import { db } from "../src/db";
import { supplierProducts, suppliers } from "../src/db/schema";
import { and, eq, ne, isNotNull, sql } from "drizzle-orm";

const MAKERELE_PART_ID = 85;

async function main() {
  // Self-heal the column in case the dev server hasn't run the ensure
  // helper since the schema change landed. Idempotent.
  await db.execute(
    sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "purchase_sources" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );

  const [anchor] = await db
    .select({
      id: supplierProducts.id,
      globalProductId: supplierProducts.globalProductId,
      purchaseSources: supplierProducts.purchaseSources,
    })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, MAKERELE_PART_ID))
    .limit(1);
  if (!anchor) {
    console.error(`Anchor part #${MAKERELE_PART_ID} not found`);
    process.exit(1);
  }
  if (!anchor.globalProductId) {
    console.error("Anchor has no globalProductId; nothing to migrate from.");
    process.exit(0);
  }

  // Find orphan cluster siblings (same globalProductId, NOT the anchor)
  // with their supplier name + URL so we can fold them into the JSONB list.
  const orphans = await db
    .select({
      id: supplierProducts.id,
      supplierName: suppliers.name,
      supplierWebsite: suppliers.website,
      productUrl: supplierProducts.productUrl,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        eq(supplierProducts.globalProductId, anchor.globalProductId),
        ne(supplierProducts.id, anchor.id),
        isNotNull(supplierProducts.productUrl),
      ),
    );

  console.log(`Found ${orphans.length} orphan source row(s) to migrate.`);

  const current = anchor.purchaseSources ?? [];
  const existingUrls = new Set(current.map((s) => s.url.toLowerCase()));
  const next = [...current];
  for (const o of orphans) {
    if (!o.productUrl) continue;
    if (existingUrls.has(o.productUrl.toLowerCase())) {
      console.log(`  skip #${o.id} (URL already in JSONB list)`);
      continue;
    }
    next.push({
      id: crypto.randomUUID(),
      name: o.supplierName,
      url: o.productUrl,
      website: o.supplierWebsite,
      addedAt: new Date().toISOString(),
    });
    console.log(`  add  #${o.id} -> ${o.supplierName}: ${o.productUrl.slice(0, 60)}`);
  }

  if (next.length !== current.length) {
    await db
      .update(supplierProducts)
      .set({ purchaseSources: next, updatedAt: new Date() })
      .where(eq(supplierProducts.id, anchor.id));
    console.log(`Updated part #${anchor.id} with ${next.length} purchase source(s).`);
  } else {
    console.log("No new entries to add.");
  }

  // Now delete the orphan rows so they stop appearing as duplicate
  // catalogue cards.
  for (const o of orphans) {
    await db.delete(supplierProducts).where(eq(supplierProducts.id, o.id));
    console.log(`Deleted orphan row #${o.id}.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
