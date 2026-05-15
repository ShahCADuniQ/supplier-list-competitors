-- "Current suppliers" list at the top of /suppliers — a curated subset of
-- who Lightbase actively buys from. Each row carries a single boolean so
-- the dashboard can render the "starred" panel with no extra joins.
--
-- Idempotent (the codebase has self-heal in src/app/suppliers/actions.ts
-- per feedback_migration_forward_compat.md).

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "is_starred" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "suppliers_starred_idx" ON "suppliers" ("is_starred");
