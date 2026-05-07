CREATE TABLE IF NOT EXISTS "municipality_contact_exports" (
  "contact_id" integer NOT NULL,
  "clerk_user_id" text NOT NULL,
  "exported_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "municipality_contact_exports_pk"
    PRIMARY KEY ("contact_id", "clerk_user_id"),
  CONSTRAINT "municipality_contact_exports_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "municipality_contacts"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_contact_exports_user_idx"
  ON "municipality_contact_exports" ("clerk_user_id");
