"use server";

// ERP procurement server actions — covers the whole RFQ → quote → PO
// workflow plus team notifications. Buyer-side actions require an authed
// editor; supplier-side actions (submitQuote*) accept a magic-link token
// instead of a Clerk session so external suppliers can use the portal
// without an account.

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { del } from "@vercel/blob";
import { db } from "@/db";
import {
  clients,
  erpNotifications,
  purchaseOrderLines,
  purchaseOrders,
  rfqItemAttachments,
  rfqItems,
  rfqRecipients,
  rfqs,
  suppliers,
  supplierContacts,
  supplierQuoteAttachments,
  supplierQuoteLines,
  supplierQuotes,
  userProfiles,
  type ErpNotification,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Rfq,
  type RfqItem,
  type RfqItemAttachment,
  type RfqRecipient,
  type SupplierQuote,
  type SupplierQuoteAttachment,
  type SupplierQuoteLine,
} from "@/db/schema";
import { getOrCreateProfile, requireSupplierEditor } from "@/lib/permissions";
import { ensureOrdersSchema } from "./_ensure-orders-schema";
import { ensureSupplierColumns } from "./_ensure-schema";

// ─────────────────────────────────────────────────────────────────────────────
// IDS / FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

function randomToken(): string {
  // 32 url-safe characters. Plenty of entropy for magic-link auth.
  return crypto.randomBytes(24).toString("base64url");
}

