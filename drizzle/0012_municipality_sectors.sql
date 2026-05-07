ALTER TABLE "municipality_searches"
  ADD COLUMN IF NOT EXISTS "sectors" text NOT NULL DEFAULT 'all';
