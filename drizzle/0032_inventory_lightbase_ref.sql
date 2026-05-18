-- Migration 0032 — Lightbase Ref. + inventory linkage.
--
-- Every RFQ / quote / PO line item now carries a "Lightbase Ref." that
-- ties it to a row in the new `inventory_items` table. This lets one
-- inventory part track every RFQ, quote, and PO ever issued against it
-- across multiple suppliers.
--
-- Auto-generation: when a buyer leaves Lightbase Ref. empty on a line,
-- the server mints the next sequential code (LB-NNNNNN, zero-padded to
-- six digits) AND creates a fresh inventory_items row keyed by that code.
-- When the buyer types an existing code, the server links the line to
-- that pre-existing item (or errors if the code is unknown — strict
-- mode so typos don't silently create duplicates).

CREATE TABLE IF NOT EXISTS "inventory_items" (
  "id" serial PRIMARY KEY,
  -- "Lightbase Ref." — globally unique short code. Format: LB-NNNNNN by
  -- default, but the buyer can override with any naming scheme they want
  -- (e.g. legacy SAP codes). Uniqueness enforced below.
  "code" text NOT NULL,
  "name" text,
  "description" text,
  "category" text,
  -- Unit of measure (each, m, kg, …). Used by inventory reports.
  "unit" text NOT NULL DEFAULT 'ea',
  -- Optional "preferred" supplier — purely advisory; doesn't constrain
  -- which suppliers can be invited.
  "default_supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "notes" text,
  "archived" boolean NOT NULL DEFAULT false,
  "created_by_clerk_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_code_idx" ON "inventory_items" ("code");
CREATE INDEX IF NOT EXISTS "inventory_items_category_idx" ON "inventory_items" ("category");
CREATE INDEX IF NOT EXISTS "inventory_items_archived_idx" ON "inventory_items" ("archived");

-- Link RFQ line items to their inventory part.
ALTER TABLE "rfq_items"
  ADD COLUMN IF NOT EXISTS "lightbase_ref" text,
  ADD COLUMN IF NOT EXISTS "inventory_item_id" integer
    REFERENCES "inventory_items"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "rfq_items_lightbase_ref_idx" ON "rfq_items" ("lightbase_ref");
CREATE INDEX IF NOT EXISTS "rfq_items_inventory_item_idx" ON "rfq_items" ("inventory_item_id");

-- Same on PO lines so the link survives the auto-PO-generation step.
ALTER TABLE "purchase_order_lines"
  ADD COLUMN IF NOT EXISTS "lightbase_ref" text,
  ADD COLUMN IF NOT EXISTS "inventory_item_id" integer
    REFERENCES "inventory_items"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "purchase_order_lines_lightbase_ref_idx" ON "purchase_order_lines" ("lightbase_ref");
CREATE INDEX IF NOT EXISTS "purchase_order_lines_inventory_item_idx" ON "purchase_order_lines" ("inventory_item_id");
