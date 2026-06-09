// Force the supplier-inventory schema ensure helper to run NOW (outside of
// a server-action context). Useful after pulling code with new ALTER
// statements so the next dev-server boot doesn't need to wait for the
// first request to migrate.
//
// Run: npx tsx --env-file=.env scripts/run-supplier-inventory-ensure.ts

import { ensureSupplierInventorySchema } from "../src/app/suppliers/_ensure-supplier-inventory-schema";

ensureSupplierInventorySchema()
  .then(() => {
    console.log("Schema is up to date.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
