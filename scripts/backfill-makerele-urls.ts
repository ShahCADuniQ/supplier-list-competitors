// One-off backfill: set product_url on the MAKERELE Mini Junction Box part
// (#85) and its four configurations (#86-89). Re-fetches the Shopify JSON so
// each configuration gets its own ?variant=<id> URL keyed by SKU.
//
// Run: npx tsx --env-file=.env scripts/backfill-makerele-urls.ts

import { db } from "../src/db";
import { supplierProducts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { tryFetchShopifyProduct } from "../src/lib/ai/shopify";

const PAGE_URL =
  "https://makerele.com/products/makerele-mini-junction-box-outdoor-waterproof-ip68-underground-electrical-junction-box-maximum-inner-diameter-8mm";
const PART_ID = 85;

async function main() {
  const shopify = await tryFetchShopifyProduct(PAGE_URL);
  if (!shopify) {
    console.error("Could not fetch Shopify data; aborting.");
    process.exit(1);
  }

  const canonical = `${shopify.storefrontUrl}/products/${shopify.handle}`;
  console.log(`Part URL: ${canonical}`);

  // 1) Backfill the part itself
  await db
    .update(supplierProducts)
    .set({ productUrl: canonical, updatedAt: new Date() })
    .where(eq(supplierProducts.id, PART_ID));
  console.log(`Updated part #${PART_ID}`);

  // 2) Backfill each configuration under this part. Match by product_code
  //    (which we stored as the variant SKU at creation time).
  const configs = await db
    .select({
      id: supplierProducts.id,
      name: supplierProducts.name,
      productCode: supplierProducts.productCode,
    })
    .from(supplierProducts)
    .where(eq(supplierProducts.parentProductId, PART_ID));

  for (const cfg of configs) {
    const variant = shopify.variants.find(
      (v) =>
        (v.sku && cfg.productCode && v.sku.trim() === cfg.productCode.trim()) ||
        v.title === cfg.name,
    );
    if (!variant) {
      console.log(`  SKIP #${cfg.id} (${cfg.name}) — no matching variant`);
      continue;
    }
    const variantUrl = `${canonical}?variant=${variant.id}`;
    await db
      .update(supplierProducts)
      .set({ productUrl: variantUrl, updatedAt: new Date() })
      .where(eq(supplierProducts.id, cfg.id));
    console.log(`  Updated config #${cfg.id} (${cfg.name}) → ${variantUrl}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
