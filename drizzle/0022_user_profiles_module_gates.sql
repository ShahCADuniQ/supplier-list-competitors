-- Expand user_profiles with per-module gates so the Admin matrix has one
-- toggle per sidebar surface. Each column defaults to false (locked out)
-- so existing approved users stay where they are; admins are auto-granted
-- the new flags in code (see permissions.ts and admin actions.ts).
--
-- Idempotent — safe to run twice. Code paths that read these columns use
-- the same self-healing ensure() helper described in
-- feedback_migration_forward_compat.md.

ALTER TABLE "user_profiles"
  ADD COLUMN IF NOT EXISTS "can_view_design_engineering" boolean NOT NULL DEFAULT false;
ALTER TABLE "user_profiles"
  ADD COLUMN IF NOT EXISTS "can_view_crm" boolean NOT NULL DEFAULT false;
ALTER TABLE "user_profiles"
  ADD COLUMN IF NOT EXISTS "can_view_oee" boolean NOT NULL DEFAULT false;

-- Auto-promote existing admins so they keep access to every sidebar surface
-- without an admin re-toggle. Members + pendings stay opt-in.
UPDATE "user_profiles"
  SET "can_view_design_engineering" = true,
      "can_view_crm" = true,
      "can_view_oee" = true
  WHERE "role" = 'admin';
