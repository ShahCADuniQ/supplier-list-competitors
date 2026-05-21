-- Supplier product catalog — each vendor's "what we sell" list, distinct
-- from inventory_items (Lightbase's parts/assemblies). Both Lightbase
-- admins (Supplier Inventory tab) and suppliers themselves (portal) can
-- create + edit rows.

CREATE TABLE IF NOT EXISTS "supplier_products" (
  "id"                    serial PRIMARY KEY,
  "supplier_id"           integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "name"                  text NOT NULL,
  "product_code"          text,
  "description"           text,
  "category"              text,
  "notes"                 text,
  "thumbnail_url"         text,
  "thumbnail_pathname"    text,
  "archived"              boolean NOT NULL DEFAULT false,
  "created_by_role"       text NOT NULL DEFAULT 'lightbase',
  "created_by_clerk_id"   text,
  "created_at"            timestamp NOT NULL DEFAULT now(),
  "updated_at"            timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_products_supplier_idx" ON "supplier_products" ("supplier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_products_archived_idx" ON "supplier_products" ("archived");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_products_name_idx" ON "supplier_products" ("name");
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "supplier_product_attachment_category" AS ENUM (
    'spec_datasheet',
    'quote_pricing',
    'contract_nda',
    'certification_compliance',
    'test_report_qc',
    'photo_media'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_product_attachments" (
  "id"                    serial PRIMARY KEY,
  "product_id"            integer NOT NULL REFERENCES "supplier_products"("id") ON DELETE CASCADE,
  "category"              "supplier_product_attachment_category" NOT NULL,
  "name"                  text NOT NULL,
  "url"                   text NOT NULL,
  "blob_pathname"         text,
  "content_type"          text,
  "size"                  bigint NOT NULL DEFAULT 0,
  "notes"                 text,
  "uploaded_by_role"      text NOT NULL DEFAULT 'lightbase',
  "uploaded_by_clerk_id"  text,
  "uploaded_at"           timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_product_attachments_product_idx" ON "supplier_product_attachments" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_product_attachments_category_idx" ON "supplier_product_attachments" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_product_attachments_uploaded_idx" ON "supplier_product_attachments" ("uploaded_at");
