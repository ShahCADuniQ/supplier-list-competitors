-- Migration 0028 — two additions:
--   1. rfqs.source_pdf_url/name/pathname so the buyer can upload a custom
--      RFQ PDF that the supplier sees instead of the platform-generated
--      print view. Mirrors how POs and supplier quotes already work.
--   2. supplier_contacts table for multiple points of contact per supplier
--      (e.g. one supplier with separate Sales / Engineering / AP emails).
--      The suppliers.email column stays as the "primary" denormalised
--      contact so legacy queries keep working; this table adds the rest.

ALTER TABLE "rfqs"
  ADD COLUMN IF NOT EXISTS "source_pdf_url" text,
  ADD COLUMN IF NOT EXISTS "source_pdf_name" text,
  ADD COLUMN IF NOT EXISTS "source_pdf_pathname" text;

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
);
CREATE INDEX IF NOT EXISTS "supplier_contacts_supplier_idx" ON "supplier_contacts" ("supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_contacts_email_idx" ON "supplier_contacts" ("email");

-- Backfill: copy the existing suppliers.email + contact_name + phone into
-- supplier_contacts as the primary contact, so every supplier with an
-- email has at least one contact row to start from.
INSERT INTO "supplier_contacts" ("supplier_id", "name", "email", "phone", "role", "is_primary")
SELECT s.id, s.contact_name, s.email, s.phone, 'Primary', true
FROM "suppliers" s
WHERE s.email IS NOT NULL AND s.email <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "supplier_contacts" c WHERE c.supplier_id = s.id
  );
