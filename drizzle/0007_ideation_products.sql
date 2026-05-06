-- 0007 — ideation products: a "product we're developing" entity scoped to a
-- competitor collection, plus a many-to-many junction with ideation items.
-- Existing ideation rows get is_global=true so they continue to appear under
-- the "All products" filter without manual fixup.

CREATE TABLE IF NOT EXISTS "ideation_products" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "competitor_collections"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "color" text NOT NULL DEFAULT '#2563ff',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ideation_products_collection_idx"
  ON "ideation_products" ("collection_id");

CREATE TABLE IF NOT EXISTS "ideation_item_products" (
  "ideation_item_id" integer NOT NULL
    REFERENCES "competitor_ideation_items"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL
    REFERENCES "ideation_products"("id") ON DELETE CASCADE,
  PRIMARY KEY ("ideation_item_id", "product_id")
);

CREATE INDEX IF NOT EXISTS "ideation_item_products_product_idx"
  ON "ideation_item_products" ("product_id");

ALTER TABLE "competitor_ideation_items"
  ADD COLUMN IF NOT EXISTS "is_global" boolean NOT NULL DEFAULT true;
