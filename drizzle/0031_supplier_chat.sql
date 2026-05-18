-- Migration 0031 — supplier ↔ buyer live chat. One supplier can have many
-- chat channels (e.g. "General", "Engineering Q&A", "Logistics", "Payment
-- terms"). Both the buyer (any supplier-editor) and the supplier's portal
-- users can post into any channel for that supplier. Read state is tracked
-- per-user so the unread badge stays accurate across devices.

CREATE TABLE IF NOT EXISTS "chat_channels" (
  "id" serial PRIMARY KEY,
  "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- 'default' is the auto-created General channel (cannot be archived).
  -- 'custom' is any channel the buyer added.
  "kind" text NOT NULL DEFAULT 'custom',
  "archived" boolean NOT NULL DEFAULT false,
  "created_by_clerk_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "chat_channels_supplier_idx" ON "chat_channels" ("supplier_id");
CREATE INDEX IF NOT EXISTS "chat_channels_archived_idx" ON "chat_channels" ("archived");

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" serial PRIMARY KEY,
  "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE CASCADE,
  "author_clerk_id" text NOT NULL,
  "author_role" text NOT NULL DEFAULT 'buyer',  -- 'buyer' | 'supplier'
  "author_name" text,
  "body" text NOT NULL,
  "attachment_url" text,
  "attachment_name" text,
  "attachment_pathname" text,
  "edited_at" timestamp,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "chat_messages_channel_idx" ON "chat_messages" ("channel_id");
CREATE INDEX IF NOT EXISTS "chat_messages_created_idx" ON "chat_messages" ("created_at");

CREATE TABLE IF NOT EXISTS "chat_reads" (
  "id" serial PRIMARY KEY,
  "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE CASCADE,
  "clerk_user_id" text NOT NULL,
  "last_read_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "chat_reads_channel_user_idx" ON "chat_reads" ("channel_id", "clerk_user_id");
