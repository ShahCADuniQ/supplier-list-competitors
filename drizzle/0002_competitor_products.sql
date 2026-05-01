CREATE TABLE "competitor_product_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"kind" text,
	"url" text NOT NULL,
	"blob_pathname" text,
	"uploader_clerk_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"competitor_id" integer NOT NULL,
	"name" text NOT NULL,
	"product_code" text,
	"product_category" text,
	"description" text,
	"image_urls" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_product_attachments" ADD CONSTRAINT "competitor_product_attachments_product_id_competitor_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."competitor_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_products" ADD CONSTRAINT "competitor_products_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_product_attachments_product_idx" ON "competitor_product_attachments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "competitor_products_competitor_idx" ON "competitor_products" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "competitor_products_name_idx" ON "competitor_products" USING btree ("name");