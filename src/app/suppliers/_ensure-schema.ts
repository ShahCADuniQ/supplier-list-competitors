// Self-healing schema helper for the suppliers module. Same pattern as
// ensureUserProfileColumns in src/lib/permissions.ts — every entry point
// that reads/writes the new columns calls this first so a fresh deploy
// without `npm run db:apply` keeps working.
//
// Currently covers migration 0023 (suppliers.is_starred). Add new ALTERs
// here as the schema grows.
//
// NOT a "use server" file — exposes a plain async function callable from
// both server components (page.tsx) and server actions (actions.ts) without
// the RPC indirection that "use server" exports get.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureSupplierColumns(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      // Migration 0023 — is_starred
      await db.execute(
        sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "is_starred" boolean NOT NULL DEFAULT false`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "suppliers_starred_idx" ON "suppliers" ("is_starred")`,
      );
      // Migration 0025 — portal_token (supplier home magic-link)
      await db.execute(
        sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "portal_token" text`,
      );
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_portal_token_idx" ON "suppliers" ("portal_token")`,
      );
      // Migration 0028 — supplier_contacts table for multiple POCs per
      // supplier. suppliers.email stays as the denormalised primary so
      // legacy queries still work; this table holds the rest.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "supplier_contacts" (
          "id" serial PRIMARY KEY,
          "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
          "name" text,
          "email" text NOT NULL,
          "phone" text,
          "role" text,
          "is_primary" boolean NOT NULL DEFAULT false,
          "notes" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "supplier_contacts_supplier_idx" ON "supplier_contacts" ("supplier_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "supplier_contacts_email_idx" ON "supplier_contacts" ("email")`,
      );
      // Backfill: every supplier with an email gets a primary contact row
      // on first run so the UI always shows at least one contact.
      await db.execute(sql`
        INSERT INTO "supplier_contacts" ("supplier_id", "name", "email", "phone", "role", "is_primary")
        SELECT s.id, s.contact_name, s.email, s.phone, 'Primary', true
        FROM "suppliers" s
        WHERE s.email IS NOT NULL AND s.email <> ''
          AND NOT EXISTS (
            SELECT 1 FROM "supplier_contacts" c WHERE c.supplier_id = s.id
          )
      `);
      // Migration 0030 — per-supplier brand mark, used as letterhead on
      // every generated quotation PDF. Mirrored in _ensure-orders-schema.ts
      // but lots of supplier-side pages (incl. /suppliers/page.tsx) call
      // ensureSupplierColumns() not ensureOrdersSchema(), so we add it here
      // too — otherwise a SELECT * on suppliers blows up.
      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_url" text`);
      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_name" text`);
      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_pathname" text`);
      // Same for clients — admin's /admin page reads logo columns via
      // db.select().from(clients).
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_url" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_name" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_pathname" text`);

      // Migration 0031 — supplier ↔ buyer live chat. Tables created here
      // so any supplier-facing page (including the portal) can use chat
      // without depending on ensureOrdersSchema first.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "chat_channels" (
          "id" serial PRIMARY KEY,
          "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
          "name" text NOT NULL,
          "kind" text NOT NULL DEFAULT 'custom',
          "archived" boolean NOT NULL DEFAULT false,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "chat_channels_supplier_idx" ON "chat_channels" ("supplier_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "chat_channels_archived_idx" ON "chat_channels" ("archived")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "chat_messages" (
          "id" serial PRIMARY KEY,
          "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE CASCADE,
          "author_clerk_id" text NOT NULL,
          "author_role" text NOT NULL DEFAULT 'buyer',
          "author_name" text,
          "body" text NOT NULL,
          "attachment_url" text,
          "attachment_name" text,
          "attachment_pathname" text,
          "edited_at" timestamp,
          "deleted_at" timestamp,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "chat_messages_channel_idx" ON "chat_messages" ("channel_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "chat_messages_created_idx" ON "chat_messages" ("created_at")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "chat_reads" (
          "id" serial PRIMARY KEY,
          "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE CASCADE,
          "clerk_user_id" text NOT NULL,
          "last_read_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "chat_reads_channel_user_idx" ON "chat_reads" ("channel_id", "clerk_user_id")`);
    } catch (e) {
      console.warn(
        "[suppliers] ensureSupplierColumns failed — run `npm run db:apply` to apply migrations 0023 + 0025.",
        e,
      );
    }
  })();
  return _ensured;
}
