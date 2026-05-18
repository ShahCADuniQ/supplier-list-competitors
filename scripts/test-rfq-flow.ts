/**
 * End-to-end smoke test for the RFQ → quote → PO workflow.
 *
 * Bypasses Clerk auth and exercises the same code paths the UI uses:
 *   1. ensure schema
 *   2. find/create a test supplier (hasaanshah19n@gmail.com)
 *   3. create an RFQ with two line items
 *   4. invite the test supplier (generates magic-link token)
 *   5. simulate the supplier opening the portal + submitting a quote
 *   6. award the RFQ + generate the PO
 *   7. dump the final state of every table for verification
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/test-rfq-flow.ts
 *
 * The script prints the portal URL so you can visit it manually after the
 * test (in case you want to play with the live form).
 */

import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(databaseUrl);

const TEST_EMAIL = "hasaanshah19n@gmail.com";
const TEST_COMPANY = "Test Supplier Inc.";
const TEST_CONTACT = "Hasaan Shah";
const TEST_PROJECT_NUM = "TEST-1425";
const TEST_PROJECT_NAME = "test";

function token(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function shortDate(d = new Date()): string {
  const y = d.getFullYear().toString().slice(-2);
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA — apply the orders migration if it hasn't been applied yet. Mirrors
// src/app/suppliers/_ensure-orders-schema.ts but the script-side equivalent.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  console.log("→ ensuring schema…");
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "rfq_status" AS ENUM ('draft','sent','quotes-in','reviewed','awarded','closed','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "rfq_stage" AS ENUM ('selection','committed'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "rfq_transport_mode" AS ENUM ('air','sea','truck','rail','courier','any'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "supplier_quote_status" AS ENUM ('invited','viewed','draft','submitted','declined','expired'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "purchase_order_status" AS ENUM ('draft','sent','acknowledged','in-production','shipped','received','closed','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );
  await sql.query(
    `DO $$ BEGIN CREATE TYPE "erp_notification_kind" AS ENUM ('rfq.sent','rfq.quote-received','rfq.awarded','po.issued','po.acknowledged','po.shipped','supplier.signed-up','supplier.status-update'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
  );

  await sql.query(`
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
    )
  `);
  await sql.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "rfqs_number_idx" ON "rfqs" ("rfq_number")`,
  );
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "rfq_items" (
      "id" serial PRIMARY KEY,
      "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
      "line_no" integer NOT NULL,
      "client_ref" text, "product_code" text,
      "description" text NOT NULL, "specifications" text,
      "qty" integer NOT NULL DEFAULT 1,
      "security_stock" integer NOT NULL DEFAULT 0,
      "target_unit_price" numeric(12,4),
      "product_url" text, "catalog_attachment_url" text, "catalog_attachment_name" text,
      "notes" text, "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "rfq_recipients" (
      "id" serial PRIMARY KEY,
      "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
      "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
      "invite_email" text NOT NULL, "invite_name" text,
      "access_token" text NOT NULL, "token_expires_at" timestamp NOT NULL,
      "status" "supplier_quote_status" NOT NULL DEFAULT 'invited',
      "invited_at" timestamp NOT NULL DEFAULT now(),
      "viewed_at" timestamp, "responded_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "rfq_recipients_token_idx" ON "rfq_recipients" ("access_token")`,
  );
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "supplier_quotes" (
      "id" serial PRIMARY KEY,
      "rfq_id" integer NOT NULL REFERENCES "rfqs"("id") ON DELETE CASCADE,
      "recipient_id" integer NOT NULL REFERENCES "rfq_recipients"("id") ON DELETE CASCADE,
      "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
      "company_name" text NOT NULL, "contact_name" text, "contact_email" text, "contact_phone" text,
      "address" text, "country_of_origin" text,
      "manufacturer_name" text, "manufacturer_part_number" text,
      "currency" text NOT NULL DEFAULT 'USD', "incoterms" text,
      "transport_mode" "rfq_transport_mode" NOT NULL DEFAULT 'any',
      "shipping_cost" numeric(14,2) NOT NULL DEFAULT 0,
      "lead_time_days" integer NOT NULL DEFAULT 0,
      "validity_until" date, "notes" text,
      "source_pdf_url" text, "source_pdf_name" text,
      "status" "supplier_quote_status" NOT NULL DEFAULT 'draft',
      "submitted_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "supplier_quote_lines" (
      "id" serial PRIMARY KEY,
      "quote_id" integer NOT NULL REFERENCES "supplier_quotes"("id") ON DELETE CASCADE,
      "rfq_item_id" integer REFERENCES "rfq_items"("id") ON DELETE SET NULL,
      "unit_price" numeric(14,4) NOT NULL DEFAULT 0,
      "moq" integer NOT NULL DEFAULT 1,
      "volume_discounts" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "available_stock" integer, "lead_time_days" integer, "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "supplier_quote_attachments" (
      "id" serial PRIMARY KEY,
      "quote_id" integer NOT NULL REFERENCES "supplier_quotes"("id") ON DELETE CASCADE,
      "kind" text NOT NULL DEFAULT 'other',
      "name" text NOT NULL, "size" bigint NOT NULL DEFAULT 0,
      "mime_type" text, "url" text NOT NULL, "blob_pathname" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "purchase_orders" (
      "id" serial PRIMARY KEY,
      "po_number" text NOT NULL,
      "rfq_id" integer REFERENCES "rfqs"("id") ON DELETE SET NULL,
      "quote_id" integer REFERENCES "supplier_quotes"("id") ON DELETE SET NULL,
      "supplier_id" integer REFERENCES "suppliers"("id") ON DELETE SET NULL,
      "supplier_name" text NOT NULL,
      "project_num" text NOT NULL, "project_name" text, "proposition_reference" text,
      "currency" text NOT NULL DEFAULT 'USD', "incoterms" text,
      "transport_mode" "rfq_transport_mode" NOT NULL DEFAULT 'any',
      "subtotal" numeric(14,2) NOT NULL DEFAULT 0,
      "discount_amount" numeric(14,2) NOT NULL DEFAULT 0,
      "tax_amount" numeric(14,2) NOT NULL DEFAULT 0,
      "total_amount" numeric(14,2) NOT NULL DEFAULT 0,
      "billing_address" text, "shipping_address" text, "notes" text,
      "status" "purchase_order_status" NOT NULL DEFAULT 'draft',
      "sent_at" timestamp, "acknowledged_at" timestamp, "shipped_at" timestamp, "received_at" timestamp,
      "created_by_clerk_id" text NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_number_idx" ON "purchase_orders" ("po_number")`,
  );
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
      "id" serial PRIMARY KEY,
      "po_id" integer NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
      "line_no" integer NOT NULL,
      "ref" text, "description" text NOT NULL,
      "qty" integer NOT NULL DEFAULT 1,
      "unit_price" numeric(14,4) NOT NULL DEFAULT 0,
      "total_price" numeric(14,2) NOT NULL DEFAULT 0,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "erp_notifications" (
      "id" serial PRIMARY KEY,
      "target_clerk_id" text, "kind" "erp_notification_kind" NOT NULL,
      "title" text NOT NULL, "body" text, "link_url" text,
      "rfq_id" integer REFERENCES "rfqs"("id") ON DELETE SET NULL,
      "quote_id" integer REFERENCES "supplier_quotes"("id") ON DELETE SET NULL,
      "po_id" integer REFERENCES "purchase_orders"("id") ON DELETE SET NULL,
      "read_at" timestamp, "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("  ✓ schema ready");
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — supplier (find-or-create on the test email)
// ─────────────────────────────────────────────────────────────────────────────

async function findOrCreateSupplier(): Promise<{ id: number; created: boolean }> {
  // Self-heal portal_token column in case migration 0025 hasn't been run.
  await sql.query(
    `ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "portal_token" text`,
  );
  await sql.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_portal_token_idx" ON "suppliers" ("portal_token")`,
  );
  const existing = (await sql.query(
    `SELECT id FROM suppliers WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [TEST_EMAIL],
  )) as Array<{ id: number }>;
  if (existing.length > 0) {
    return { id: existing[0].id, created: false };
  }
  const created = (await sql.query(
    `INSERT INTO suppliers (name, email, contact_name, status, category, origin, source)
     VALUES ($1, $2, $3, 'Active', 'Manufacturing', 'Test', 'test-script')
     RETURNING id`,
    [TEST_COMPANY, TEST_EMAIL, TEST_CONTACT],
  )) as Array<{ id: number }>;
  return { id: created[0].id, created: true };
}

async function ensureSupplierPortalToken(supplierId: number): Promise<string> {
  const [row] = (await sql.query(
    `SELECT portal_token FROM suppliers WHERE id = $1`,
    [supplierId],
  )) as Array<{ portal_token: string | null }>;
  if (row?.portal_token) return row.portal_token;
  const tok = token();
  await sql.query(
    `UPDATE suppliers SET portal_token = $1, updated_at = NOW() WHERE id = $2`,
    [tok, supplierId],
  );
  return tok;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — RFQ + items
// ─────────────────────────────────────────────────────────────────────────────

async function nextRfqNumber(): Promise<string> {
  const prefix = `RFQ-${shortDate()}-`;
  const rows = (await sql.query(
    `SELECT rfq_number FROM rfqs WHERE rfq_number LIKE $1`,
    [prefix + "%"],
  )) as Array<{ rfq_number: string }>;
  let max = 0;
  for (const r of rows) {
    const m = r.rfq_number.match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(3, "0")}`;
}

async function createRfqAndItems(): Promise<{ rfqId: number; rfqNumber: string }> {
  const rfqNumber = await nextRfqNumber();
  const ownerClerkId = "system:test-script";
  const [rfq] = (await sql.query(
    `INSERT INTO rfqs (rfq_number, project_num, project_name, niche, stage, status, transport_mode,
       target_currency, incoterms, quote_deadline, notes, owner_clerk_id)
     VALUES ($1, $2, $3, 'LED panels', 'selection', 'draft', 'air',
       'USD', 'FOB', NOW() + INTERVAL '14 days', 'Auto-generated test RFQ', $4)
     RETURNING id, rfq_number`,
    [rfqNumber, TEST_PROJECT_NUM, TEST_PROJECT_NAME, ownerClerkId],
  )) as Array<{ id: number; rfq_number: string }>;

  const items = [
    {
      clientRef: "L18SM",
      productCode: "PAL22-125D-F90-35/40/50-80-M500-VC-W-SM",
      description: "2X2 PANEL, 120-347V, 5000K, SURFACE MOUNT",
      qty: 15,
      securityStock: 3,
    },
    {
      clientRef: "L18",
      productCode: "PAL22-125D-F90-35/40/50-80-M500-VC-W-ECT",
      description: "2X2 PANEL, 120-347V, 5000K, RECESSED",
      qty: 11,
      securityStock: 0,
    },
  ];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await sql.query(
      `INSERT INTO rfq_items (rfq_id, line_no, client_ref, product_code, description, qty, security_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rfq.id, i + 1, it.clientRef, it.productCode, it.description, it.qty, it.securityStock],
    );
  }
  return { rfqId: rfq.id, rfqNumber: rfq.rfq_number };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — invite the supplier (generates magic-link token)
// ─────────────────────────────────────────────────────────────────────────────

async function inviteSupplier(rfqId: number, supplierId: number): Promise<{
  recipientId: number;
  accessToken: string;
  portalUrl: string;
}> {
  const tok = token();
  const expires = new Date(Date.now() + 60 * 24 * 3600 * 1000);
  const [row] = (await sql.query(
    `INSERT INTO rfq_recipients (rfq_id, supplier_id, invite_email, invite_name,
       access_token, token_expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'invited')
     RETURNING id`,
    [rfqId, supplierId, TEST_EMAIL, TEST_CONTACT, tok, expires],
  )) as Array<{ id: number }>;
  await sql.query(
    `UPDATE rfqs SET status = 'sent', updated_at = NOW() WHERE id = $1 AND status = 'draft'`,
    [rfqId],
  );
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return { recipientId: row.id, accessToken: tok, portalUrl: `${base}/vendor/${tok}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — simulate the supplier submitting their quote
// ─────────────────────────────────────────────────────────────────────────────

async function simulateSupplierQuote(args: {
  rfqId: number;
  recipientId: number;
  supplierId: number;
}): Promise<{ quoteId: number }> {
  await sql.query(
    `UPDATE rfq_recipients SET viewed_at = NOW(), status = 'viewed' WHERE id = $1`,
    [args.recipientId],
  );

  const items = (await sql.query(
    `SELECT id, qty FROM rfq_items WHERE rfq_id = $1 ORDER BY line_no`,
    [args.rfqId],
  )) as Array<{ id: number; qty: number }>;

  const [quote] = (await sql.query(
    `INSERT INTO supplier_quotes (rfq_id, recipient_id, supplier_id,
       company_name, contact_name, contact_email, contact_phone, address,
       country_of_origin, manufacturer_name, manufacturer_part_number,
       currency, incoterms, transport_mode, shipping_cost,
       lead_time_days, validity_until, notes, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       'USD', 'FOB', 'air', 850, 28, NOW() + INTERVAL '30 days',
       'Stock ready. Air freight via Shenzhen. Test quote.', 'submitted', NOW())
     RETURNING id`,
    [
      args.rfqId,
      args.recipientId,
      args.supplierId,
      TEST_COMPANY,
      TEST_CONTACT,
      TEST_EMAIL,
      "+1 555-0100",
      "Test address, Shenzhen, China",
      "China",
      "Ledco Lighting",
      "LCPAN-2X2-40W-MW-CCT-UV-T",
    ],
  )) as Array<{ id: number }>;

  // Per-item lines (each item gets a unit price + MOQ + stock)
  const prices = [63.16, 63.16];
  for (let i = 0; i < items.length; i++) {
    await sql.query(
      `INSERT INTO supplier_quote_lines
         (quote_id, rfq_item_id, unit_price, moq, available_stock, lead_time_days)
       VALUES ($1, $2, $3, 1, 500, 28)`,
      [quote.id, items[i].id, prices[i] ?? 50.0],
    );
  }

  // Update recipient status to mirror the submitted quote.
  await sql.query(
    `UPDATE rfq_recipients SET status = 'submitted', responded_at = NOW() WHERE id = $1`,
    [args.recipientId],
  );
  await sql.query(
    `UPDATE rfqs SET status = 'quotes-in', updated_at = NOW()
     WHERE id = $1 AND status IN ('draft','sent')`,
    [args.rfqId],
  );

  return { quoteId: quote.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — award + generate PO
// ─────────────────────────────────────────────────────────────────────────────

async function awardAndGeneratePo(args: {
  rfqId: number;
  quoteId: number;
}): Promise<{ poId: number; poNumber: string }> {
  await sql.query(
    `UPDATE rfqs SET awarded_quote_id = $1, status = 'awarded', updated_at = NOW() WHERE id = $2`,
    [args.quoteId, args.rfqId],
  );

  const [quote] = (await sql.query(
    `SELECT * FROM supplier_quotes WHERE id = $1`,
    [args.quoteId],
  )) as Array<Record<string, unknown>>;
  const [rfq] = (await sql.query(
    `SELECT * FROM rfqs WHERE id = $1`,
    [args.rfqId],
  )) as Array<Record<string, unknown>>;
  const items = (await sql.query(
    `SELECT * FROM rfq_items WHERE rfq_id = $1 ORDER BY line_no`,
    [args.rfqId],
  )) as Array<Record<string, unknown>>;
  const lines = (await sql.query(
    `SELECT * FROM supplier_quote_lines WHERE quote_id = $1`,
    [args.quoteId],
  )) as Array<Record<string, unknown>>;
  const lineByItem = new Map(lines.map((l) => [l.rfq_item_id as number, l]));

  let subtotal = 0;
  const poLines: Array<{
    line_no: number;
    ref: string | null;
    description: string;
    qty: number;
    unit_price: number;
    total_price: number;
  }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const l = lineByItem.get(it.id as number);
    if (!l) continue;
    const unit = Number(l.unit_price ?? 0);
    const qty = Number(it.qty ?? 0);
    const total = unit * qty;
    subtotal += total;
    poLines.push({
      line_no: i + 1,
      ref: (it.client_ref as string) ?? null,
      description: it.description as string,
      qty,
      unit_price: unit,
      total_price: total,
    });
  }

  const ship = Number(quote.shipping_cost ?? 0);
  const total = subtotal + ship;

  // Next PO number
  const d = new Date();
  const stamp = `${d.getFullYear()}${(d.getMonth() + 1).toString().padStart(2, "0")}${d
    .getDate()
    .toString()
    .padStart(2, "0")}`;
  const prefix = `PO${stamp}`;
  const existingPos = (await sql.query(
    `SELECT po_number FROM purchase_orders WHERE po_number LIKE $1`,
    [prefix + "%"],
  )) as Array<{ po_number: string }>;
  let max = 0;
  for (const r of existingPos) {
    const m = r.po_number.match(/^PO\d{8}(?:-(\d+))?$/);
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  const poNumber = existingPos.length === 0 ? prefix : `${prefix}-${(max + 1).toString().padStart(2, "0")}`;

  const [po] = (await sql.query(
    `INSERT INTO purchase_orders (po_number, rfq_id, quote_id, supplier_id, supplier_name,
       project_num, project_name, proposition_reference, currency, incoterms, transport_mode,
       subtotal, discount_amount, tax_amount, total_amount,
       billing_address, shipping_address, status, created_by_clerk_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15, $16, 'draft', $17)
     RETURNING id, po_number`,
    [
      poNumber,
      args.rfqId,
      args.quoteId,
      quote.supplier_id,
      quote.company_name,
      rfq.project_num,
      rfq.project_name,
      rfq.rfq_number,
      quote.currency,
      quote.incoterms ?? rfq.incoterms,
      quote.transport_mode ?? rfq.transport_mode,
      subtotal,
      ship,
      total,
      "Lightbase\n10871 Avenue Salk, Montreal, QC, H1G 6M7, Canada",
      "Lightbase\n10871 Avenue Salk, Montreal, QC, H1G 6M7, Canada",
      "system:test-script",
    ],
  )) as Array<{ id: number; po_number: string }>;

  for (const l of poLines) {
    await sql.query(
      `INSERT INTO purchase_order_lines (po_id, line_no, ref, description, qty, unit_price, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [po.id, l.line_no, l.ref, l.description, l.qty, l.unit_price, l.total_price],
    );
  }

  return { poId: po.id, poNumber: po.po_number };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n============================================");
  console.log("END-TO-END TEST: RFQ → QUOTE → PO");
  console.log("============================================\n");

  await ensureSchema();

  console.log(`\n→ Step 1: find/create supplier (${TEST_EMAIL})`);
  const sup = await findOrCreateSupplier();
  console.log(`  ${sup.created ? "CREATED" : "found existing"} supplier id=${sup.id}`);

  console.log(`\n→ Step 2: create RFQ "${TEST_PROJECT_NAME}" with 2 line items`);
  const rfq = await createRfqAndItems();
  console.log(`  RFQ created: id=${rfq.rfqId}, number=${rfq.rfqNumber}`);

  console.log(`\n→ Step 3: invite supplier (generate magic-link token)`);
  const invite = await inviteSupplier(rfq.rfqId, sup.id);
  console.log(`  recipient id=${invite.recipientId}`);
  console.log(`  portal URL: ${invite.portalUrl}`);

  console.log(`\n→ Step 4: simulate supplier submitting their quote`);
  const quote = await simulateSupplierQuote({
    rfqId: rfq.rfqId,
    recipientId: invite.recipientId,
    supplierId: sup.id,
  });
  console.log(`  quote id=${quote.quoteId}, status=submitted`);

  console.log(`\n→ Step 5: award RFQ + generate PO`);
  const po = await awardAndGeneratePo({ rfqId: rfq.rfqId, quoteId: quote.quoteId });
  console.log(`  PO created: id=${po.poId}, number=${po.poNumber}`);

  console.log(`\n→ Step 6: ensure supplier home portal token exists`);
  const portalToken = await ensureSupplierPortalToken(sup.id);
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const homeUrl = `${base}/vendor/home/${portalToken}`;
  console.log(`  supplier home URL: ${homeUrl}`);

  console.log(`\n→ Step 7: verify the home portal shows the test RFQ`);
  const homeInvites = (await sql.query(
    `SELECT rfqs.rfq_number, rfq_recipients.status, supplier_quotes.status AS quote_status
     FROM rfq_recipients
     INNER JOIN rfqs ON rfqs.id = rfq_recipients.rfq_id
     LEFT JOIN supplier_quotes
       ON supplier_quotes.recipient_id = rfq_recipients.id
      AND supplier_quotes.rfq_id = rfqs.id
     WHERE rfq_recipients.supplier_id = $1
        OR (rfq_recipients.supplier_id IS NULL
            AND LOWER(rfq_recipients.invite_email) = LOWER($2))
     ORDER BY rfq_recipients.invited_at DESC`,
    [sup.id, TEST_EMAIL],
  )) as Array<Record<string, unknown>>;
  console.log(`  home portal lists ${homeInvites.length} invite(s):`);
  for (const i of homeInvites) {
    console.log(`    - ${i.rfq_number}: recipient=${i.status} quote=${i.quote_status ?? "—"}`);
  }
  if (homeInvites.length === 0) {
    throw new Error("Supplier home portal returned 0 invites — expected at least 1");
  }

  console.log(`\n→ Step 8: simulate the supplier signing into the main app`);
  // Self-heal the is_supplier column in case migration 0026 hasn't run.
  await sql.query(
    `ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "is_supplier" boolean NOT NULL DEFAULT false`,
  );
  await sql.query(
    `CREATE INDEX IF NOT EXISTS "user_profiles_is_supplier_idx" ON "user_profiles" ("is_supplier")`,
  );
  // Wipe any prior fake-Clerk row for this email so the test is deterministic.
  await sql.query(`DELETE FROM "user_profiles" WHERE LOWER(email) = LOWER($1)`, [TEST_EMAIL]);
  // Simulate getOrCreateProfile()'s insert path for a brand-new supplier
  // sign-in. The real flow runs from the Clerk webhook on first sign-in.
  const fakeClerkId = `clerk_test_${Date.now()}`;
  await sql.query(
    `INSERT INTO "user_profiles" (clerk_user_id, email, display_name, role,
       is_supplier, approved_at, approved_by)
     VALUES ($1, $2, $3, 'member', true, NOW(), 'system:supplier-auto')`,
    [fakeClerkId, TEST_EMAIL, TEST_CONTACT],
  );
  const [up] = (await sql.query(
    `SELECT clerk_user_id, email, role, is_supplier FROM "user_profiles"
     WHERE LOWER(email) = LOWER($1)`,
    [TEST_EMAIL],
  )) as Array<Record<string, unknown>>;
  console.log(`  user_profiles row created:`);
  console.log(`    clerk_user_id = ${up.clerk_user_id}`);
  console.log(`    email         = ${up.email}`);
  console.log(`    role          = ${up.role}`);
  console.log(`    is_supplier   = ${up.is_supplier}`);
  if (!up.is_supplier) {
    throw new Error("Supplier user_profiles row missing is_supplier=true");
  }

  console.log(`\n→ Step 9: verify the inArray-style join works (was crashing the buyer detail view)`);
  // Mirror getRfqDetail's quote/lines join — the version that crashed used
  // sql\`= ANY(${ids})\` which Drizzle's HTTP driver bound as a scalar.
  const quoteIds = (await sql.query(
    `SELECT id FROM supplier_quotes WHERE rfq_id = $1`,
    [rfq.rfqId],
  )) as Array<{ id: number }>;
  const idList = quoteIds.map((q) => q.id);
  console.log(`  quote ids on this RFQ: ${idList.join(", ")}`);
  if (idList.length > 0) {
    const placeholders = idList.map((_, i) => `$${i + 1}`).join(", ");
    const lines = (await sql.query(
      `SELECT id, quote_id, unit_price FROM supplier_quote_lines WHERE quote_id IN (${placeholders})`,
      idList,
    )) as Array<Record<string, unknown>>;
    console.log(`  fetched ${lines.length} quote lines via IN (...) syntax (mirrors inArray())`);
  }

  // Final dump
  console.log("\n============================================");
  console.log("FINAL STATE");
  console.log("============================================");
  const [r] = (await sql.query(
    `SELECT id, rfq_number, project_num, project_name, stage, status,
            transport_mode, target_currency, awarded_quote_id
     FROM rfqs WHERE id = $1`,
    [rfq.rfqId],
  )) as Array<Record<string, unknown>>;
  console.log("\nRFQ:");
  console.log(JSON.stringify(r, null, 2));

  const recipients = (await sql.query(
    `SELECT id, invite_email, status, viewed_at, responded_at, access_token
     FROM rfq_recipients WHERE rfq_id = $1`,
    [rfq.rfqId],
  )) as Array<Record<string, unknown>>;
  console.log("\nRecipients:");
  console.log(JSON.stringify(recipients, null, 2));

  const quotes = (await sql.query(
    `SELECT id, company_name, currency, lead_time_days, shipping_cost, status, submitted_at
     FROM supplier_quotes WHERE rfq_id = $1`,
    [rfq.rfqId],
  )) as Array<Record<string, unknown>>;
  console.log("\nQuotes:");
  console.log(JSON.stringify(quotes, null, 2));

  const poRow = (await sql.query(
    `SELECT id, po_number, supplier_name, currency, subtotal, tax_amount, total_amount, status
     FROM purchase_orders WHERE id = $1`,
    [po.poId],
  )) as Array<Record<string, unknown>>;
  console.log("\nPurchase Order:");
  console.log(JSON.stringify(poRow, null, 2));

  console.log("\n============================================");
  console.log("✓ ALL STEPS PASSED");
  console.log("============================================");
  console.log("\nView the test RFQ in the UI:");
  console.log(`  /suppliers → Orders tab → RFQ ${rfq.rfqNumber}`);
  console.log("\nSupplier sign-in flow (no magic link needed):");
  console.log(`  1. Open ${base}/sign-in`);
  console.log(`  2. Sign in with: ${TEST_EMAIL}`);
  console.log(`  3. You'll land on ${base}/portal — your active RFQs`);
  console.log(`     (Admins can preview the supplier view by visiting /portal directly.)`);
  console.log("\nMagic-link routes still work (for suppliers without a Clerk account):");
  console.log(`  home: ${homeUrl}`);
  console.log(`  one RFQ: ${invite.portalUrl}`);
  console.log("\nBuyer-side links:");
  console.log(`  Admin → Suppliers segment: ${base}/admin`);
  console.log(`  RFQ detail (was crashing): ${base}/suppliers (Orders tab → RFQ ${rfq.rfqNumber})`);
  console.log(`  Generated PO: ${base}/suppliers/po/${po.poId}`);
}

main().catch((e) => {
  console.error("\n!!! TEST FAILED:");
  console.error(e);
  process.exit(1);
});
