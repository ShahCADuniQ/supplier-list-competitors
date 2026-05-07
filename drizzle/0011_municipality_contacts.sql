CREATE TABLE IF NOT EXISTS "municipality_searches" (
  "id" serial PRIMARY KEY,
  "country" text NOT NULL DEFAULT 'Canada',
  "province" text NOT NULL,
  "scope_types" text NOT NULL DEFAULT 'all',
  "city_filter" text,
  "requested_count" integer NOT NULL DEFAULT 25,
  "title" text,
  "notes" text,
  "created_by_clerk_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_searches_province_idx" ON "municipality_searches" ("province");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_searches_created_at_idx" ON "municipality_searches" ("created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "municipality_contacts" (
  "id" serial PRIMARY KEY,
  "search_id" integer NOT NULL,
  "municipality_name" text NOT NULL,
  "municipality_type" text,
  "province" text NOT NULL,
  "department" text,
  "role" text,
  "category" text,
  "name" text,
  "email" text,
  "phone" text,
  "address" text,
  "website" text,
  "source_url" text,
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "municipality_contacts_search_id_fkey"
    FOREIGN KEY ("search_id") REFERENCES "municipality_searches"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_contacts_search_idx" ON "municipality_contacts" ("search_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_contacts_category_idx" ON "municipality_contacts" ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "municipality_contacts_province_idx" ON "municipality_contacts" ("province");
