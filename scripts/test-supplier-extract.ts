// Smoke for extractSupplierProductFromUrl.
// Run: npx tsx --env-file=.env scripts/test-supplier-extract.ts <product-url>
import { extractSupplierProductFromUrl } from "../src/lib/ai/extract";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx scripts/test-supplier-extract.ts <product-url>");
    process.exit(1);
  }
  console.log(`Extracting: ${url}`);
  const t0 = Date.now();
  const result = await extractSupplierProductFromUrl({ url });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
