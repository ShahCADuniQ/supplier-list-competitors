// Self-healing schema helper for the nomenclature feature. Memoised
// one-shot so repeated calls during a single process boot are free.
// Called by every nomenclature server action before it touches the
// new tables, so a freshly-deployed server doesn't 500 because Drizzle
// migrations haven't been applied yet.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  inventoryItems,
  nomenclatureParts,
  supplierProducts,
} from "@/db/schema";

let _ensured: Promise<void> | null = null;

export function ensureNomenclatureSchema(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "nomenclature_standards" (
          "id" serial PRIMARY KEY,
          "slug" text NOT NULL,
          "name" text NOT NULL,
          "class_code" text NOT NULL,
          "template" text NOT NULL,
          "spec_text" text NOT NULL,
          "source_path" text,
          "user_created" boolean NOT NULL DEFAULT false,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "nomenclature_standards_slug_idx" ON "nomenclature_standards" ("slug")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_standards_class_code_idx" ON "nomenclature_standards" ("class_code")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "nomenclature_parts" (
          "id" serial PRIMARY KEY,
          "unique_id" text NOT NULL,
          "kind" text NOT NULL,
          "class_code" text NOT NULL,
          "full_code" text NOT NULL,
          "standard_id" integer REFERENCES "nomenclature_standards"("id") ON DELETE SET NULL,
          "name" text,
          "description" text,
          "width_mm" integer,
          "height_mm" integer,
          "length_mm" integer,
          "configurations" jsonb DEFAULT '[]'::jsonb,
          "inventory_item_id" integer REFERENCES "inventory_items"("id") ON DELETE SET NULL,
          "parent_part_id" integer,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "nomenclature_parts_unique_id_idx" ON "nomenclature_parts" ("unique_id")`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "nomenclature_parts_full_code_idx" ON "nomenclature_parts" ("full_code")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_parts_kind_idx" ON "nomenclature_parts" ("kind")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_parts_standard_idx" ON "nomenclature_parts" ("standard_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_parts_inventory_idx" ON "nomenclature_parts" ("inventory_item_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_parts_parent_idx" ON "nomenclature_parts" ("parent_part_id")`);
      // V77 — Class code is now FAB/PHS/TLG; hardware codes embed P/A.
      await db.execute(sql`ALTER TABLE "nomenclature_parts" ADD COLUMN IF NOT EXISTS "part_or_assembly" text`);
      // V80 — Circular shape support: DXXXX replaces WXXXX-HXXXX.
      await db.execute(sql`ALTER TABLE "nomenclature_parts" ADD COLUMN IF NOT EXISTS "diameter_mm" integer`);

      // V85 — Free-form product / line grouping (e.g. "Lightline-X").
      await db.execute(sql`ALTER TABLE "nomenclature_parts" ADD COLUMN IF NOT EXISTS "product" text`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "nomenclature_parts_product_idx" ON "nomenclature_parts" ("product")`);
      // V86 — Mirror the product label onto inventory_items so the
      // /suppliers → Lightbase Inventory list can filter without
      // joining nomenclature_parts.
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "product" text`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_product_idx" ON "inventory_items" ("product")`);

      // V89 — inventory_attachments: CAD / drawings / images / docs /
      // links keyed off the inventory_items row.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "inventory_attachments" (
          "id" serial PRIMARY KEY,
          "inventory_item_id" integer NOT NULL REFERENCES "inventory_items"("id") ON DELETE CASCADE,
          "kind" text NOT NULL,
          "label" text NOT NULL,
          "url" text NOT NULL,
          "pathname" text,
          "content_type" text,
          "size_bytes" bigint,
          "notes" text,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_attachments_inventory_idx" ON "inventory_attachments" ("inventory_item_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_attachments_kind_idx" ON "inventory_attachments" ("kind")`);

      // V83 — assembly_bom: many-to-many edge table for the
      // assembly tree. Lazy-created here so the nomenclature page works
      // even when /suppliers hasn't been opened yet.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "assembly_bom" (
          "id" serial PRIMARY KEY,
          "parent_assembly_id" integer NOT NULL REFERENCES "inventory_items"("id") ON DELETE CASCADE,
          "child_item_id" integer NOT NULL REFERENCES "inventory_items"("id") ON DELETE CASCADE,
          "quantity" integer NOT NULL DEFAULT 1,
          "position" integer NOT NULL DEFAULT 0,
          "notes" text,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "assembly_bom_parent_idx" ON "assembly_bom" ("parent_assembly_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "assembly_bom_child_idx" ON "assembly_bom" ("child_item_id")`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "assembly_bom_unique_edge_idx" ON "assembly_bom" ("parent_assembly_id","child_item_id")`);

      // V90 — Auto-backfill: insert P / A after the unique ID in any
      // legacy nomenclature_parts row whose fullCode is missing it.
      // Idempotent; once every row is migrated the SELECT below
      // returns nothing and this is a no-op on every subsequent boot.
      await autoBackfillPartCodes();
    } catch (e) {
      _ensured = null;
      throw e;
    }
  })();
  return _ensured;
}

