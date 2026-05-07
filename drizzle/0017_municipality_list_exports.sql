CREATE TABLE IF NOT EXISTS "municipality_list_exports" (
  "entry_id" integer NOT NULL,
  "clerk_user_id" text NOT NULL,
  "exported_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "municipality_list_exports_pk"
    PRIMARY KEY ("entry_id", "clerk_user_id"),
  CONSTRAINT "municipality_list_exports_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "municipality_list_entries"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_list_exports_user_idx"
  ON "municipality_list_exports" ("clerk_user_id");
