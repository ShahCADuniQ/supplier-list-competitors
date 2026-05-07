ALTER TABLE "municipality_contacts"
  ADD COLUMN IF NOT EXISTS "services_summary" text;
