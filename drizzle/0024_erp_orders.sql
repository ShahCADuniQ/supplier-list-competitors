-- ERP procurement workflow: RFQs → supplier quotes → POs + team notifications.
-- See src/db/schema.ts for column-level comments.
--
-- Idempotent (self-healed via src/app/suppliers/_ensure-orders-schema.ts per
-- feedback_migration_forward_compat.md).

DO $$ BEGIN
  CREATE TYPE "rfq_status" AS ENUM ('draft','sent','quotes-in','reviewed','awarded','closed','cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "rfq_stage" AS ENUM ('selection','committed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "rfq_transport_mode" AS ENUM ('air','sea','truck','rail','courier','any');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "supplier_quote_status" AS ENUM ('invited','viewed','draft','submitted','declined','expired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "purchase_order_status" AS ENUM ('draft','sent','acknowledged','in-production','shipped','received','closed','cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "erp_notification_kind" AS ENUM ('rfq.sent','rfq.quote-received','rfq.awarded','po.issued','po.acknowledged','po.shipped','supplier.signed-up','supplier.status-update');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "rfqs" (
  "id" serial PRIMARY KEY,
  "rfq_number" text NOT NULL,
  "project_num" text NOT NULL,
  "project_name" text,
  "niche" text,
  "stage" "rfq_stage" NOT NULL DEFAULT 'selection',
  "status" "rfq_status" NOT NULL DEFAULT 'draft',
  "transport_mode" "rfq_transport_mode" NOT NULL DEFAULT 'any',
  "target_currency" text NOT NULL DEFAULT 'USD',
  "incoterms" text,
  "target_delivery_date" date,
  "quote_deadline" timestamp,
  "notes" text,
  "owner_clerk_id" text NOT NULL,
  "awarded_quote_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "rfqs_number_idx" ON "rfqs" ("rfq_number");
CREATE INDEX IF NOT EXISTS "rfqs_project_idx" ON "rfqs" ("project_num");
CREATE INDEX IF NOT EXISTS "rfqs_status_idx" ON "rfqs" ("status");
CREATE INDEX IF NOT EXISTS "rfqs_owner_idx" ON "rfqs" ("owner_clerk_id");

CREATE TABLE IF NOT EXISTS "rfq_items" (
  "id" serial PRIMARY KEY,
  "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
  "line_no" integer NOT NULL,
  "client_ref" text,
  "product_code" text,
  "description" text NOT NULL,
  "specifications" text,
  "qty" integer NOT NULL DEFAULT 1,
  "security_stock" integer NOT NULL DEFAULT 0,
  "target_unit_price" numeric(12,4),
  "product_url" text,
  "catalog_attachment_url" text,
  "catalog_attachment_name" text,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "rfq_items_rfq_idx" ON "rfq_items" ("rfq_id");

CREATE TABLE IF NOT EXISTS "rfq_recipients" (
  "id" serial PRIMARY KEY,
  "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
  "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "invite_email" text NOT NULL,
  "invite_name" text,
  "access_token" text NOT NULL,
  "token_expires_at" timestamp NOT NULL,
  "status" "supplier_quote_status" NOT NULL DEFAULT 'invited',
  "invited_at" timestamp NOT NULL DEFAULT now(),
  "viewed_at" timestamp,
  "responded_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "rfq_recipients_rfq_idx" ON "rfq_recipients" ("rfq_id");
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_recipients_token_idx" ON "rfq_recipients" ("access_token");
CREATE INDEX IF NOT EXISTS "rfq_recipients_email_idx" ON "rfq_recipients" ("invite_email");

CREATE TABLE IF NOT EXISTS "supplier_quotes" (
  "id" serial PRIMARY KEY,
  "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
  "recipient_id" integer NOT NULL REFERENCES "rfq_recipients"("id") ON DELETE CASCADE,
  "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "company_name" text NOT NULL,
  "contact_name" text,
  "contact_email" text,
  "contact_phone" text,
  "address" text,
  "country_of_origin" text,
  "manufacturer_name" text,
  "manufacturer_part_number" text,
  "currency" text NOT NULL DEFAULT 'USD',
  "incoterms" text,
  "transport_mode" "rfq_transport_mode" NOT NULL DEFAULT 'any',
  "shipping_cost" numeric(14,2) NOT NULL DEFAULT 0,
  "lead_time_days" integer NOT NULL DEFAULT 0,
  "validity_until" date,
  "notes" text,
  "source_pdf_url" text,
  "source_pdf_name" text,
  "status" "supplier_quote_status" NOT NULL DEFAULT 'draft',
  "submitted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "supplier_quotes_rfq_idx" ON "supplier_quotes" ("rfq_id");
CREATE INDEX IF NOT EXISTS "supplier_quotes_supplier_idx" ON "supplier_quotes" ("supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_quotes_status_idx" ON "supplier_quotes" ("status");

CREATE TABLE IF NOT EXISTS "supplier_quote_lines" (
  "id" serial PRIMARY KEY,
  "quote_id" integer NOT NULL REFERENCES "supplier_quotes"("id") ON DELETE CASCADE,
  "rfq_item_id" integer REFERENCES "rfq_items"("id") ON DELETE SET NULL,
  "unit_price" numeric(14,4) NOT NULL DEFAULT 0,
  "moq" integer NOT NULL DEFAULT 1,
  "volume_discounts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "available_stock" integer,
  "lead_time_days" integer,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "supplier_quote_lines_quote_idx" ON "supplier_quote_lines" ("quote_id");
CREATE INDEX IF NOT EXISTS "supplier_quote_lines_item_idx" ON "supplier_quote_lines" ("rfq_item_id");

CREATE TABLE IF NOT EXISTS "supplier_quote_attachments" (
  "id" serial PRIMARY KEY,
  "quote_id" integer NOT NULL REFERENCES "supplier_quotes"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'other',
  "name" text NOT NULL,
  "size" bigint NOT NULL DEFAULT 0,
  "mime_type" text,
  "url" text NOT NULL,
  "blob_pathname" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "supplier_quote_attachments_quote_idx" ON "supplier_quote_attachments" ("quote_id");

CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" serial PRIMARY KEY,
  "po_number" text NOT NULL,
  "rfq_id" integer REFERENCES "rfqs"("id") ON DELETE SET NULL,
  "quote_id" integer REFERENCES "supplier_quotes"("id") ON DELETE SET NULL,
  "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "supplier_name" text NOT NULL,
  "project_num" text NOT NULL,
  "project_name" text,
  "proposition_reference" text,
  "currency" text NOT NULL DEFAULT 'USD',
  "incoterms" text,
  "transport_mode" "rfq_transport_mode" NOT NULL DEFAULT 'any',
  "subtotal" numeric(14,2) NOT NULL DEFAULT 0,
  "discount_amount" numeric(14,2) NOT NULL DEFAULT 0,
  "tax_amount" numeric(14,2) NOT NULL DEFAULT 0,
  "total_amount" numeric(14,2) NOT NULL DEFAULT 0,
  "billing_address" text,
  "shipping_address" text,
  "notes" text,
  "status" "purchase_order_status" NOT NULL DEFAULT 'draft',
  "sent_at" timestamp,
  "acknowledged_at" timestamp,
  "shipped_at" timestamp,
  "received_at" timestamp,
  "created_by_clerk_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_number_idx" ON "purchase_orders" ("po_number");
CREATE INDEX IF NOT EXISTS "purchase_orders_project_idx" ON "purchase_orders" ("project_num");
CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_idx" ON "purchase_orders" ("supplier_id");
CREATE INDEX IF NOT EXISTS "purchase_orders_status_idx" ON "purchase_orders" ("status");

CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
  "id" serial PRIMARY KEY,
  "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "line_no" integer NOT NULL,
  "ref" text,
  "description" text NOT NULL,
  "qty" integer NOT NULL DEFAULT 1,
  "unit_price" numeric(14,4) NOT NULL DEFAULT 0,
  "total_price" numeric(14,2) NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "purchase_order_lines_po_idx" ON "purchase_order_lines" ("po_id");

CREATE TABLE IF NOT EXISTS "erp_notifications" (
  "id" serial PRIMARY KEY,
  "target_clerk_id" text,
  "kind" "erp_notification_kind" NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "link_url" text,
  "rfq_id" integer REFERENCES "rfqs"("id") ON DELETE SET NULL,
  "quote_id" integer REFERENCES "supplier_quotes"("id") ON DELETE SET NULL,
  "po_id" integer REFERENCES "purchase_orders"("id") ON DELETE SET NULL,
  "read_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "erp_notifications_target_idx" ON "erp_notifications" ("target_clerk_id");
CREATE INDEX IF NOT EXISTS "erp_notifications_kind_idx" ON "erp_notifications" ("kind");
CREATE INDEX IF NOT EXISTS "erp_notifications_created_idx" ON "erp_notifications" ("created_at");
