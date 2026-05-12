-- Adds a content-hash column used by refreshProductSpecsFromFiles to skip
-- Claude PDF analysis when a product's inputs (attachments + sourceUrl +
-- model) haven't changed since the last successful run. Saves the bulk
-- "Re-analyze all" button from re-paying for unchanged products.
ALTER TABLE "competitor_products"
  ADD COLUMN IF NOT EXISTS "specs_analysis_hash" text;