function shortDate(d = new Date()): string {
  // YYMMDD — matches the user's RFQ naming style ("260505" in the template).
  const y = d.getFullYear().toString().slice(-2);
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

async function nextRfqNumber(): Promise<string> {
  await ensureOrdersSchema();
  const stamp = shortDate();
  const prefix = `RFQ-${stamp}-`;
  const rows = (await db
    .select({ n: rfqs.rfqNumber })
    .from(rfqs)
    .where(sql`${rfqs.rfqNumber} LIKE ${prefix + "%"}`)) as Array<{ n: string }>;
  let max = 0;
  for (const r of rows) {
    const m = r.n.match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(3, "0")}`;
}

async function nextPoNumber(): Promise<string> {
  await ensureOrdersSchema();
  const d = new Date();
  const stamp = `${d.getFullYear()}${(d.getMonth() + 1)
    .toString()
    .padStart(2, "0")}${d.getDate().toString().padStart(2, "0")}`;
  const prefix = `PO${stamp}`;
  const rows = (await db
    .select({ n: purchaseOrders.poNumber })
    .from(purchaseOrders)
    .where(sql`${purchaseOrders.poNumber} LIKE ${prefix + "%"}`)) as Array<{
    n: string;
  }>;
  if (rows.length === 0) return prefix;
  let max = 0;
  for (const r of rows) {
    const m = r.n.match(/^PO\d{8}(?:-(\d+))?$/);
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  return `${prefix}-${(max + 1).toString().padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS — fan-out to every admin/editor on the deployment so the
// whole buying team gets pinged on key events.
// ─────────────────────────────────────────────────────────────────────────────

async function notifyTeam(input: {
  kind: ErpNotification["kind"];
  title: string;
  body?: string;
  linkUrl?: string;
  rfqId?: number;
  quoteId?: number;
  poId?: number;
}): Promise<void> {
  try {
    // Fan out to every user who can edit suppliers, EXCLUDING supplier
    // users (they have their own targeted-notification path so we don't
    // leak "Quote received from X" alerts to suppliers).
    const team = await db
      .select({ id: userProfiles.clerkUserId })
      .from(userProfiles)
      .where(sql`
        (${userProfiles.isSupplier} = false)
        AND (
          (${userProfiles.role} = 'admin')
          OR (${userProfiles.canEdit} = true AND ${userProfiles.canViewSuppliers} = true)
        )
      `);
    if (team.length === 0) return;
    await db.insert(erpNotifications).values(
      team.map((u) => ({
        targetClerkId: u.id,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        linkUrl: input.linkUrl ?? null,
        rfqId: input.rfqId ?? null,
        quoteId: input.quoteId ?? null,
        poId: input.poId ?? null,
      })),
    );
  } catch (e) {
    console.warn("[orders] notifyTeam failed:", e);
  }
}

// Notify a single supplier in their bell. Resolves the supplier's
// user_profiles row by email (suppliers.email + every supplier_contacts.email)
// so even if the buyer invited via a non-primary contact, that contact's
// account (if they've signed in) gets the alert. No-op if no matching user
// account exists yet (the supplier hasn't signed in via Clerk).
async function notifySupplier(input: {
  supplierId: number;
  kind: ErpNotification["kind"];
  title: string;
  body?: string;
  linkUrl?: string;
  rfqId?: number;
  quoteId?: number;
  poId?: number;
}): Promise<void> {
  try {
    // Pull every known email tied to this supplier
    const emails = (await db.execute(sql`
      SELECT LOWER(email) AS email FROM suppliers WHERE id = ${input.supplierId} AND email IS NOT NULL
      UNION
      SELECT LOWER(email) AS email FROM supplier_contacts WHERE supplier_id = ${input.supplierId}
    `)) as unknown as { rows?: Array<{ email: string }> } | Array<{ email: string }>;
    const list = Array.isArray(emails) ? emails : Array.isArray(emails?.rows) ? emails.rows : [];
    const emailSet = list.map((r) => r.email).filter(Boolean);
    if (emailSet.length === 0) return;
    // Find any Clerk-authed supplier-flagged user profiles matching those emails.
    const recipients = await db
      .select({ id: userProfiles.clerkUserId })
      .from(userProfiles)
      .where(
        sql`${userProfiles.isSupplier} = true AND LOWER(${userProfiles.email}) IN (${sql.join(
          emailSet.map((e) => sql`${e}`),
          sql`, `,
        )})`,
      );
    if (recipients.length === 0) return;
    await db.insert(erpNotifications).values(
      recipients.map((u) => ({
        targetClerkId: u.id,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        linkUrl: input.linkUrl ?? null,
        rfqId: input.rfqId ?? null,
        quoteId: input.quoteId ?? null,
        poId: input.poId ?? null,
      })),
    );
  } catch (e) {
    console.warn("[orders] notifySupplier failed:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFQs — buyer-side CRUD
// ─────────────────────────────────────────────────────────────────────────────

export type RfqItemAttachmentInput = {
  kind: "photo" | "doc";
  name: string;
  url: string;
  blobPathname?: string;
  contentType?: string;
  size?: number;
};

export type RfqItemInput = {
  clientRef?: string;
  productCode?: string;
  description: string;
  specifications?: string;
  qty: number;
  securityStock?: number;
  targetUnitPrice?: number | null;
  productUrl?: string;
  catalogAttachmentUrl?: string;
  catalogAttachmentName?: string;
  notes?: string;
  // Lightbase Ref. — links this line to an inventory_items row. Blank =
  // server auto-generates LB-NNNNNN AND creates the inventory part. Non-
  // blank = server looks up the part by code (strict; unknown code throws
  // unless `allowUnknownLightbaseRef` is true).
  lightbaseRef?: string;
  // Pending attachments staged in the wizard before save. Inserted into
  // rfq_item_attachments after the item itself is created.
  attachments?: RfqItemAttachmentInput[];
};

export async function createRfq(input: {
  projectNum: string;
  projectName?: string;
  niche?: string;
  stage: Rfq["stage"];
  transportMode?: Rfq["transportMode"];
  targetCurrency?: string;
  incoterms?: string;
  targetDeliveryDate?: string | null;
  quoteDeadline?: string | null;
  notes?: string;
  items: RfqItemInput[];
}): Promise<{ rfqId: number; rfqNumber: string }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();
  if (!input.projectNum.trim())
    throw new Error("Project number is required");
  if (!input.items || input.items.length === 0)
    throw new Error("At least one line item is required");

  const rfqNumber = await nextRfqNumber();
  const [row] = await db
    .insert(rfqs)
    .values({
      rfqNumber,
      projectNum: input.projectNum.trim(),
      projectName: input.projectName?.trim() || null,
      niche: input.niche?.trim() || null,
      stage: input.stage,
      status: "draft",
      transportMode: input.transportMode ?? "any",
      targetCurrency: input.targetCurrency ?? "USD",
      incoterms: input.incoterms?.trim() || null,
      targetDeliveryDate: input.targetDeliveryDate ?? null,
      quoteDeadline: input.quoteDeadline ? new Date(input.quoteDeadline) : null,
      notes: input.notes?.trim() || null,
      ownerClerkId: profile.clerkUserId,
    })
    .returning();

  // Lazy import so the inventory module's imports don't pull into every
  // place rfq-actions is required.
  const { resolveOrCreateInventoryItem } = await import("./inventory-actions");

  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    // Resolve / create the inventory part for this line. Empty Lightbase
    // Ref. → mint a new code AND create the part; typed-in code → strict
    // lookup (throws on unknown code unless overridden).
    const inv = await resolveOrCreateInventoryItem({
      code: it.lightbaseRef,
      name: it.description,
      description: it.specifications,
    });
    const [itemRow] = await db
      .insert(rfqItems)
      .values({
        rfqId: row.id,
        lineNo: i + 1,
        clientRef: it.clientRef?.trim() || null,
        productCode: it.productCode?.trim() || null,
        description: it.description.trim(),
        specifications: it.specifications?.trim() || null,
        qty: Math.max(1, it.qty | 0),
        securityStock: Math.max(0, it.securityStock ?? 0),
        targetUnitPrice:
          it.targetUnitPrice != null ? String(it.targetUnitPrice) : null,
        productUrl: it.productUrl?.trim() || null,
        catalogAttachmentUrl: it.catalogAttachmentUrl?.trim() || null,
        catalogAttachmentName: it.catalogAttachmentName?.trim() || null,
        notes: it.notes?.trim() || null,
        lightbaseRef: inv.code,
        inventoryItemId: inv.id,
      })
      .returning({ id: rfqItems.id });
    // Persist any staged photos / docs against the freshly-created item.
    if (it.attachments && it.attachments.length > 0) {
      await db.insert(rfqItemAttachments).values(
        it.attachments.map((a) => ({
          rfqItemId: itemRow.id,
          kind: a.kind,
          name: a.name,
          url: a.url,
          blobPathname: a.blobPathname ?? null,
          contentType: a.contentType ?? null,
          size: a.size ?? 0,
        })),
      );
    }
  }

  revalidatePath("/suppliers");
  return { rfqId: row.id, rfqNumber };
}

export async function deleteRfq(rfqId: number): Promise<void> {
  await requireSupplierEditor();
  await db.delete(rfqs).where(eq(rfqs.id, rfqId));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// RFQ source PDF — optional buyer-uploaded PDF that supersedes the
// platform-generated print view. Mirrors the PO + Quote pattern.
// ─────────────────────────────────────────────────────────────────────────────

export async function setRfqSourcePdf(input: {
  rfqId: number;
  url: string;
  name: string;
  blobPathname: string;
  // When true (default) and the RFQ has no line items yet, the uploaded
  // file is also fed to the AI extractor so the dashboard fields get
  // populated. Pass false to skip (useful when the buyer is replacing the
  // PDF with a different print but the items are already correct).
  autoExtract?: boolean;
}): Promise<{ extractedItems?: number; extractedFields?: string[] }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [prev] = await db
    .select({ url: rfqs.sourcePdfUrl })
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  if (prev?.url) {
    try { await del(prev.url); } catch (e) { console.error("Blob del (old RFQ source PDF) failed", e); }
  }
  await db
    .update(rfqs)
    .set({
      sourcePdfUrl: input.url,
      sourcePdfName: input.name,
      sourcePdfPathname: input.blobPathname,
      updatedAt: new Date(),
    })
    .where(eq(rfqs.id, input.rfqId));
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/rfq/${input.rfqId}`);
  revalidatePath("/portal");

  // Auto-extract — run the AI parser on the uploaded file and merge the
  // results into the RFQ so the dashboard fields stay in sync with the
  // PDF the supplier sees. We never overwrite fields the buyer already
  // populated; we only fill blanks + append items when the items table is
  // currently empty. Failures are non-fatal: the upload still succeeds.
  if (input.autoExtract === false) return {};
  try {
    // Lazy import to avoid pulling Anthropic SDK into modules that don't need it.
    const { parseRfqItemsFromUpload } = await import("./rfq-extract-actions");
    const parsed = await parseRfqItemsFromUpload({
      url: input.url,
      fileName: input.name,
    });
    const filled: string[] = [];
    const [current] = await db
      .select()
      .from(rfqs)
      .where(eq(rfqs.id, input.rfqId))
      .limit(1);
    if (!current) return {};
    const setFields: Partial<typeof rfqs.$inferInsert> = {};
    if (!current.projectName && parsed.projectName) { setFields.projectName = parsed.projectName; filled.push("projectName"); }
    if (!current.niche && parsed.niche) { setFields.niche = parsed.niche; filled.push("niche"); }
    if (parsed.targetCurrency && current.targetCurrency === "USD" && parsed.targetCurrency !== "USD") {
      setFields.targetCurrency = parsed.targetCurrency; filled.push("targetCurrency");
    }
    if (!current.incoterms && parsed.incoterms) { setFields.incoterms = parsed.incoterms; filled.push("incoterms"); }
    if (parsed.transportMode && current.transportMode === "any" && parsed.transportMode !== "any") {
      setFields.transportMode = parsed.transportMode; filled.push("transportMode");
    }
    if (!current.notes && parsed.notes) { setFields.notes = parsed.notes; filled.push("notes"); }
    if (Object.keys(setFields).length > 0) {
      setFields.updatedAt = new Date();
      await db.update(rfqs).set(setFields).where(eq(rfqs.id, input.rfqId));
    }

    // Items: only insert when the RFQ has none yet — we never want to
    // duplicate or stomp manually-edited lines.
    let inserted = 0;
    const existingItems = await db
      .select({ id: rfqItems.id })
      .from(rfqItems)
      .where(eq(rfqItems.rfqId, input.rfqId));
    if (existingItems.length === 0 && parsed.items.length > 0) {
      for (let i = 0; i < parsed.items.length; i++) {
        const it = parsed.items[i];
        await db.insert(rfqItems).values({
          rfqId: input.rfqId,
          lineNo: i + 1,
          clientRef: it.clientRef?.trim() || null,
          productCode: it.productCode?.trim() || null,
          description: it.description.trim(),
          specifications: it.specifications?.trim() || null,
          qty: Math.max(1, it.qty | 0),
          securityStock: Math.max(0, it.securityStock ?? 0),
          targetUnitPrice:
            it.targetUnitPrice != null ? String(it.targetUnitPrice) : null,
          productUrl: it.productUrl?.trim() || null,
          notes: it.notes?.trim() || null,
        });
        inserted += 1;
      }
    }
    revalidatePath(`/suppliers/rfq/${input.rfqId}`);
    return { extractedItems: inserted, extractedFields: filled };
  } catch (e) {
    console.warn("[rfq] setRfqSourcePdf auto-extract failed:", e);
    return {};
  }
}

export async function clearRfqSourcePdf(rfqId: number): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [r] = await db
    .select({ url: rfqs.sourcePdfUrl })
    .from(rfqs)
    .where(eq(rfqs.id, rfqId))
    .limit(1);
  if (r?.url) {
    try { await del(r.url); } catch (e) { console.error("Blob del failed", e); }
  }
  await db
    .update(rfqs)
    .set({
      sourcePdfUrl: null,
      sourcePdfName: null,
      sourcePdfPathname: null,
      updatedAt: new Date(),
    })
    .where(eq(rfqs.id, rfqId));
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/rfq/${rfqId}`);
  revalidatePath("/portal");
}

// ─────────────────────────────────────────────────────────────────────────────
// RFQ LINE-ITEM ATTACHMENTS — multiple photos + documents per line item.
// Each line item used to have a single catalog_attachment_*; this is the
// new generic multi-attachment table that replaces it. The old columns are
// kept for back-compat (rendered as a virtual "doc" attachment).
// ─────────────────────────────────────────────────────────────────────────────

export async function listRfqItemAttachments(
  rfqId: number,
): Promise<Record<number, RfqItemAttachment[]>> {
  await ensureOrdersSchema();
  // Fetch every attachment whose item belongs to the given RFQ.
  const rows = await db
    .select({
      att: rfqItemAttachments,
      itemRfqId: rfqItems.rfqId,
    })
    .from(rfqItemAttachments)
    .innerJoin(rfqItems, eq(rfqItems.id, rfqItemAttachments.rfqItemId))
    .where(eq(rfqItems.rfqId, rfqId))
    .orderBy(desc(rfqItemAttachments.createdAt));
  const byItem: Record<number, RfqItemAttachment[]> = {};
  for (const r of rows) {
    const list = byItem[r.att.rfqItemId] ?? (byItem[r.att.rfqItemId] = []);
    list.push(r.att);
  }
  return byItem;
}

export async function addRfqItemAttachment(input: {
  rfqItemId: number;
  kind: "photo" | "doc";
  name: string;
  url: string;
  blobPathname?: string;
  contentType?: string;
  size?: number;
}): Promise<{ attachmentId: number }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [row] = await db
    .insert(rfqItemAttachments)
    .values({
      rfqItemId: input.rfqItemId,
      kind: input.kind,
      name: input.name,
      url: input.url,
      blobPathname: input.blobPathname ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? 0,
    })
    .returning({ id: rfqItemAttachments.id });
  // Resolve the RFQ id for revalidation.
  const [it] = await db
    .select({ rfqId: rfqItems.rfqId })
    .from(rfqItems)
    .where(eq(rfqItems.id, input.rfqItemId))
    .limit(1);
  if (it) {
    revalidatePath(`/suppliers/rfq/${it.rfqId}`);
    revalidatePath(`/vendor/[token]`, "page");
  }
  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { attachmentId: row.id };
}

export async function removeRfqItemAttachment(input: {
  attachmentId: number;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [att] = await db
    .select()
    .from(rfqItemAttachments)
    .where(eq(rfqItemAttachments.id, input.attachmentId))
    .limit(1);
  if (!att) return;
  if (att.url) {
    try { await del(att.url); } catch (e) { console.error("Blob del (RFQ item attachment) failed", e); }
  }
  await db.delete(rfqItemAttachments).where(eq(rfqItemAttachments.id, input.attachmentId));
  const [it] = await db
    .select({ rfqId: rfqItems.rfqId })
    .from(rfqItems)
    .where(eq(rfqItems.id, att.rfqItemId))
    .limit(1);
  if (it) revalidatePath(`/suppliers/rfq/${it.rfqId}`);
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGOS — supplier + client. Used as letterhead on every generated RFQ /
// Quote / PO PDF so each party's brand carries through to the printed doc.
// ─────────────────────────────────────────────────────────────────────────────

export async function setSupplierLogo(input: {
  supplierId: number;
  url: string;
  name: string;
  blobPathname: string;
}): Promise<void> {
  await requireSupplierEditor();
  const [prev] = await db
    .select({ url: suppliers.logoUrl })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (prev?.url && prev.url !== input.url) {
    try { await del(prev.url); } catch (e) { console.error("Blob del (supplier logo) failed", e); }
  }
  await db
    .update(suppliers)
    .set({
      logoUrl: input.url,
      logoName: input.name,
      logoPathname: input.blobPathname,
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

export async function clearSupplierLogo(supplierId: number): Promise<void> {
  await requireSupplierEditor();
  const [prev] = await db
    .select({ url: suppliers.logoUrl })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (prev?.url) {
    try { await del(prev.url); } catch (e) { console.error("Blob del (supplier logo) failed", e); }
  }
  await db
    .update(suppliers)
    .set({ logoUrl: null, logoName: null, logoPathname: null, updatedAt: new Date() })
    .where(eq(suppliers.id, supplierId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

export async function setClientLogo(input: {
  clientId: number;
  url: string;
  name: string;
  blobPathname: string;
}): Promise<void> {
  // Reuse the same editor permission — clients are admin-managed, but any
  // supplier-editor on the buyer side can also update the brand mark.
  await requireSupplierEditor();
  const [prev] = await db
    .select({ url: clients.logoUrl })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);
  if (prev?.url && prev.url !== input.url) {
    try { await del(prev.url); } catch (e) { console.error("Blob del (client logo) failed", e); }
  }
  await db
    .update(clients)
    .set({
      logoUrl: input.url,
      logoName: input.name,
      logoPathname: input.blobPathname,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, input.clientId));
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

export async function clearClientLogo(clientId: number): Promise<void> {
  await requireSupplierEditor();
  const [prev] = await db
    .select({ url: clients.logoUrl })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (prev?.url) {
    try { await del(prev.url); } catch (e) { console.error("Blob del (client logo) failed", e); }
  }
  await db
    .update(clients)
    .set({ logoUrl: null, logoName: null, logoPathname: null, updatedAt: new Date() })
    .where(eq(clients.id, clientId));
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

export async function inviteSupplierToRfq(input: {
  rfqId: number;
  supplierId?: number | null;
  email: string;
  name?: string;
  expiresInDays?: number;
}): Promise<{ recipientId: number; accessToken: string; portalUrl: string }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@"))
    throw new Error("Valid email is required");

  const token = randomToken();
  const expires = new Date(
    Date.now() + (input.expiresInDays ?? 60) * 24 * 3600 * 1000,
  );

  // Look up the supplier if not provided — match on the email field of any
  // existing row so re-invites stay attached to the same supplier record.
  let supplierId = input.supplierId ?? null;
  if (!supplierId) {
    const existing = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.email, email))
      .limit(1);
    if (existing.length > 0) supplierId = existing[0].id;
  }

  const [row] = await db
    .insert(rfqRecipients)
    .values({
      rfqId: input.rfqId,
      supplierId,
      inviteEmail: email,
      inviteName: input.name?.trim() || null,
      accessToken: token,
      tokenExpiresAt: expires,
      status: "invited",
    })
    .returning();

  // Make sure the supplier has a stable home-portal token so the per-RFQ
  // page can show "← My RFQs dashboard" link. Silent / idempotent — only
  // fills it if missing.
  if (supplierId) {
    await ensureSupplierColumns();
    const homeToken = randomToken();
    await db
      .update(suppliers)
      .set({ portalToken: homeToken, updatedAt: new Date() })
      .where(and(eq(suppliers.id, supplierId), sql`${suppliers.portalToken} IS NULL`));
  }

  // Mark the RFQ as sent the first time we invite anyone.
  await db
    .update(rfqs)
    .set({ status: "sent", updatedAt: new Date() })
    .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.status, "draft")));

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const portalUrl = `${base}/vendor/${token}`;

  await notifyTeam({
    kind: "rfq.sent",
    title: `RFQ invite sent to ${email}`,
    body: input.name ? `Contact: ${input.name}` : undefined,
    linkUrl: `/suppliers?orders=${input.rfqId}`,
    rfqId: input.rfqId,
  });

  // Notify the supplier too if they have a signed-in portal account so
  // their bell lights up when a new RFQ lands.
  if (supplierId) {
    const [rfqRow] = await db
      .select({ rfqNumber: rfqs.rfqNumber, projectNum: rfqs.projectNum, projectName: rfqs.projectName })
      .from(rfqs)
      .where(eq(rfqs.id, input.rfqId))
      .limit(1);
    await notifySupplier({
      supplierId,
      kind: "rfq.sent",
      title: `New RFQ from ${process.env.NEXT_PUBLIC_CLIENT_NAME ?? "your buyer"}: ${rfqRow?.rfqNumber ?? `#${input.rfqId}`}`,
      body: rfqRow?.projectName
        ? `Project ${rfqRow.projectName} (${rfqRow.projectNum})`
        : `Project ${rfqRow?.projectNum}`,
      linkUrl: `/portal`,
      rfqId: input.rfqId,
    });
  }

  revalidatePath("/suppliers");
  return { recipientId: row.id, accessToken: token, portalUrl };
}

// Batch invite — one supplier, multiple emails. Used when the buyer wants
// to loop in several contacts at the same vendor on a single RFQ (e.g.
// sales + engineering + AP). Handles three cases in one atomic call:
//
//   1. EXISTING supplier (supplierId set): every email passed in is added
//      to supplier_contacts if it's not already there, then an rfq_recipient
//      is created per email.
//   2. NEW supplier (newSupplierName set, no supplierId): a fresh supplier
//      row is created, every email is saved as a supplier_contacts row, and
//      a recipient is created per email. The first email becomes the
//      primary contact (mirrored to suppliers.email for legacy queries).
//   3. Both supplierId and newSupplierName missing → error.
//
// Returns one row per email so the caller can show the magic-link URLs.
export async function inviteSupplierBatchToRfq(input: {
  rfqId: number;
  supplierId?: number | null;
  newSupplierName?: string;
  contactName?: string;
  emails: string[];
  expiresInDays?: number;
}): Promise<{
  supplierId: number;
  invites: Array<{ email: string; recipientId: number; accessToken: string; portalUrl: string }>;
}> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  await ensureSupplierColumns();
  const cleanedEmails = Array.from(
    new Set(
      (input.emails ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes("@")),
    ),
  );
  if (cleanedEmails.length === 0)
    throw new Error("Provide at least one valid email");

  // Resolve / create the supplier.
  let supplierId = input.supplierId ?? null;
  if (!supplierId) {
    // Try to match by ANY of the emails to an existing supplier (primary
    // email or contact email) — avoids creating duplicate vendor rows when
    // the buyer types in an email that's already in the directory.
    const primaryHit = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(sql`LOWER(${suppliers.email}) IN (${sql.join(
        cleanedEmails.map((e) => sql`${e}`),
        sql`, `,
      )})`)
      .limit(1);
    if (primaryHit.length > 0) supplierId = primaryHit[0].id;
    if (!supplierId) {
      const contactHit = await db
        .select({ supplierId: supplierContacts.supplierId })
        .from(supplierContacts)
        .where(sql`LOWER(${supplierContacts.email}) IN (${sql.join(
          cleanedEmails.map((e) => sql`${e}`),
          sql`, `,
        )})`)
        .limit(1);
      if (contactHit.length > 0) supplierId = contactHit[0].supplierId;
    }
  }
  if (!supplierId) {
    const name = input.newSupplierName?.trim();
    if (!name) throw new Error("Provide a supplierId OR a newSupplierName");
    const [created] = await db
      .insert(suppliers)
      .values({
        name,
        email: cleanedEmails[0],
        contactName: input.contactName?.trim() || null,
        status: "Active",
        category: "Manufacturing",
        source: "rfq-invite",
      })
      .returning({ id: suppliers.id });
    supplierId = created.id;
    await notifyTeam({
      kind: "supplier.signed-up",
      title: `New supplier added: ${name}`,
      body: cleanedEmails.join(", "),
      linkUrl: "/suppliers",
    });
  }

  // Ensure each email exists in supplier_contacts. The first time we add
  // any contact to a supplier with no contacts yet, mark it primary.
  const existingContacts = await db
    .select({ email: supplierContacts.email })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, supplierId));
  const existingEmailSet = new Set(existingContacts.map((c) => c.email.toLowerCase()));
  let needPrimary = existingContacts.length === 0;
  for (const email of cleanedEmails) {
    if (existingEmailSet.has(email)) continue;
    await db.insert(supplierContacts).values({
      supplierId,
      email,
      name: input.contactName?.trim() || null,
      isPrimary: needPrimary,
    });
    if (needPrimary) {
      // Mirror to suppliers.email for legacy compatibility.
      await db
        .update(suppliers)
        .set({ email, updatedAt: new Date() })
        .where(eq(suppliers.id, supplierId));
      needPrimary = false;
    }
  }

  // Make sure the supplier has a stable home-portal token (idempotent).
  const homeToken = randomToken();
  await db
    .update(suppliers)
    .set({ portalToken: homeToken, updatedAt: new Date() })
    .where(and(eq(suppliers.id, supplierId), sql`${suppliers.portalToken} IS NULL`));

  // Create one rfq_recipient per email so each contact gets their own
  // magic-link token. We DON'T de-dupe here — if the buyer re-invites a
  // contact they may want a new link, and rfq_recipients tracks the
  // history (view/respond timestamps) per token issuance.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const invites: Array<{
    email: string; recipientId: number; accessToken: string; portalUrl: string;
  }> = [];
  for (const email of cleanedEmails) {
    const token = randomToken();
    const expires = new Date(
      Date.now() + (input.expiresInDays ?? 60) * 24 * 3600 * 1000,
    );
    const [row] = await db
      .insert(rfqRecipients)
      .values({
        rfqId: input.rfqId,
        supplierId,
        inviteEmail: email,
        inviteName: input.contactName?.trim() || null,
        accessToken: token,
        tokenExpiresAt: expires,
        status: "invited",
      })
      .returning({ id: rfqRecipients.id });
    invites.push({
      email,
      recipientId: row.id,
      accessToken: token,
      portalUrl: `${base}/vendor/${token}`,
    });
  }

  // Flip the RFQ to "sent" on first invite.
  await db
    .update(rfqs)
    .set({ status: "sent", updatedAt: new Date() })
    .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.status, "draft")));

  // One team notification (not N) — the team only wants to know "RFQ #X
  // was sent to <vendor>" once, not N times for the same vendor.
  const [rfqRow] = await db
    .select({ rfqNumber: rfqs.rfqNumber, projectNum: rfqs.projectNum, projectName: rfqs.projectName })
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  const [supplierRow] = await db
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  await notifyTeam({
    kind: "rfq.sent",
    title: `RFQ ${rfqRow?.rfqNumber ?? `#${input.rfqId}`} sent to ${supplierRow?.name ?? "supplier"}`,
    body: `${cleanedEmails.length} contact${cleanedEmails.length === 1 ? "" : "s"}: ${cleanedEmails.join(", ")}`,
    linkUrl: `/suppliers?orders=${input.rfqId}`,
    rfqId: input.rfqId,
  });
  await notifySupplier({
    supplierId,
    kind: "rfq.sent",
    title: `New RFQ from ${process.env.NEXT_PUBLIC_CLIENT_NAME ?? "your buyer"}: ${rfqRow?.rfqNumber ?? `#${input.rfqId}`}`,
    body: rfqRow?.projectName
      ? `Project ${rfqRow.projectName} (${rfqRow.projectNum})`
      : `Project ${rfqRow?.projectNum}`,
    linkUrl: `/portal`,
    rfqId: input.rfqId,
  });

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { supplierId, invites };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT ACCESS CONTROL — buyer-side controls so a portal magic-link can
// be revoked (if the contact leaves the supplier or the link leaks), a
// fresh link can be issued (old one stops working), expiry extended, or
// the recipient deleted entirely. Each action notifies the team.
// ─────────────────────────────────────────────────────────────────────────────

