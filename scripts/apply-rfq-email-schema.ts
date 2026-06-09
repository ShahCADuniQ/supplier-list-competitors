// Force the orders / RFQ schema ensure helper to run NOW. Useful after
// pulling code with new ALTER statements (e.g. rfq_email_drafts table).
// Run: npx tsx --env-file=.env scripts/apply-rfq-email-schema.ts

import { ensureOrdersSchema } from "../src/app/suppliers/_ensure-orders-schema";

ensureOrdersSchema()
  .then(() => {
    console.log("RFQ + email-drafts schema is up to date.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
