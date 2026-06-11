// Self-healing schema helper for the email integration feature.
// Memoised one-shot so repeated calls during a single process boot are
// free. Called by every email OAuth + send endpoint before they touch
// user_email_connections, and also picks up the per-tenant approval
// columns added to `clients` when the email-integration request flow
// shipped.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureEmailConnectionsSchema(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
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

      // Per-tenant approval gate. ADD COLUMN IF NOT EXISTS is idempotent
      // so re-running this on already-migrated DBs is a no-op.
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_status" text NOT NULL DEFAULT 'none'`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_requested_by" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_requested_at" timestamp`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_decided_by" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_decided_at" timestamp`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email_integration_notes" text`);
    } catch (e) {
      _ensured = null; // allow retry
      throw e;
    }
  })();
  return _ensured;
}
