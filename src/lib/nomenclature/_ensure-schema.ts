// Self-healing schema helper for the nomenclature feature. Memoised
// one-shot so repeated calls during a single process boot are free.
// Called by every nomenclature server action before it touches the
// new tables, so a freshly-deployed server doesn't 500 because Drizzle
// migrations haven't been applied yet.

import { sql } from "drizzle-orm";
import { db } from "@/db";

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
    } catch (e) {
      _ensured = null;
      throw e;
    }
  })();
  return _ensured;
}
