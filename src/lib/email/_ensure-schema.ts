// Self-healing schema helpers for the email integration feature.
// Split into two independently-memoised promises so adding new columns
// in a later release isn't gated by the old promise resolving in an
// earlier process run.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _connectionsEnsured: Promise<void> | null = null;
let _tenantColumnsEnsured: Promise<void> | null = null;

async function ensureUserEmailConnectionsTable(): Promise<void> {
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "email_provider" AS ENUM ('microsoft','google');
  EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_email_connections" (
      "id" serial PRIMARY KEY,
      "clerk_user_id" text NOT NULL,
      "provider" "email_provider" NOT NULL,
      "email_address" text NOT NULL,
      "access_token_encrypted" text NOT NULL,
      "refresh_token_encrypted" text,
      "expires_at" timestamp NOT NULL,
      "scope" text,
      "last_sync_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "user_email_connections_user_provider_idx" ON "user_email_connections" ("clerk_user_id","provider")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "user_email_connections_clerk_user_idx" ON "user_email_connections" ("clerk_user_id")`);
}

async function ensureClientsTenantColumns(): Promise<void> {
  // Per-tenant approval columns added in V73. ADD COLUMN IF NOT EXISTS
  // is idempotent so re-running this on an already-migrated DB is free.
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_status" text NOT NULL DEFAULT 'none'`);
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_requested_by" text`);
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_requested_at" timestamp`);
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_decided_by" text`);
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_decided_at" timestamp`);
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_notes" text`);
}

export function ensureEmailConnectionsSchema(): Promise<void> {
  if (!_connectionsEnsured) {
    _connectionsEnsured = (async () => {
      try {
        await ensureUserEmailConnectionsTable();
      } catch (e) {
        _connectionsEnsured = null;
        throw e;
      }
    })();
  }
  if (!_tenantColumnsEnsured) {
    _tenantColumnsEnsured = (async () => {
      try {
        await ensureClientsTenantColumns();
      } catch (e) {
        _tenantColumnsEnsured = null;
        throw e;
      }
    })();
  }
  return Promise.all([_connectionsEnsured, _tenantColumnsEnsured]).then(
    () => undefined,
  );
}

// Tenant-only self-heal — used by queries that only touch the new
// clients.email_integration_* columns and don't need the
// user_email_connections table.
export function ensureClientsEmailColumns(): Promise<void> {
  if (!_tenantColumnsEnsured) {
    _tenantColumnsEnsured = (async () => {
      try {
        await ensureClientsTenantColumns();
      } catch (e) {
        _tenantColumnsEnsured = null;
        throw e;
      }
    })();
  }
  return _tenantColumnsEnsured;
}
