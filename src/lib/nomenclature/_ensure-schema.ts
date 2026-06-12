// Self-healing schema helper for the nomenclature feature. Memoised
// one-shot so repeated calls during a single process boot are free.
// Called by every nomenclature server action before it touches the
// new tables, so a freshly-deployed server doesn't 500 because Drizzle
// migrations haven't been applied yet.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  configurationOptions,
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

      // V92 — Multi-product membership: a part / assembly can now
      // belong to multiple products. Stored as a jsonb array of
      // strings on both nomenclature_parts and inventory_items. The
      // scalar `product` column is kept in sync with the first array
      // element so legacy reads keep working.
      await db.execute(sql`ALTER TABLE "nomenclature_parts" ADD COLUMN IF NOT EXISTS "products" jsonb DEFAULT '[]'::jsonb`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "products" jsonb DEFAULT '[]'::jsonb`);
      // V97 — Mirror nomenclature_parts.configurations onto
      // inventory_items so the InventoryDrawer can edit them on any
      // row, including those auto-minted from RFQs.
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "configurations" jsonb DEFAULT '[]'::jsonb`);
      // V102 — Starred flag for the Lightbase Inventory list. The
      // initial V102 default was "true for parts, false for
      // assemblies" but the team decided NOTHING should be auto-
      // starred — every row is opted in explicitly. So we ADD the
      // column unstarred-by-default, and (also in V103) flip every
      // pre-existing row to false in case the prior V102 self-heal
      // already wrote starred=true.
      await db.execute(sql`
        ALTER TABLE "inventory_items"
          ADD COLUMN IF NOT EXISTS "starred" boolean NOT NULL DEFAULT false
      `);
      await db.execute(sql`ALTER TABLE "inventory_items" ALTER COLUMN "starred" SET DEFAULT false`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_starred_idx" ON "inventory_items" ("starred")`);
      // V103 — One-shot reset: clear every star that the brief V102
      // auto-star left behind. Guarded by a tiny metadata flag so we
      // only ever do this once (a user who legitimately starred
      // something after V103 ships shouldn't get reset on the next
      // boot). The flag lives in a dedicated table.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "lb_one_shot_flags" (
          "flag" text PRIMARY KEY,
          "applied_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM "lb_one_shot_flags" WHERE "flag" = 'v103_reset_stars'
          ) THEN
            UPDATE "inventory_items" SET "starred" = false WHERE "starred" = true;
            INSERT INTO "lb_one_shot_flags" ("flag") VALUES ('v103_reset_stars');
          END IF;
        END $$;
      `);
      // V103 — is_configuration flag. Marks a tree card as "a
      // configuration variant of its parent" rather than a permanent
      // component. Default false; idempotent ADD COLUMN.
      await db.execute(sql`
        ALTER TABLE "inventory_items"
          ADD COLUMN IF NOT EXISTS "is_configuration" boolean NOT NULL DEFAULT false
      `);
      // V106 — itemClass groups inventory rows into the broader
      // catalogue tabs in /suppliers (Parts / Assemblies / Hardware
      // / Electronics / Adhesive-Sealants-Fillers). Independent of
      // `kind` so an assembly can still be itemClass='assembly' even
      // when itemClass-aware UIs route it into the Assemblies tab.
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "item_class" text`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_item_class_idx" ON "inventory_items" ("item_class")`);
      // V106 backfill (one-shot): any inventory row linked to a
      // nomenclature_parts row with kind='hardware' is auto-classed
      // as 'hardware'. Other rows are left NULL — the read path
      // falls back to the kind column (part vs assembly).
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM "lb_one_shot_flags" WHERE "flag" = 'v106_backfill_item_class'
          ) THEN
            UPDATE "inventory_items" AS i
              SET "item_class" = 'hardware'
              FROM "nomenclature_parts" AS np
              WHERE np."inventory_item_id" = i."id"
                AND np."kind" = 'hardware'
                AND i."item_class" IS NULL;
            INSERT INTO "lb_one_shot_flags" ("flag") VALUES ('v106_backfill_item_class');
          END IF;
        END $$;
      `);
      // V123 — non-hardware backfill: pin itemClass to the
      // nomenclature's P/A designation so a Part stays a Part even
      // after its kind got auto-flipped to 'assembly' by a drag-drop
      // child link. Overwrites NULL and 'part'/'assembly' that came
      // from the kind-fallback rule (but leaves 'hardware',
      // 'electronics', 'adhesive_sealant_filler' alone since those
      // are explicit catalogue classifications the user set).
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM "lb_one_shot_flags" WHERE "flag" = 'v123_backfill_part_assembly_class'
          ) THEN
            UPDATE "inventory_items" AS i
              SET "item_class" = CASE np."part_or_assembly"
                WHEN 'A' THEN 'assembly'
                WHEN 'P' THEN 'part'
              END
              FROM "nomenclature_parts" AS np
              WHERE np."inventory_item_id" = i."id"
                AND np."kind" = 'part'
                AND np."part_or_assembly" IN ('P', 'A')
                AND (
                  i."item_class" IS NULL
                  OR i."item_class" = 'part'
                  OR i."item_class" = 'assembly'
                );
            INSERT INTO "lb_one_shot_flags" ("flag") VALUES ('v123_backfill_part_assembly_class');
          END IF;
        END $$;
      `);
      // V113 — Manually-curated global product catalogue. Backs the
      // Database tab's "Manage products" editor so a user can add
      // a product label before any part is assigned to it and remove
      // labels that no longer apply. listProducts() reads from BOTH
      // this table AND the products[] columns on parts/inventory so
      // legacy data still surfaces.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "product_options" (
          "id" serial PRIMARY KEY,
          "name" text NOT NULL,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "product_options_name_idx" ON "product_options" ("name")`);
      // V98 — Global configuration_options catalogue. Every config
      // name ever attached to a part / assembly / hardware gets
      // upserted here so the chip-editor can offer typeahead.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "configuration_options" (
          "id" serial PRIMARY KEY,
          "name" text NOT NULL,
          "description" text,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "configuration_options_name_idx" ON "configuration_options" ("name")`);
      // Backfill from the existing scalar so the array is populated
      // for rows created before V92.
      await db.execute(sql`UPDATE "nomenclature_parts" SET "products" = jsonb_build_array("product") WHERE "product" IS NOT NULL AND ("products" IS NULL OR jsonb_array_length("products") = 0)`);
      await db.execute(sql`UPDATE "inventory_items" SET "products" = jsonb_build_array("product") WHERE "product" IS NOT NULL AND ("products" IS NULL OR jsonb_array_length("products") = 0)`);

      // V90 — Auto-backfill: insert P / A after the unique ID in any
      // legacy nomenclature_parts row whose fullCode is missing it.
      // Idempotent; once every row is migrated the SELECT below
      // returns nothing and this is a no-op on every subsequent boot.
      await autoBackfillPartCodes();
      // V100 — Backfill configuration_options from every existing
      // nomenclature_parts.configurations + inventory_items.configurations
      // entry. Pre-V98 rows never went through the auto-upsert path,
      // so the catalogue would otherwise stay empty for legacy data.
      await autoBackfillConfigurationOptions();
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