export async function revokeRfqRecipient(input: {
  recipientId: number;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  // Mark expired and rotate the token so the old URL stops working. We keep
  // the recipient row so the audit trail (invited / viewed / responded
  // timestamps) is preserved.
  const dead = `REVOKED-${randomToken()}`;
  const [row] = await db
    .update(rfqRecipients)
    .set({
      accessToken: dead,
      tokenExpiresAt: new Date(Date.now() - 1000),
      status: "expired",
    })
    .where(eq(rfqRecipients.id, input.recipientId))
    .returning();
  if (!row) throw new Error("Recipient not found");
  revalidatePath("/suppliers");
}

export async function reissueRfqRecipientToken(input: {
  recipientId: number;
  expiresInDays?: number;
}): Promise<{ accessToken: string; portalUrl: string; tokenExpiresAt: Date }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const newToken = randomToken();
  const expires = new Date(
    Date.now() + (input.expiresInDays ?? 60) * 24 * 3600 * 1000,
  );
  const [row] = await db
    .update(rfqRecipients)
    .set({
      accessToken: newToken,
      tokenExpiresAt: expires,
      status: "invited",
      // Wipe view / response timestamps so the new contact starts fresh.
      viewedAt: null,
      respondedAt: null,
    })
    .where(eq(rfqRecipients.id, input.recipientId))
    .returning();
  if (!row) throw new Error("Recipient not found");
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  revalidatePath("/suppliers");
  return {
    accessToken: newToken,
    portalUrl: `${base}/vendor/${newToken}`,
    tokenExpiresAt: expires,
  };
}

