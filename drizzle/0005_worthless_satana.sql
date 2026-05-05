CREATE TYPE "public"."competitor_ideation_kind" AS ENUM('reference', 'sketch', 'moodboard', 'mounting', 'ai-generated');--> statement-breakpoint
CREATE TABLE "competitor_ideation_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection_id" integer NOT NULL,
	"title" text,
	"notes" text,
	"image_url" text NOT NULL,
	"blob_pathname" text,
	"mime_type" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"kind" "competitor_ideation_kind" DEFAULT 'reference' NOT NULL,
	"competitor_id" integer,
	"product_id" integer,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"added_by_clerk_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_ideation_items" ADD CONSTRAINT "competitor_ideation_items_collection_id_competitor_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."competitor_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_ideation_items" ADD CONSTRAINT "competitor_ideation_items_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_ideation_items" ADD CONSTRAINT "competitor_ideation_items_product_id_competitor_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."competitor_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_ideation_collection_idx" ON "competitor_ideation_items" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "competitor_ideation_competitor_idx" ON "competitor_ideation_items" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "competitor_ideation_product_idx" ON "competitor_ideation_items" USING btree ("product_id");