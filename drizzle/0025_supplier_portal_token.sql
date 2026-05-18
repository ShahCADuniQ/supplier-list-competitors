-- Long-lived magic-link token for the supplier's home portal at
-- /vendor/home/[token]. Distinct from per-RFQ tokens so the admin can
-- revoke the supplier's entire portal access without invalidating
-- in-flight RFQ quotes.

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "portal_token" text;

CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_portal_token_idx"
  ON "suppliers" ("portal_token");