export async function extendRfqRecipientToken(input: {
  recipientId: number;
  expiresInDays?: number;
}): Promise<{ tokenExpiresAt: Date }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const expires = new Date(
    Date.now() + (input.expiresInDays ?? 60) * 24 * 3600 * 1000,
  );
  const [row] = await db
    .update(rfqRecipients)
    .set({ tokenExpiresAt: expires })
    .where(eq(rfqRecipients.id, input.recipientId))
    .returning();
  if (!row) throw new Error("Recipient not found");
  revalidatePath("/suppliers");
  return { tokenExpiresAt: expires };
}

export async function deleteRfqRecipient(input: {
  recipientId: number;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  // Deletes the recipient AND cascades to any draft/submitted quotes.
  // (FK on supplier_quotes.recipient_id is ON DELETE CASCADE.) Use with care.
  await db
    .delete(rfqRecipients)
    .where(eq(rfqRecipients.id, input.recipientId));
  revalidatePath("/suppliers");
}

export async function awardRfq(input: {
  rfqId: number;
  quoteId: number;
}): Promise<{ poId: number; poNumber: string }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  if (!rfq) throw new Error("RFQ not found");

  const [quote] = await db
    .select()
    .from(supplierQuotes)
    .where(eq(supplierQuotes.id, input.quoteId))
    .limit(1);
  if (!quote) throw new Error("Quote not found");
  if (quote.rfqId !== input.rfqId)
    throw new Error("Quote does not belong to that RFQ");

  await db
    .update(rfqs)
    .set({
      awardedQuoteId: input.quoteId,
      status: "awarded",
      updatedAt: new Date(),
    })
    .where(eq(rfqs.id, input.rfqId));

  // Now generate the PO automatically. The PO uses the quote's pricing +
  // the RFQ's line items so the buyer doesn't have to re-type anything.
  const po = await generatePoFromQuote({
    quoteId: input.quoteId,
    rfqId: input.rfqId,
    createdByClerkId: profile.clerkUserId,
  });

  await notifyTeam({
    kind: "rfq.awarded",
    title: `RFQ ${rfq.rfqNumber} awarded to ${quote.companyName}`,
    body: `PO ${po.poNumber} generated`,
    linkUrl: `/suppliers/po/${po.poId}`,
    rfqId: input.rfqId,
    quoteId: input.quoteId,
    poId: po.poId,
  });

  // Notify the winning supplier — "🏆 You won".
  if (quote.supplierId) {
    await notifySupplier({
      supplierId: quote.supplierId,
      kind: "rfq.awarded",
      title: `🏆 You won RFQ ${rfq.rfqNumber}!`,
      body: `${process.env.NEXT_PUBLIC_CLIENT_NAME ?? "The buyer"} has awarded the contract. PO ${po.poNumber} is drafted.`,
      linkUrl: `/suppliers/po/${po.poId}`,
      rfqId: input.rfqId,
      quoteId: input.quoteId,
      poId: po.poId,
    });
  }

  revalidatePath("/suppliers");
  return po;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS
// ─────────────────────────────────────────────────────────────────────────────

async function generatePoFromQuote(input: {
  quoteId: number;
  rfqId: number;
  createdByClerkId: string;
}): Promise<{ poId: number; poNumber: string }> {
  const [quote] = await db
    .select()
    .from(supplierQuotes)
    .where(eq(supplierQuotes.id, input.quoteId))
    .limit(1);
  if (!quote) throw new Error("Quote not found");

  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  if (!rfq) throw new Error("RFQ not found");

  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, input.rfqId));

  const lines = await db
    .select()
    .from(supplierQuoteLines)
    .where(eq(supplierQuoteLines.quoteId, input.quoteId));
  const lineByItem = new Map(lines.map((l) => [l.rfqItemId, l]));

  let subtotal = 0;
  const poLines: Array<
    Omit<typeof purchaseOrderLines.$inferInsert, "poId"> & {
      _total: number;
    }
  > = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const line = lineByItem.get(it.id);
    if (!line) continue;
    const unit = Number(line.unitPrice ?? 0);
    const total = unit * it.qty;
    subtotal += total;
    poLines.push({
      lineNo: i + 1,
      ref: it.clientRef ?? null,
      description: it.description,
      qty: it.qty,
      unitPrice: String(unit),
      totalPrice: String(total),
      // Carry inventory linkage from RFQ → PO so the per-part history
      // includes both the original RFQ AND the resulting PO.
      lightbaseRef: it.lightbaseRef ?? null,
      inventoryItemId: it.inventoryItemId ?? null,
      _total: total,
    });
  }

  const ship = Number(quote.shippingCost ?? 0);
  const total = subtotal + ship;
  const poNumber = await nextPoNumber();

  const [po] = await db
    .insert(purchaseOrders)
    .values({
      poNumber,
      rfqId: input.rfqId,
      quoteId: input.quoteId,
      supplierId: quote.supplierId,
      supplierName: quote.companyName,
      projectNum: rfq.projectNum,
      projectName: rfq.projectName,
      propositionReference: rfq.rfqNumber,
      currency: quote.currency,
      incoterms: quote.incoterms ?? rfq.incoterms,
      transportMode: quote.transportMode ?? rfq.transportMode,
      subtotal: String(subtotal),
      discountAmount: "0",
      taxAmount: String(ship),
      totalAmount: String(total),
      billingAddress: "Lightbase\n10871 Avenue Salk, Montreal, QC, H1G 6M7, Canada",
      shippingAddress: "Lightbase\n10871 Avenue Salk, Montreal, QC, H1G 6M7, Canada",
      status: "draft",
      createdByClerkId: input.createdByClerkId,
    })
    .returning();

  if (poLines.length > 0) {
    await db.insert(purchaseOrderLines).values(
      poLines.map((l) => ({
        poId: po.id,
        lineNo: l.lineNo,
        ref: l.ref ?? null,
        description: l.description,
        qty: l.qty,
        unitPrice: l.unitPrice,
        totalPrice: l.totalPrice,
      })),
    );
  }

  await notifyTeam({
    kind: "po.issued",
    title: `PO ${poNumber} drafted for ${quote.companyName}`,
    body: `Project ${rfq.projectNum} · ${quote.currency} ${total.toFixed(2)}`,
    linkUrl: `/suppliers/po/${po.id}`,
    poId: po.id,
    rfqId: input.rfqId,
    quoteId: input.quoteId,
  });

  revalidatePath("/suppliers");
  return { poId: po.id, poNumber };
}

