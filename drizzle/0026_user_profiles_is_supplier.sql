-- Marks a user_profiles row as a "supplier user" (vs internal staff).
-- Auto-set on first sign-in when the email matches a row in `suppliers`.
-- Supplier users get the vendor portal at /portal and are blocked from
-- every internal section. See src/lib/permissions.ts (ensureUserProfileColumns,
-- detectSupplierFromEmail).

ALTER TABLE "user_profiles"
  ADD COLUMN IF NOT EXISTS "is_supplier" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "user_profiles_is_supplier_idx"
  ON "user_profiles" ("is_supplier");
