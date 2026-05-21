-- Migration 0033 — IFC import + assembly hierarchy + qty lifecycle on inventory.
--
-- An inventory_items row can now be either a "part" or an "assembly". An
-- assembly is a parent that groups N child parts (each child has
-- parent_assembly_id set). The Inventory tab splits parts vs assemblies;
-- clicking an assembly shows its children as cards.
--
-- IFC-extracted physical properties live on every part (weight, surface
-- area, volume, material, density). An isometric thumbnail PNG (uploaded
-- to blob by the client-side IFC renderer) lives on `thumbnail_url`.
--
-- Qty lifecycle:
--   • pending_qty = sum of QTYs from RFQ-stage line items that link to
--     this part (i.e. requested but not yet ordered). Shown as "on
--     standby" in the inventory.
--   • confirmed_qty = sum of QTYs from PO-stage line items (PO already
--     sent → really ordered). Shown as "confirmed".

ALTER TABLE "inventory_items"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'part',
  ADD COLUMN IF NOT EXISTS "parent_assembly_id" integer
    REFERENCES "inventory_items"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "weight_g" numeric(14,4),
  ADD COLUMN IF NOT EXISTS "surface_area_mm2" numeric(16,4),
  ADD COLUMN IF NOT EXISTS "volume_mm3" numeric(16,4),
  ADD COLUMN IF NOT EXISTS "material" text,
  ADD COLUMN IF NOT EXISTS "density_g_cm3" numeric(10,4),
  ADD COLUMN IF NOT EXISTS "thumbnail_url" text,
  ADD COLUMN IF NOT EXISTS "thumbnail_pathname" text,
  ADD COLUMN IF NOT EXISTS "ifc_source_url" text,
  ADD COLUMN IF NOT EXISTS "ifc_source_name" text,
  ADD COLUMN IF NOT EXISTS "pending_qty" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "confirmed_qty" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "inventory_items_kind_idx" ON "inventory_items" ("kind");
CREATE INDEX IF NOT EXISTS "inventory_items_parent_idx" ON "inventory_items" ("parent_assembly_id");
