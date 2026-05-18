-- Migration 0027 — three things:
--   1. `clients` table for multi-tenant scope (CADuniQ has multiple clients)
--   2. user_profiles + suppliers each get a client_id FK
--   3. user_profiles gets a free-form job_role text column
--   4. purchase_orders gets source_pdf_url/name/pathname so the buyer can
--      upload a custom PO PDF that supersedes the platform-generated view
--
-- Bootstrap: a default client matching the deployment's
-- CLIENT_CONFIG.name is auto-created by the self-heal helper, then every
-- existing user_profiles / suppliers row that doesn't yet have a client_id
-- is back-filled to point at it.

CREATE TABLE IF NOT EXISTS "clients" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "industry" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "clients_name_idx" ON "clients" ("name");

ALTER TABLE "user_profiles"
  ADD COLUMN IF NOT EXISTS "job_role" text,
  ADD COLUMN IF NOT EXISTS "client_id" integer REFERENCES "clients"("id") ON DELETE SET NULL;

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "client_id" integer REFERENCES "clients"("id") ON DELETE SET NULL;

ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "source_pdf_url" text,
  ADD COLUMN IF NOT EXISTS "source_pdf_name" text,
  ADD COLUMN IF NOT EXISTS "source_pdf_pathname" text;

CREATE INDEX IF NOT EXISTS "user_profiles_client_idx" ON "user_profiles" ("client_id");
CREATE INDEX IF NOT EXISTS "suppliers_client_idx" ON "suppliers" ("client_id");
