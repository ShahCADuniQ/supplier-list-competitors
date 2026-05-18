-- Migration 0030 — three improvements to the RFQ → quote → PO workflow:
--   1. rfq_item_attachments: multiple photos + docs per line item (replaces
--      the singular catalog_attachment_url/name on rfq_items, which we keep
--      around for back-compat and treat as the first attachment).
--   2. suppliers.logo_url / clients.logo_url: each party's brand mark that
--      appears as letterhead on every generated RFQ / Quote / PO PDF.
--   3. po_invoices already covers invoice files; no change there.

CREATE TABLE IF NOT EXISTS "rfq_item_attachments" (
  "id" serial PRIMARY KEY,
  "rfq_item_id" integer NOT NULL REFERENCES "rfq_items"("id") ON DELETE CASCADE,
  -- "photo" = product image to show inline. "doc" = catalog / datasheet / spec
  -- sheet (PDF / Excel / etc.) shown as a downloadable chip.
  "kind" text NOT NULL DEFAULT 'doc',
  "name" text NOT NULL,
  "url" text NOT NULL,
  "blob_pathname" text,
  "content_type" text,
  "size" bigint NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "rfq_item_attachments_item_idx" ON "rfq_item_attachments" ("rfq_item_id");
CREATE INDEX IF NOT EXISTS "rfq_item_attachments_kind_idx" ON "rfq_item_attachments" ("kind");

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "logo_url" text,
  ADD COLUMN IF NOT EXISTS "logo_name" text,
  ADD COLUMN IF NOT EXISTS "logo_pathname" text;

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "logo_url" text,
  ADD COLUMN IF NOT EXISTS "logo_name" text,
  ADD COLUMN IF NOT EXISTS "logo_pathname" text;