export async function sendPo(poId: number): Promise<void> {
  await requireSupplierEditor();
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) throw new Error("PO not found");
  await db
    .update(purchaseOrders)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(purchaseOrders.id, poId));
  await notifyTeam({
    kind: "po.issued",
    title: `PO ${po.poNumber} sent to ${po.supplierName}`,
    body: `Project ${po.projectNum}`,
    linkUrl: `/suppliers/po/${po.id}`,
    poId: po.id,
  });
  if (po.supplierId) {
    await notifySupplier({
      supplierId: po.supplierId,
      kind: "po.issued",
      title: `📦 New PO ${po.poNumber} received`,
      body: `From ${process.env.NEXT_PUBLIC_CLIENT_NAME ?? "the buyer"} · Project ${po.projectNum}`,
      linkUrl: `/portal`,
      poId: po.id,
    });
  }
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/po/${poId}`);
  revalidatePath("/portal");
}

// ─────────────────────────────────────────────────────────────────────────────
// PO source-PDF — optional buyer-uploaded PDF that supersedes the platform-
// generated print view. Stored on the purchase_orders row alongside the
// blob pathname so deletion cleans up storage.
// ─────────────────────────────────────────────────────────────────────────────

export async function setPoSourcePdf(input: {
  poId: number;
  url: string;
  name: string;
  blobPathname: string;
}): Promise<void> {
  await requireSupplierEditor();
  // If there was a prior source PDF, remove its blob.
  const [prev] = await db
    .select({ pathname: purchaseOrders.sourcePdfPathname, url: purchaseOrders.sourcePdfUrl })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.poId))
    .limit(1);
  if (prev?.url) {
    try {
      await del(prev.url);
    } catch (e) {
      console.error("Blob del (old PO source PDF) failed", e);
    }
  }
  await db
    .update(purchaseOrders)
    .set({
      sourcePdfUrl: input.url,
      sourcePdfName: input.name,
      sourcePdfPathname: input.blobPathname,
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, input.poId));
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/po/${input.poId}`);
  revalidatePath("/portal");
}

