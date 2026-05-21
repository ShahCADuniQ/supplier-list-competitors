-- Extend the supplier_product_attachment_category enum with three new
-- buckets needed by the supplier-portal upload UI:
--   • ies_file   — IES photometric files (lighting design)
--   • drawing    — Technical drawings (CAD / PDF)
--   • other_file — Catch-all for anything else, paired with a comment
--
-- ALTER TYPE … ADD VALUE IF NOT EXISTS is fully idempotent on pg ≥ 9.6.

ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'ies_file';
--> statement-breakpoint
ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'drawing';
--> statement-breakpoint
ALTER TYPE "supplier_product_attachment_category" ADD VALUE IF NOT EXISTS 'other_file';
