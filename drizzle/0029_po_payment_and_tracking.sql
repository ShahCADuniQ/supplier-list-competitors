-- Migration 0029 — Payment transparency + production tracking on POs.
--
-- Four new tables let the buyer + supplier converse in-app instead of by
-- phone/email:
--   1. po_payment_methods — supplier posts the bank/wire/etc. instructions
--                           the buyer should use to pay this PO.
--   2. po_invoices        — supplier issues invoice(s) against the PO; buyer
--                           transitions status (received → approved → scheduled
--                           → paid) so the supplier sees AP progress.
--   3. po_payments        — buyer records proof-of-payment (date, method,
--                           reference, optional file). Optionally linked to
--                           a specific invoice.
--   4. po_timeline        — free-form production / delivery updates posted by
--                           supplier (or buyer) with optional attachment +
--                           tracking number / carrier / ETA. Each entry can
--                           carry a phase value that mirrors purchase_order_status
--                           so the latest entry's phase = current production
--                           phase visible to the buyer.

-- New invoice status enum — the lifecycle the buyer's AP team walks through.
DO $$ BEGIN
  CREATE TYPE "po_invoice_status" AS ENUM (
    'issued','received','approved','scheduled','paid','disputed','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Extend the existing notification kind enum so payment + tracking events
-- get their own bell icons. Adding values to a pg enum is a separate
-- statement per value and IF NOT EXISTS is supported in pg ≥ 9.6.
ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.payment-method-set';
ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.invoice-issued';
ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.invoice-status';
ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.payment-recorded';
ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.timeline-update';

CREATE TABLE IF NOT EXISTS "po_payment_methods" (
  "id" serial PRIMARY KEY,
  "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "bank_name" text,
  "account_holder" text,
  "iban" text,
  "swift_bic" text,
  "account_number" text,
  "routing_number" text,
  -- jsonb array of additional methods e.g. [{kind:'PayPal', value:'pay@x.com'}]
  "additional_methods" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "accepted_currencies" text,
  "payment_terms" text,            -- e.g. "NET 30", "50% deposit, 50% on shipment"
  "additional_notes" text,
  "attachment_url" text,
  "attachment_name" text,
  "attachment_pathname" text,
  "posted_by_clerk_id" text,
  "posted_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "po_payment_methods_po_idx" ON "po_payment_methods" ("po_id");

CREATE TABLE IF NOT EXISTS "po_invoices" (
  "id" serial PRIMARY KEY,
  "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "invoice_number" text NOT NULL,
  "amount" numeric(14,2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "issue_date" date,
  "due_date" date,
  "file_url" text,
  "file_name" text,
  "file_pathname" text,
  "status" "po_invoice_status" NOT NULL DEFAULT 'issued',
  "received_at" timestamp,
  "approved_at" timestamp,
  "scheduled_payment_date" date,
  "scheduled_at" timestamp,
  "paid_at" timestamp,
  "dispute_reason" text,
  "notes" text,
  "posted_by_clerk_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "po_invoices_po_idx" ON "po_invoices" ("po_id");
CREATE INDEX IF NOT EXISTS "po_invoices_status_idx" ON "po_invoices" ("status");

CREATE TABLE IF NOT EXISTS "po_payments" (
  "id" serial PRIMARY KEY,
  "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "invoice_id" integer REFERENCES "po_invoices"("id") ON DELETE SET NULL,
  "amount" numeric(14,2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "paid_on" date NOT NULL,
  "method" text,                   -- e.g. "Wire", "Check #1234", "ACH"
  "reference" text,                -- bank reference / confirmation number
  "file_url" text,
  "file_name" text,
  "file_pathname" text,
  "notes" text,
  "posted_by_clerk_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "po_payments_po_idx" ON "po_payments" ("po_id");
CREATE INDEX IF NOT EXISTS "po_payments_invoice_idx" ON "po_payments" ("invoice_id");

CREATE TABLE IF NOT EXISTS "po_timeline" (
  "id" serial PRIMARY KEY,
  "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  -- phase mirrors purchase_order_status so the latest non-null phase = current
  -- production phase. Stored as text (not the enum) so a free comment without
  -- a phase change is also possible.
  "phase" text,
  "title" text NOT NULL,
  "note" text,
  "tracking_number" text,
  "carrier" text,
  "eta" date,
  "attachment_url" text,
  "attachment_name" text,
  "attachment_pathname" text,
  "posted_by_role" text NOT NULL DEFAULT 'supplier',  -- 'supplier' | 'buyer'
  "posted_by_clerk_id" text,
  "posted_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "po_timeline_po_idx" ON "po_timeline" ("po_id");
CREATE INDEX IF NOT EXISTS "po_timeline_posted_idx" ON "po_timeline" ("posted_at");
