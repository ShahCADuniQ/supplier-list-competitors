ALTER TABLE "competitor_ideation_items" ADD COLUMN IF NOT EXISTS "extra_image_urls" text[] NOT NULL DEFAULT ARRAY[]::text[];--> statement-breakpoint
ALTER TABLE "competitor_ideation_items" ADD COLUMN IF NOT EXISTS "extra_blob_pathnames" text[] NOT NULL DEFAULT ARRAY[]::text[];
