ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "competitor_id" integer;--> statement-breakpoint
ALTER TABLE "suppliers"
  DROP CONSTRAINT IF EXISTS "suppliers_competitor_id_fkey";--> statement-breakpoint
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_competitor_id_fkey"
  FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_competitor_idx" ON "suppliers" ("competitor_id");