// V90 — One-time backfill that runs once per process boot inside the
// schema-ensure promise. Walks every nomenclature_parts row of
// kind='part' whose fullCode is missing the P/A segment after the
// unique ID and rewrites it (plus the linked inventory_items.code
// and any supplier_products.productCode pointing at the old code).
// Idempotent: rows already in the new shape are filtered out by the
// SQL split_part check, so this is a no-op on subsequent boots once
// the migration is complete.
async function autoBackfillPartCodes(): Promise<void> {
  try {
    // SELECT only rows that need fixing — segment 3 (1-indexed) is
    // neither 'P' nor 'A'. Anything that doesn't split into at least
    // 3 segments is skipped.
    const rows = await db
      .select({
        id: nomenclatureParts.id,
        fullCode: nomenclatureParts.fullCode,
        partOrAssembly: nomenclatureParts.partOrAssembly,
        inventoryItemId: nomenclatureParts.inventoryItemId,
      })
      .from(nomenclatureParts)
      .where(
        and(
          eq(nomenclatureParts.kind, "part"),
          sql`split_part(${nomenclatureParts.fullCode}, '-', 3) NOT IN ('P','A')`,
        ),
      );

    for (const r of rows) {
      let pa: "P" | "A" =
        r.partOrAssembly === "A"
          ? "A"
          : r.partOrAssembly === "P"
            ? "P"
            : "P";
      if (!r.partOrAssembly && r.inventoryItemId != null) {
        const [inv] = await db
          .select({ kind: inventoryItems.kind })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, r.inventoryItemId))
          .limit(1);
        if (inv?.kind === "assembly") pa = "A";
      }

      const segments = r.fullCode.split("-");
      if (segments.length < 2) continue;
      // Skip if a concurrent write already inserted it.
      if (segments[2] === "P" || segments[2] === "A") continue;

      const rewritten = [
        segments[0],
        segments[1],
        pa,
        ...segments.slice(2),
      ]
        .join("-")
        .toUpperCase();

      await db
        .update(nomenclatureParts)
        .set({
          fullCode: rewritten,
          partOrAssembly: pa,
          updatedAt: new Date(),
        })
        .where(eq(nomenclatureParts.id, r.id));

      if (r.inventoryItemId != null) {
        await db
          .update(inventoryItems)
          .set({ code: rewritten, updatedAt: new Date() })
          .where(eq(inventoryItems.id, r.inventoryItemId));
      }

      await db
        .update(supplierProducts)
        .set({ productCode: rewritten, updatedAt: new Date() })
        .where(eq(supplierProducts.productCode, r.fullCode));
    }

    if (rows.length > 0) {
      console.log(
        `[nomenclature] auto-backfilled ${rows.length} legacy code(s) with P/A`,
      );
    }
  } catch (e) {
    // Don't let a backfill error block schema-ensure. Worst case the
    // user sees old codes and can hit the manual button.
    console.warn(
      "[nomenclature] auto-backfill failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