export async function clearPoSourcePdf(poId: number): Promise<void> {
  await requireSupplierEditor();
  const [po] = await db
    .select({ url: purchaseOrders.sourcePdfUrl })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (po?.url) {
    try {
      await del(po.url);
    } catch (e) {
      console.error("Blob del failed", e);
    }
  }
  await db
    .update(purchaseOrders)
    .set({
      sourcePdfUrl: null,
      sourcePdfName: null,
      sourcePdfPathname: null,
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, poId));
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/po/${poId}`);
  revalidatePath("/portal");
}

export async function updatePoStatus(input: {
  poId: number;
  status: PurchaseOrder["status"];
}): Promise<void> {
  await requireSupplierEditor();
  const set: Partial<typeof purchaseOrders.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
  };
  const now = new Date();
  if (input.status === "acknowledged") set.acknowledgedAt = now;
  if (input.status === "shipped") set.shippedAt = now;
  if (input.status === "received") set.receivedAt = now;
  await db.update(purchaseOrders).set(set).where(eq(purchaseOrders.id, input.poId));
  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/po/${input.poId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING + DETAIL READS (used by the Orders tab + the PO print page)
// ─────────────────────────────────────────────────────────────────────────────

export type RfqListRow = Rfq & {
  itemCount: number;
  recipientCount: number;
  quoteCount: number;
};

export async function listRfqs(): Promise<RfqListRow[]> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  // Use Drizzle's typed query API instead of db.execute(sql`...`) — the
  // Neon HTTP driver returns { rows, rowCount } from db.execute, which
  // broke rows.map(). Subqueries via sql<number> stay typed cleanly.
  const rows = await db
    .select({
      // Spread all rfq columns
      id: rfqs.id,
      rfqNumber: rfqs.rfqNumber,
      projectNum: rfqs.projectNum,
      projectName: rfqs.projectName,
      niche: rfqs.niche,
      stage: rfqs.stage,
      status: rfqs.status,
      transportMode: rfqs.transportMode,
      targetCurrency: rfqs.targetCurrency,
      incoterms: rfqs.incoterms,
      targetDeliveryDate: rfqs.targetDeliveryDate,
      quoteDeadline: rfqs.quoteDeadline,
      notes: rfqs.notes,
      ownerClerkId: rfqs.ownerClerkId,
      awardedQuoteId: rfqs.awardedQuoteId,
      sourcePdfUrl: rfqs.sourcePdfUrl,
      sourcePdfName: rfqs.sourcePdfName,
      sourcePdfPathname: rfqs.sourcePdfPathname,
      createdAt: rfqs.createdAt,
      updatedAt: rfqs.updatedAt,
      itemCount: sql<number>`(SELECT COUNT(*)::int FROM rfq_items i WHERE i.rfq_id = ${rfqs.id})`,
      recipientCount: sql<number>`(SELECT COUNT(*)::int FROM rfq_recipients re WHERE re.rfq_id = ${rfqs.id})`,
      quoteCount: sql<number>`(SELECT COUNT(*)::int FROM supplier_quotes q WHERE q.rfq_id = ${rfqs.id} AND q.status IN ('submitted','draft','viewed'))`,
    })
    .from(rfqs)
    .orderBy(desc(rfqs.createdAt));
  return rows.map((r) => ({
    ...r,
    itemCount: Number(r.itemCount ?? 0),
    recipientCount: Number(r.recipientCount ?? 0),
    quoteCount: Number(r.quoteCount ?? 0),
  }));
}

export type RfqDetailPayload = {
  rfq: Rfq;
  items: RfqItem[];
  recipients: Array<RfqRecipient & { portalUrl: string }>;
  quotes: Array<
    SupplierQuote & {
      lines: SupplierQuoteLine[];
      attachments: SupplierQuoteAttachment[];
    }
  >;
  pos: PurchaseOrder[];
};

export async function getRfqDetail(rfqId: number): Promise<RfqDetailPayload | null> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, rfqId))
    .limit(1);
  if (!rfq) return null;
  const [items, recipients, quoteRows, pos] = await Promise.all([
    db
      .select()
      .from(rfqItems)
      .where(eq(rfqItems.rfqId, rfqId))
      .orderBy(rfqItems.lineNo),
    db
      .select()
      .from(rfqRecipients)
      .where(eq(rfqRecipients.rfqId, rfqId))
      .orderBy(desc(rfqRecipients.invitedAt)),
    db
      .select()
      .from(supplierQuotes)
      .where(eq(supplierQuotes.rfqId, rfqId))
      .orderBy(desc(supplierQuotes.updatedAt)),
    db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.rfqId, rfqId))
      .orderBy(desc(purchaseOrders.createdAt)),
  ]);
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  const quoteIds = quoteRows.map((q) => q.id);
  // Use Drizzle's inArray() instead of `sql\`... = ANY(${ids})\`` — the
  // Neon HTTP driver binds the template's array param as a scalar, which
  // gives Postgres "operator does not exist: integer = integer[]". inArray
  // emits the right `WHERE col IN ($1, $2, …)` form.
  const [lines, attachments] = await Promise.all([
    quoteIds.length
      ? db
          .select()
          .from(supplierQuoteLines)
          .where(inArray(supplierQuoteLines.quoteId, quoteIds))
      : Promise.resolve([] as SupplierQuoteLine[]),
    quoteIds.length
      ? db
          .select()
          .from(supplierQuoteAttachments)
          .where(inArray(supplierQuoteAttachments.quoteId, quoteIds))
      : Promise.resolve([] as SupplierQuoteAttachment[]),
  ]);
  const linesByQuote = new Map<number, SupplierQuoteLine[]>();
  for (const l of lines) {
    const list = linesByQuote.get(l.quoteId) ?? [];
    list.push(l);
    linesByQuote.set(l.quoteId, list);
  }
  const attsByQuote = new Map<number, SupplierQuoteAttachment[]>();
  for (const a of attachments) {
    const list = attsByQuote.get(a.quoteId) ?? [];
    list.push(a);
    attsByQuote.set(a.quoteId, list);
  }
  const quotes = quoteRows.map((q) => ({
    ...q,
    lines: linesByQuote.get(q.id) ?? [],
    attachments: attsByQuote.get(q.id) ?? [],
  }));
  return {
    rfq,
    items,
    recipients: recipients.map((r) => ({
      ...r,
      portalUrl: `${base}/vendor/${r.accessToken}`,
    })),
    quotes,
    pos,
  };
}

export type PoDetailPayload = {
  po: PurchaseOrder;
  lines: PurchaseOrderLine[];
};

export async function getPoDetail(poId: number): Promise<PoDetailPayload | null> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) return null;
  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.poId, poId))
    .orderBy(purchaseOrderLines.lineNo);
  return { po, lines };
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS — read API for the bell icon
// ─────────────────────────────────────────────────────────────────────────────

export async function listMyNotifications(): Promise<{
  unread: number;
  recent: ErpNotification[];
}> {
  const profile = await getOrCreateProfile();
  if (!profile) return { unread: 0, recent: [] };
  await ensureOrdersSchema();
  const recent = await db
    .select()
    .from(erpNotifications)
    .where(eq(erpNotifications.targetClerkId, profile.clerkUserId))
    .orderBy(desc(erpNotifications.createdAt))
    .limit(20);
  const unread = recent.filter((n) => !n.readAt).length;
  return { unread, recent };
}

export async function markNotificationRead(id: number): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) return;
  await db
    .update(erpNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(erpNotifications.id, id),
        eq(erpNotifications.targetClerkId, profile.clerkUserId),
      ),
    );
}

