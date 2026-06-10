// Self-healing schema helper for the ERP procurement workflow (RFQs →
// quotes → POs + notifications). Same pattern as _ensure-schema.ts and
// every other module — every entry point that reads/writes the new tables
// calls this first so a fresh deploy without `npm run db:apply` keeps
// working. Memoized so it only runs once per process.
//
// Mirrors migration 0024 (drizzle/0024_erp_orders.sql).

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureOrdersSchema(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      // Enums
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "rfq_status" AS ENUM ('draft','sent','quotes-in','reviewed','awarded','closed','cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "rfq_stage" AS ENUM ('selection','committed');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "rfq_transport_mode" AS ENUM ('air','sea','truck','rail','courier','any');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "supplier_quote_status" AS ENUM ('invited','viewed','draft','submitted','declined','expired');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "purchase_order_status" AS ENUM ('draft','sent','acknowledged','in-production','shipped','received','closed','cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "erp_notification_kind" AS ENUM ('rfq.sent','rfq.quote-received','rfq.awarded','po.issued','po.acknowledged','po.shipped','supplier.signed-up','supplier.status-update');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);

      // Tables
      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "rfqs_number_idx" ON "rfqs" ("rfq_number")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfqs_project_idx" ON "rfqs" ("project_num")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfqs_status_idx" ON "rfqs" ("status")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfqs_owner_idx" ON "rfqs" ("owner_clerk_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_items_rfq_idx" ON "rfq_items" ("rfq_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_recipients_rfq_idx" ON "rfq_recipients" ("rfq_id")`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "rfq_recipients_token_idx" ON "rfq_recipients" ("access_token")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_recipients_email_idx" ON "rfq_recipients" ("invite_email")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quotes_rfq_idx" ON "supplier_quotes" ("rfq_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quotes_supplier_idx" ON "supplier_quotes" ("supplier_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quotes_status_idx" ON "supplier_quotes" ("status")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quote_lines_quote_idx" ON "supplier_quote_lines" ("quote_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quote_lines_item_idx" ON "supplier_quote_lines" ("rfq_item_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_quote_attachments_quote_idx" ON "supplier_quote_attachments" ("quote_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_number_idx" ON "purchase_orders" ("po_number")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_orders_project_idx" ON "purchase_orders" ("project_num")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_idx" ON "purchase_orders" ("supplier_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_orders_status_idx" ON "purchase_orders" ("status")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_order_lines_po_idx" ON "purchase_order_lines" ("po_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "erp_notifications_target_idx" ON "erp_notifications" ("target_clerk_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "erp_notifications_kind_idx" ON "erp_notifications" ("kind")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "erp_notifications_created_idx" ON "erp_notifications" ("created_at")`);

      // Migration 0028 — RFQ source PDF columns
      await db.execute(sql`ALTER TABLE "rfqs" ADD COLUMN IF NOT EXISTS "source_pdf_url" text`);
      await db.execute(sql`ALTER TABLE "rfqs" ADD COLUMN IF NOT EXISTS "source_pdf_name" text`);
      await db.execute(sql`ALTER TABLE "rfqs" ADD COLUMN IF NOT EXISTS "source_pdf_pathname" text`);

      // Migration 0029 — payment transparency + production tracking
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "po_invoice_status" AS ENUM ('issued','received','approved','scheduled','paid','disputed','cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);

      // Notification kinds — adding values to an enum is one statement each.
      // IF NOT EXISTS is supported in pg ≥ 9.6 so this is fully idempotent.
      await db.execute(sql`ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.payment-method-set'`);
      await db.execute(sql`ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.invoice-issued'`);
      await db.execute(sql`ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.invoice-status'`);
      await db.execute(sql`ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.payment-recorded'`);
      await db.execute(sql`ALTER TYPE "erp_notification_kind" ADD VALUE IF NOT EXISTS 'po.timeline-update'`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "po_payment_methods" (
          "id" serial PRIMARY KEY,
          "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
          "bank_name" text,
          "account_holder" text,
          "iban" text,
          "swift_bic" text,
          "account_number" text,
          "routing_number" text,
          "additional_methods" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "accepted_currencies" text,
          "payment_terms" text,
          "additional_notes" text,
          "attachment_url" text,
          "attachment_name" text,
          "attachment_pathname" text,
          "posted_by_clerk_id" text,
          "posted_at" timestamp NOT NULL DEFAULT now(),
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_payment_methods_po_idx" ON "po_payment_methods" ("po_id")`);

      await db.execute(sql`
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
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_invoices_po_idx" ON "po_invoices" ("po_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_invoices_status_idx" ON "po_invoices" ("status")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "po_payments" (
          "id" serial PRIMARY KEY,
          "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
          "invoice_id" integer REFERENCES "po_invoices"("id") ON DELETE SET NULL,
          "amount" numeric(14,2) NOT NULL DEFAULT 0,
          "currency" text NOT NULL DEFAULT 'USD',
          "paid_on" date NOT NULL,
          "method" text,
          "reference" text,
          "file_url" text,
          "file_name" text,
          "file_pathname" text,
          "notes" text,
          "posted_by_clerk_id" text NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_payments_po_idx" ON "po_payments" ("po_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_payments_invoice_idx" ON "po_payments" ("invoice_id")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "po_timeline" (
          "id" serial PRIMARY KEY,
          "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
          "phase" text,
          "title" text NOT NULL,
          "note" text,
          "tracking_number" text,
          "carrier" text,
          "eta" date,
          "attachment_url" text,
          "attachment_name" text,
          "attachment_pathname" text,
          "posted_by_role" text NOT NULL DEFAULT 'supplier',
          "posted_by_clerk_id" text,
          "posted_at" timestamp NOT NULL DEFAULT now(),
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_timeline_po_idx" ON "po_timeline" ("po_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "po_timeline_posted_idx" ON "po_timeline" ("posted_at")`);

      // Migration 0030 — multiple attachments per RFQ line item + per-party
      // logos used as letterhead on every generated RFQ / Quote / PO PDF.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "rfq_item_attachments" (
          "id" serial PRIMARY KEY,
          "rfq_item_id" integer NOT NULL REFERENCES "rfq_items"("id") ON DELETE CASCADE,
          "kind" text NOT NULL DEFAULT 'doc',
          "name" text NOT NULL,
          "url" text NOT NULL,
          "blob_pathname" text,
          "content_type" text,
          "size" bigint NOT NULL DEFAULT 0,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_item_attachments_item_idx" ON "rfq_item_attachments" ("rfq_item_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_item_attachments_kind_idx" ON "rfq_item_attachments" ("kind")`);

      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_url" text`);
      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_name" text`);
      await db.execute(sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "logo_pathname" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_url" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_name" text`);
      await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "logo_pathname" text`);

      // Migration 0032 — inventory items + Lightbase Ref. linkage on every
      // RFQ / PO line. Lets one inventory part track every quote / PO ever
      // issued across multiple suppliers.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "inventory_items" (
          "id" serial PRIMARY KEY,
          "code" text NOT NULL,
          "name" text,
          "description" text,
          "category" text,
          "unit" text NOT NULL DEFAULT 'ea',
          "default_supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
          "notes" text,
          "archived" boolean NOT NULL DEFAULT false,
          "created_by_clerk_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_code_idx" ON "inventory_items" ("code")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_category_idx" ON "inventory_items" ("category")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_archived_idx" ON "inventory_items" ("archived")`);

      await db.execute(sql`ALTER TABLE "rfq_items" ADD COLUMN IF NOT EXISTS "lightbase_ref" text`);
      await db.execute(sql`ALTER TABLE "rfq_items" ADD COLUMN IF NOT EXISTS "inventory_item_id" integer REFERENCES "inventory_items"("id") ON DELETE SET NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_items_lightbase_ref_idx" ON "rfq_items" ("lightbase_ref")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_items_inventory_item_idx" ON "rfq_items" ("inventory_item_id")`);

      await db.execute(sql`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "lightbase_ref" text`);
      await db.execute(sql`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "inventory_item_id" integer REFERENCES "inventory_items"("id") ON DELETE SET NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_order_lines_lightbase_ref_idx" ON "purchase_order_lines" ("lightbase_ref")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_order_lines_inventory_item_idx" ON "purchase_order_lines" ("inventory_item_id")`);

      // Migration 0033 — IFC import + assembly hierarchy + qty lifecycle.
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'part'`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "parent_assembly_id" integer REFERENCES "inventory_items"("id") ON DELETE SET NULL`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "weight_g" numeric(14,4)`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "surface_area_mm2" numeric(16,4)`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "volume_mm3" numeric(16,4)`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "material" text`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "density_g_cm3" numeric(10,4)`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "thumbnail_url" text`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "thumbnail_pathname" text`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "ifc_source_url" text`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "ifc_source_name" text`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "pending_qty" integer NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "confirmed_qty" integer NOT NULL DEFAULT 0`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_kind_idx" ON "inventory_items" ("kind")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_items_parent_idx" ON "inventory_items" ("parent_assembly_id")`);

      // ── RFQ email drafts (the "send via email" + procurement-routed
      //    review queue feature) ────────────────────────────────────
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "rfq_email_draft_status" AS ENUM (
          'draft','pending_procurement_review','approved','rejected','sent'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "rfq_email_draft_route" AS ENUM (
          'direct_to_supplier','via_procurement'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "rfq_email_drafts" (
          "id" serial PRIMARY KEY,
          "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
          "recipient_id" integer REFERENCES "rfq_recipients"("id") ON DELETE SET NULL,
          "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
          "to_email" text NOT NULL,
          "to_name" text,
          "reply_to_email" text,
          "subject" text NOT NULL,
          "body_text" text NOT NULL,
          "ai_summary" text,
          "include_magic_link" boolean NOT NULL DEFAULT true,
          "route" "rfq_email_draft_route" NOT NULL,
          "status" "rfq_email_draft_status" NOT NULL DEFAULT 'draft',
          "composed_by_clerk_id" text,
          "composed_at" timestamp NOT NULL DEFAULT now(),
          "reviewed_by_clerk_id" text,
          "reviewed_at" timestamp,
          "reviewer_notes" text,
          "sent_at" timestamp,
          "provider_message_id" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_email_drafts_rfq_idx" ON "rfq_email_drafts" ("rfq_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_email_drafts_status_idx" ON "rfq_email_drafts" ("status")`);

      // Delivery-flag columns (added in the same patch that introduced
      // multi-select delivery options + procurement-vs-supplier mutual
      // exclusion). Idempotent ADD COLUMN IF NOT EXISTS so re-runs are
      // safe.
      await db.execute(sql`ALTER TABLE "rfq_email_drafts" ADD COLUMN IF NOT EXISTS "deliver_to_supplier_email" boolean NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE "rfq_email_drafts" ADD COLUMN IF NOT EXISTS "deliver_to_supplier_platform" boolean NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE "rfq_email_drafts" ADD COLUMN IF NOT EXISTS "procurement_via_email" boolean NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE "rfq_email_drafts" ADD COLUMN IF NOT EXISTS "procurement_via_platform" boolean NOT NULL DEFAULT false`);

      // Catalogue ↔ RFQ/PO linkage. Lets a buyer pick a product from the
      // supplier catalogue when drafting an RFQ; carries through the
      // RFQ → quote → PO pipeline so PO-send time can update the
      // catalogue + inventory automatically.
      await db.execute(sql`ALTER TABLE "rfq_items" ADD COLUMN IF NOT EXISTS "supplier_product_id" integer`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_items_supplier_product_idx" ON "rfq_items" ("supplier_product_id")`);
      await db.execute(sql`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "supplier_product_id" integer`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_order_lines_supplier_product_idx" ON "purchase_order_lines" ("supplier_product_id")`);

      // "Used for" linkage — every order can be tagged with the Lightbase
      // assembly it's being procured for. Lets the team see every
      // part / consumable that's been ordered to build a given finished
      // product. Inventory item id (kind='assembly' on the inventory
      // side); nullable.
      await db.execute(sql`ALTER TABLE "rfq_items" ADD COLUMN IF NOT EXISTS "for_inventory_item_id" integer`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "rfq_items_for_inventory_item_idx" ON "rfq_items" ("for_inventory_item_id")`);
      await db.execute(sql`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "for_inventory_item_id" integer`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "purchase_order_lines_for_inventory_item_idx" ON "purchase_order_lines" ("for_inventory_item_id")`);
      // Backfill existing rows from the legacy 'route' column so the new
      // flags reflect their original intent. direct_to_supplier rows
      // become email-only (the historical behaviour); via_procurement
      // rows become email-only to procurement.
      await db.execute(sql`
        UPDATE "rfq_email_drafts"
          SET "deliver_to_supplier_email" = true
          WHERE "route" = 'direct_to_supplier'
            AND "deliver_to_supplier_email" = false
            AND "deliver_to_supplier_platform" = false
      `);
      await db.execute(sql`
        UPDATE "rfq_email_drafts"
          SET "procurement_via_email" = true
          WHERE "route" = 'via_procurement'
            AND "procurement_via_email" = false
            AND "procurement_via_platform" = false
      `);
    } catch (e) {
      console.warn(
        "[orders] ensureOrdersSchema failed — run `npm run db:apply` to apply migration 0024.",
        e,
      );
    }
  })();
  return _ensured;
}
