CREATE TABLE IF NOT EXISTS "ideation_product_files" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "competitor_collections"("id") ON DELETE CASCADE,
  "product_id" integer REFERENCES "ideation_products"("id") ON DELETE CASCADE,
  "file_kind" text NOT NULL,
  "name" text NOT NULL,
  "size" bigint NOT NULL DEFAULT 0,
  "mime_type" text,
  "url" text NOT NULL,
  "blob_pathname" text,
  "uploader_clerk_id" text,
  "added_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideation_product_files_product_idx" ON "ideation_product_files" ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideation_product_files_collection_idx" ON "ideation_product_files" ("collection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideation_product_files_kind_idx" ON "ideation_product_files" ("file_kind");