// V100 — Walk every nomenclature_parts and inventory_items row that
// carries a configurations array and upsert each entry into the
// configuration_options catalogue. Idempotent: existing rows are
// skipped (or their description is filled in if empty); duplicates
// across rows collapse into one catalogue entry. Errors are caught
// so a transient hiccup never blocks the rest of schema-ensure.
async function autoBackfillConfigurationOptions(): Promise<void> {
  try {
    const seen = new Map<string, string | null>();
    const sources: Array<{ configurations: unknown }> = [];
    try {
      const a = await db
        .select({ configurations: nomenclatureParts.configurations })
        .from(nomenclatureParts);
      sources.push(...a);
    } catch {
      // nomenclature_parts.configurations might not exist on very
      // fresh databases — that's fine, we'll still pick up inventory.
    }
    try {
      const b = await db
        .select({ configurations: inventoryItems.configurations })
        .from(inventoryItems);
      sources.push(...b);
    } catch {
      // Same idea — column might be missing during a partial migration.
    }

    for (const row of sources) {
      const arr = row.configurations;
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        let name = "";
        let description: string | null = null;
        if (typeof item === "string") {
          name = item.trim();
        } else if (item && typeof item === "object") {
          const obj = item as { name?: unknown; description?: unknown };
          name = typeof obj.name === "string" ? obj.name.trim() : "";
          description =
            typeof obj.description === "string" && obj.description.trim()
              ? obj.description.trim()
              : null;
        }
        if (!name) continue;
        const key = name.toUpperCase();
        const existing = seen.get(key);
        // Keep the first non-null description we encounter so the
        // catalogue ends up with the richest version available.
        if (description && !existing) {
          seen.set(key, description);
        } else if (!seen.has(key)) {
          seen.set(key, null);
        }
      }
    }

    let inserted = 0;
    let updated = 0;
    for (const [name, description] of seen.entries()) {
      const existing = await db
        .select({
          id: configurationOptions.id,
          description: configurationOptions.description,
        })
        .from(configurationOptions)
        .where(eq(configurationOptions.name, name))
        .limit(1);
      if (existing.length) {
        const current = existing[0].description?.trim() ?? null;
        if (description && !current) {
          await db
            .update(configurationOptions)
            .set({ description, updatedAt: new Date() })
            .where(eq(configurationOptions.id, existing[0].id));
          updated++;
        }
        continue;
      }
      try {
        await db.insert(configurationOptions).values({ name, description });
        inserted++;
      } catch {
        // Concurrent boot won the unique race — fine.
      }
    }

    if (inserted > 0 || updated > 0) {
      console.log(
        `[nomenclature] auto-backfilled configuration_options: ${inserted} new, ${updated} descriptions filled in.`,
      );
    }
  } catch (e) {
    console.warn(
      "[nomenclature] configuration_options auto-backfill failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