export async function markAllNotificationsRead(): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) return;
  await db
    .update(erpNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(erpNotifications.targetClerkId, profile.clerkUserId),
        sql`${erpNotifications.readAt} is null`,
      ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR PORTAL — no auth; identifies the supplier by `accessToken`.
// ─────────────────────────────────────────────────────────────────────────────

export type VendorPortalPayload = {
  recipient: RfqRecipient;
  rfq: Rfq;
  items: RfqItem[];
  quote: SupplierQuote | null;
  lines: SupplierQuoteLine[];
  attachments: SupplierQuoteAttachment[];
};

export async function getVendorPortal(token: string): Promise<VendorPortalPayload | null> {
  await ensureOrdersSchema();
  const cleanToken = (token ?? "").trim();
  if (!cleanToken) return null;
  const [recipient] = await db
    .select()
    .from(rfqRecipients)
    .where(eq(rfqRecipients.accessToken, cleanToken))
    .limit(1);
  if (!recipient) return null;
  if (recipient.tokenExpiresAt && recipient.tokenExpiresAt < new Date()) {
    return null;
  }
  // Stamp viewed
  if (!recipient.viewedAt) {
    await db
      .update(rfqRecipients)
      .set({ viewedAt: new Date(), status: "viewed" })
      .where(eq(rfqRecipients.id, recipient.id));
  }
  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, recipient.rfqId))
    .limit(1);
  if (!rfq) return null;
  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, recipient.rfqId))
    .orderBy(rfqItems.lineNo);
  const [quote] = await db
    .select()
    .from(supplierQuotes)
    .where(eq(supplierQuotes.recipientId, recipient.id))
    .orderBy(desc(supplierQuotes.updatedAt))
    .limit(1);
  let lines: SupplierQuoteLine[] = [];
  let attachments: SupplierQuoteAttachment[] = [];
  if (quote) {
    [lines, attachments] = await Promise.all([
      db
        .select()
        .from(supplierQuoteLines)
        .where(eq(supplierQuoteLines.quoteId, quote.id)),
      db
        .select()
        .from(supplierQuoteAttachments)
        .where(eq(supplierQuoteAttachments.quoteId, quote.id)),
    ]);
  }
  return { recipient, rfq, items, quote: quote ?? null, lines, attachments };
}

export type VendorQuoteInput = {
  token: string;
  companyName: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  countryOfOrigin?: string;
  manufacturerName?: string;
  manufacturerPartNumber?: string;
  currency?: string;
  incoterms?: string;
  transportMode?: Rfq["transportMode"];
  shippingCost?: number;
  leadTimeDays?: number;
  validityUntil?: string | null;
  notes?: string;
  sourcePdfUrl?: string;
  sourcePdfName?: string;
  finalize: boolean; // false = save draft, true = submit
  lines: Array<{
    rfqItemId: number;
    unitPrice: number;
    moq?: number;
    volumeDiscounts?: Array<{ qty: number; unitPrice: number }>;
    availableStock?: number | null;
    leadTimeDays?: number | null;
    notes?: string;
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// DECLINE — supplier-side "no thanks." Creates or updates a supplier_quote
// row with status=declined and stores the reason in quote.notes so it
// surfaces on the buyer's Invited table + Quotes comparison. Recipient
// also flips to declined. Team is notified.
// ─────────────────────────────────────────────────────────────────────────────

export async function declineVendorRfq(input: {
  token: string;
  reason?: string;
}): Promise<{ ok: true }> {
  await ensureOrdersSchema();
  const portal = await getVendorPortal(input.token);
  if (!portal) throw new Error("Invalid or expired access link");
  if (portal.recipient.status === "submitted") {
    throw new Error("You've already submitted a quote — can't decline after submitting.");
  }
  const reason = (input.reason ?? "").trim();
  const now = new Date();

  // Resolve / link a supplier row (same logic as submitVendorQuote so a
  // brand-new email gets a supplier record even when declining).
  let supplierId = portal.recipient.supplierId ?? null;
  if (!supplierId) {
    const inviteEmail = portal.recipient.inviteEmail.toLowerCase();
    const existing = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.email, inviteEmail))
      .limit(1);
    if (existing.length > 0) supplierId = existing[0].id;
  }

  const declineBody = reason ? `Declined: ${reason}` : "Declined by supplier";

  if (portal.quote) {
    await db
      .update(supplierQuotes)
      .set({
        status: "declined",
        notes: declineBody,
        submittedAt: now,
        supplierId,
        updatedAt: now,
      })
      .where(eq(supplierQuotes.id, portal.quote.id));
  } else {
    await db.insert(supplierQuotes).values({
      rfqId: portal.recipient.rfqId,
      recipientId: portal.recipient.id,
      supplierId,
      companyName: portal.recipient.inviteName ?? portal.recipient.inviteEmail,
      contactEmail: portal.recipient.inviteEmail,
      currency: portal.rfq.targetCurrency,
      transportMode: portal.rfq.transportMode,
      status: "declined",
      notes: declineBody,
      submittedAt: now,
    });
  }

  await db
    .update(rfqRecipients)
    .set({ status: "declined", respondedAt: now })
    .where(eq(rfqRecipients.id, portal.recipient.id));

  await notifyTeam({
    kind: "rfq.quote-received",
    title: `RFQ declined by ${portal.recipient.inviteName ?? portal.recipient.inviteEmail}`,
    body: reason
      ? `${portal.rfq.rfqNumber} · ${reason}`
      : `${portal.rfq.rfqNumber} · no reason given`,
    linkUrl: `/suppliers?orders=${portal.rfq.id}`,
    rfqId: portal.rfq.id,
  });

  revalidatePath(`/vendor/${input.token}`);
  revalidatePath("/portal");
  revalidatePath("/suppliers");
  return { ok: true };
}

export async function submitVendorQuote(input: VendorQuoteInput): Promise<{
  quoteId: number;
  status: SupplierQuote["status"];
}> {
  await ensureOrdersSchema();
  const portal = await getVendorPortal(input.token);
  if (!portal) throw new Error("Invalid or expired access link");

  // Find or create a supplier row keyed by email so the buyer can pull
  // it up in the directory later.
  let supplierId = portal.recipient.supplierId ?? null;
  if (!supplierId) {
    const inviteEmail = (
      input.contactEmail || portal.recipient.inviteEmail
    ).toLowerCase();
    const existing = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.email, inviteEmail))
      .limit(1);
    if (existing.length > 0) {
      supplierId = existing[0].id;
    } else {
      const [created] = await db
        .insert(suppliers)
        .values({
          name: input.companyName.trim() || portal.recipient.inviteName || inviteEmail,
          email: inviteEmail,
          phone: input.contactPhone?.trim() || null,
          contactName: input.contactName?.trim() || null,
          status: "Active",
          category: "Manufacturing",
          origin: input.countryOfOrigin?.trim() || null,
          source: "vendor-portal",
        })
        .returning();
      supplierId = created.id;
      await notifyTeam({
        kind: "supplier.signed-up",
        title: `New supplier signed up: ${created.name}`,
        body: inviteEmail,
        linkUrl: "/suppliers",
      });
    }
    await db
      .update(rfqRecipients)
      .set({ supplierId })
      .where(eq(rfqRecipients.id, portal.recipient.id));
  }

  const status: SupplierQuote["status"] = input.finalize ? "submitted" : "draft";
  const baseValues = {
    rfqId: portal.recipient.rfqId,
    recipientId: portal.recipient.id,
    supplierId,
    companyName: input.companyName.trim(),
    contactName: input.contactName?.trim() || null,
    contactEmail: input.contactEmail?.trim() || portal.recipient.inviteEmail,
    contactPhone: input.contactPhone?.trim() || null,
    address: input.address?.trim() || null,
    countryOfOrigin: input.countryOfOrigin?.trim() || null,
    manufacturerName: input.manufacturerName?.trim() || null,
    manufacturerPartNumber: input.manufacturerPartNumber?.trim() || null,
    currency: input.currency ?? portal.rfq.targetCurrency,
    incoterms: input.incoterms?.trim() || null,
    transportMode: input.transportMode ?? portal.rfq.transportMode,
    shippingCost: String(input.shippingCost ?? 0),
    leadTimeDays: Math.max(0, input.leadTimeDays ?? 0),
    validityUntil: input.validityUntil ?? null,
    notes: input.notes?.trim() || null,
    sourcePdfUrl: input.sourcePdfUrl?.trim() || null,
    sourcePdfName: input.sourcePdfName?.trim() || null,
    status,
    submittedAt: input.finalize ? new Date() : null,
    updatedAt: new Date(),
  };

  let quoteId: number;
  if (portal.quote) {
    await db
      .update(supplierQuotes)
      .set(baseValues)
      .where(eq(supplierQuotes.id, portal.quote.id));
    quoteId = portal.quote.id;
    await db.delete(supplierQuoteLines).where(eq(supplierQuoteLines.quoteId, quoteId));
  } else {
    const [q] = await db.insert(supplierQuotes).values(baseValues).returning();
    quoteId = q.id;
  }

  if (input.lines.length > 0) {
    await db.insert(supplierQuoteLines).values(
      input.lines.map((l) => ({
        quoteId,
        rfqItemId: l.rfqItemId,
        unitPrice: String(l.unitPrice ?? 0),
        moq: Math.max(1, l.moq ?? 1),
        volumeDiscounts: l.volumeDiscounts ?? [],
        availableStock: l.availableStock ?? null,
        leadTimeDays: l.leadTimeDays ?? null,
        notes: l.notes?.trim() || null,
      })),
    );
  }

  // Update recipient status to mirror the quote.
  await db
    .update(rfqRecipients)
    .set({
      status,
      respondedAt: input.finalize ? new Date() : null,
    })
    .where(eq(rfqRecipients.id, portal.recipient.id));

  // If finalised, ping the buyers + flip the RFQ to quotes-in.
  if (input.finalize) {
    await db
      .update(rfqs)
      .set({ status: "quotes-in", updatedAt: new Date() })
      .where(and(eq(rfqs.id, portal.recipient.rfqId), sql`${rfqs.status} IN ('draft','sent')`));
    await notifyTeam({
      kind: "rfq.quote-received",
      title: `Quote received from ${input.companyName}`,
      body: `RFQ ${portal.rfq.rfqNumber} · project ${portal.rfq.projectNum}`,
      linkUrl: `/suppliers?orders=${portal.rfq.id}`,
      rfqId: portal.rfq.id,
      quoteId,
    });
  }

  revalidatePath(`/vendor/${input.token}`);
  revalidatePath("/suppliers");
  return { quoteId, status };
}

