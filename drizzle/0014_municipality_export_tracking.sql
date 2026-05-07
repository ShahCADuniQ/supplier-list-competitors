ALTER TABLE "municipality_contacts"
  ADD COLUMN IF NOT EXISTS "exported_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_contacts_exported_at_idx"
  ON "municipality_contacts" ("exported_at");
