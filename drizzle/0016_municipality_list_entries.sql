CREATE TABLE IF NOT EXISTS "municipality_list_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_code" text,
  "name" text NOT NULL,
  "designation_code" integer,
  "designation" text,
  "gentile" text,
  "email" text,
  "website" text,
  "phone" text,
  "fax" text,
  "address_line" text,
  "address_city" text,
  "address_postal" text,
  "region" text,
  "mrc" text,
  "mrc_full" text,
  "area_km2" numeric,
  "population" integer,
  "date_incorporation" text,
  "date_election" text,
  "election_mode" text,
  "circonscription" text,
  "mayor" text,
  "councillors" jsonb,
  "director_general" text,
  "deputy_dg" text,
  "treasurer" text,
  "clerk" text,
  "police_chief" text,
  "fire_chief" text,
  "recreation_director" text,
  "public_works_director" text,
  "emergency_measures" text,
  "urban_planner" text,
  "communications" text,
  "permits" text,
  "building_inspector" text,
  "notes" text,
  "is_imported" boolean DEFAULT true NOT NULL,
  "created_by_clerk_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "municipality_list_entries_source_code_idx"
  ON "municipality_list_entries" ("source_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_list_entries_name_idx"
  ON "municipality_list_entries" ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_list_entries_region_idx"
  ON "municipality_list_entries" ("region");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_list_entries_mrc_idx"
  ON "municipality_list_entries" ("mrc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_list_entries_designation_idx"
  ON "municipality_list_entries" ("designation");