export async function addVendorQuoteAttachment(input: {
  token: string;
  kind: string; // datasheet / certification / brochure / image / other
  name: string;
  size: number;
  mimeType?: string;
  url: string;
  blobPathname: string;
}): Promise<{ id: number }> {
  const portal = await getVendorPortal(input.token);
  if (!portal) throw new Error("Invalid or expired access link");
  if (!portal.quote) throw new Error("Submit the quote first, then add files");
  const [row] = await db
    .insert(supplierQuoteAttachments)
    .values({
      quoteId: portal.quote.id,
      kind: (input.kind ?? "other").toLowerCase(),
      name: input.name,
      size: input.size,
      mimeType: input.mimeType ?? null,
      url: input.url,
      blobPathname: input.blobPathname,
    })
    .returning();
  revalidatePath(`/vendor/${input.token}`);
  return { id: row.id };
}

export async function deleteVendorQuoteAttachment(input: {
  token: string;
  attachmentId: number;
}): Promise<void> {
  const portal = await getVendorPortal(input.token);
  if (!portal || !portal.quote) throw new Error("Invalid link");
  const [att] = await db
    .select()
    .from(supplierQuoteAttachments)
    .where(eq(supplierQuoteAttachments.id, input.attachmentId))
    .limit(1);
  if (!att || att.quoteId !== portal.quote.id) return;
  if (att.blobPathname) {
    try {
      await del(att.url);
    } catch (e) {
      console.error("Blob del failed", att.url, e);
    }
  }
  await db
    .delete(supplierQuoteAttachments)
    .where(eq(supplierQuoteAttachments.id, input.attachmentId));
  revalidatePath(`/vendor/${input.token}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER HOME PORTAL — stable, long-lived magic link per supplier.
// Different from the per-RFQ token (rfq_recipients.access_token) so the
// admin can:
//   - revoke a supplier's home access without touching individual RFQs
//   - re-issue a fresh home URL when the supplier's contact changes
//   - copy the home URL to send to the supplier's primary contact
// The home view lists every RFQ the supplier has ever been invited to,
// linking into the per-RFQ portal (which still uses its own token).
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureSupplierPortalToken(input: {
  supplierId: number;
}): Promise<{ portalToken: string; portalUrl: string; created: boolean }> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const [row] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!row) throw new Error("Supplier not found");
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  if (row.portalToken) {
    return {
      portalToken: row.portalToken,
      portalUrl: `${base}/vendor/home/${row.portalToken}`,
      created: false,
    };
  }
  const token = randomToken();
  await db
    .update(suppliers)
    .set({ portalToken: token, updatedAt: new Date() })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/suppliers");
  revalidatePath("/admin");
  return {
    portalToken: token,
    portalUrl: `${base}/vendor/home/${token}`,
    created: true,
  };
}

export async function reissueSupplierPortalToken(input: {
  supplierId: number;
}): Promise<{ portalToken: string; portalUrl: string }> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const token = randomToken();
  const [row] = await db
    .update(suppliers)
    .set({ portalToken: token, updatedAt: new Date() })
    .where(eq(suppliers.id, input.supplierId))
    .returning();
  if (!row) throw new Error("Supplier not found");
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  revalidatePath("/suppliers");
  revalidatePath("/admin");
  return {
    portalToken: token,
    portalUrl: `${base}/vendor/home/${token}`,
  };
}

export async function revokeSupplierPortalToken(input: {
  supplierId: number;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  await db
    .update(suppliers)
    .set({ portalToken: null, updatedAt: new Date() })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

// Public read for /vendor/home/[token] — no auth, the token IS the auth.
export type SupplierHomePayload = {
  supplier: {
    id: number;
    name: string;
    email: string | null;
    contactName: string | null;
    portalToken: string;
  };
  invites: Array<{
    recipientId: number;
    rfqId: number;
    rfqNumber: string;
    rfqStatus: Rfq["status"];
    rfqStage: Rfq["stage"];
    projectNum: string;
    projectName: string | null;
    niche: string | null;
    transportMode: Rfq["transportMode"];
    currency: string;
    quoteDeadline: Date | null;
    invitedAt: Date;
    recipientStatus: RfqRecipient["status"];
    accessToken: string;
    tokenExpiresAt: Date | null;
    perRfqUrl: string;
    quoteStatus: SupplierQuote["status"] | null;
  }>;
};

export async function getSupplierHome(token: string): Promise<SupplierHomePayload | null> {
  await ensureSupplierColumns();
  await ensureOrdersSchema();
  const cleanToken = (token ?? "").trim();
  if (!cleanToken) return null;
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.portalToken, cleanToken))
    .limit(1);
  if (!supplier || !supplier.portalToken) return null;
  // Pull every invite for this supplier — by supplier_id OR by email match
  // (covers RFQs invited by email before the supplier row was linked).
  const inviteEmail = (supplier.email ?? "").toLowerCase();
  const rows = await db
    .select({
      recipient: rfqRecipients,
      rfq: rfqs,
      quote: supplierQuotes,
    })
    .from(rfqRecipients)
    .innerJoin(rfqs, eq(rfqs.id, rfqRecipients.rfqId))
    .leftJoin(
      supplierQuotes,
      and(
        eq(supplierQuotes.recipientId, rfqRecipients.id),
        eq(supplierQuotes.rfqId, rfqs.id),
      ),
    )
    .where(
      inviteEmail
        ? sql`${rfqRecipients.supplierId} = ${supplier.id} OR LOWER(${rfqRecipients.inviteEmail}) = ${inviteEmail}`
        : eq(rfqRecipients.supplierId, supplier.id),
    )
    .orderBy(desc(rfqRecipients.invitedAt));
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      email: supplier.email,
      contactName: supplier.contactName,
      portalToken: supplier.portalToken,
    },
    invites: rows.map((r) => ({
      recipientId: r.recipient.id,
      rfqId: r.rfq.id,
      rfqNumber: r.rfq.rfqNumber,
      rfqStatus: r.rfq.status,
      rfqStage: r.rfq.stage,
      projectNum: r.rfq.projectNum,
      projectName: r.rfq.projectName,
      niche: r.rfq.niche,
      transportMode: r.rfq.transportMode,
      currency: r.rfq.targetCurrency,
      quoteDeadline: r.rfq.quoteDeadline,
      invitedAt: r.recipient.invitedAt,
      recipientStatus: r.recipient.status,
      accessToken: r.recipient.accessToken,
      tokenExpiresAt: r.recipient.tokenExpiresAt,
      perRfqUrl: `${base}/vendor/${r.recipient.accessToken}`,
      quoteStatus: r.quote?.status ?? null,
    })),
  };
}
