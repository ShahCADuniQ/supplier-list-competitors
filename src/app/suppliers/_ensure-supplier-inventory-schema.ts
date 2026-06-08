// Self-healing schema helper for the Supplier Inventory module (migration
// 0034). Same pattern as _ensure-orders-schema.ts — every server-action
// entry point that reads / writes the supplier_products tables calls this
// first so a fresh deploy without `npm run db:apply` keeps working.
// Memoized so it only runs once per process.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureSupplierInventorySchema(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "supplier_product_attachment_category" AS ENUM (
          'spec_datasheet',
          'quote_pricing',
          'contract_nda',
          'certification_compliance',
          'test_report_qc',
          'photo_media'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      // Migration 0035 — extra categories added after the supplier-portal
      // brief landed: IES photometric files, technical drawings, and a
      // catch-all "Other Files" bucket so suppliers can attach anything
      // with a comment. Idempotent — ALTER TYPE … ADD VALUE IF NOT EXISTS
      // is a no-op when the value already exists.
      await db.execute(sql`ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'ies_file'`);
      await db.execute(sql`ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'drawing'`);
      await db.execute(sql`ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'other_file'`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "supplier_products" (
          "id" serial PRIMARY KEY,
          "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
          "name" text NOT NULL,
          "product_code" text,
          "description" text,
          "category" text,
          "notes" text,
          "thumbnail_url" text,
          "thumbnail_pathname" text,
          "archived" boolean NOT NULL DEFAULT false,
          "created_by_role" text NOT NULL DEFAULT 'lightbase',
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_products_supplier_idx" ON "supplier_products" ("supplier_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_products_archived_idx" ON "supplier_products" ("archived")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_products_name_idx" ON "supplier_products" ("name")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "supplier_product_attachments" (
          "id" serial PRIMARY KEY,
          "product_id" integer NOT NULL REFERENCES "supplier_products"("id") ON DELETE CASCADE,
          "category" "supplier_product_attachment_category" NOT NULL,
          "name" text NOT NULL,
          "url" text NOT NULL,
          "blob_pathname" text,
          "content_type" text,
          "size" bigint NOT NULL DEFAULT 0,
          "notes" text,
          "uploaded_by_role" text NOT NULL DEFAULT 'lightbase',
          "uploaded_by_clerk_id" text,
          "uploaded_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_product_attachments_product_idx" ON "supplier_product_attachments" ("product_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_product_attachments_category_idx" ON "supplier_product_attachments" ("category")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_product_attachments_uploaded_idx" ON "supplier_product_attachments" ("uploaded_at")`);
      // Custom-section support: an optional free-text label stored
      // alongside category='other_file' so suppliers can roll their own
      // section names without us minting a new enum value per name.
      await db.execute(sql`ALTER TABLE "supplier_product_attachments" ADD COLUMN IF NOT EXISTS "custom_category_label" text`);
      // Part → model hierarchy. Top-level parts have parent_product_id
      // NULL; model rows reference their parent part. Self-FK with
      // ON DELETE CASCADE so deleting a part wipes its models in one
      // shot (and the attachment cascade on the model rows then drops
      // every model's files).
      await db.execute(sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "parent_product_id" integer`);
      await db.execute(sql`DO $$ BEGIN
        ALTER TABLE "supplier_products"
          ADD CONSTRAINT "supplier_products_parent_fk"
          FOREIGN KEY ("parent_product_id")
          REFERENCES "supplier_products"("id")
          ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_products_parent_idx" ON "supplier_products" ("parent_product_id")`);
      // Cross-supplier product identity + primary/secondary tagging.
      // globalProductId clusters rows that represent the same part
      // across multiple suppliers; isPrimarySupplier picks the chosen
      // one within each cluster.
      await db.execute(sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "global_product_id" text`);
      await db.execute(sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "is_primary_supplier" boolean NOT NULL DEFAULT true`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_products_global_idx" ON "supplier_products" ("global_product_id")`);
      // Backfill: every row that doesn't already have a
      // globalProductId gets a fresh one. Every part AND every
      // configuration has its OWN cluster id — configs no longer
      // inherit from their parent — so they can each be linked to
      // alternative configs (cross-supplier "same component, my
      // preferred variant") independently of the part cluster.
      await db.execute(sql`
        UPDATE "supplier_products"
          SET "global_product_id" = 'gp-' || gen_random_uuid()::text
          WHERE "global_product_id" IS NULL
      `);
      // One-time repair: configurations that previously inherited
      // their parent's globalProductId (older schema versions) get
      // their own fresh id so the part-level cluster doesn't bleed
      // through into the config-level cluster. Idempotent: after the
      // first run no config still shares its parent's id.
      await db.execute(sql`
        UPDATE "supplier_products" child
          SET "global_product_id" = 'gp-' || gen_random_uuid()::text
          FROM "supplier_products" parent
          WHERE child."parent_product_id" = parent."id"
            AND child."global_product_id" = parent."global_product_id"
            AND parent."global_product_id" IS NOT NULL
      `);
      // Product source URL — added so every product card can link back to
      // the brand storefront listing. Auto-filled by the Add Product
      // URL flow (top-level part uses the page URL, Shopify variants get
      // their variant URL).
      await db.execute(sql`ALTER TABLE "supplier_products" ADD COLUMN IF NOT EXISTS "product_url" text`);
    } catch (e) {
      _ensured = null; // allow retry on next call if this somehow failed
      throw e;
    }
  })();
  return _ensured;
}
