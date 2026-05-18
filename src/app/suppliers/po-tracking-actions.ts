"use server";

// Payment-transparency + production-tracking server actions on top of POs.
//
//   • Supplier-side actions are callable by either a Clerk-authed supplier
//     user (matched against suppliers.email / supplier_contacts.email) OR a
//     buyer-side editor (so admins can post on behalf of the supplier when
//     debugging). Both call `assertCanActAsSupplier(poId)`.
//   • Buyer-side actions (invoice status flips, proof-of-payment) require
//     `requireSupplierEditor()` — only the buyer-side AP team can mark an
//     invoice approved / scheduled / paid.
//   • Both sides emit notifications (notifyTeam + notifySupplier) so the
//     other party's bell lights up immediately. No phone/email needed.

import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "@/db";
import {
  erpNotifications,
  poInvoices,
  poPaymentMethods,
  poPayments,
  poTimeline,
  purchaseOrders,
  suppliers,
  supplierContacts,
  userProfiles,
  type ErpNotification,
  type PoInvoice,
  type PoPaymentMethod,
  type PoPayment,
  type PoTimelineEntry,
  type PurchaseOrder,
  type UserProfile,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isSupplierUser,
  requireSupplierEditor,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";
import { ensureOrdersSchema } from "./_ensure-orders-schema";

// ─────────────────────────────────────────────────────────────────────────────
// AUTHZ HELPERS
// ─────────────────────────────────────────────────────────────────────────────

type ActorContext = {
  profile: UserProfile;
  role: "supplier" | "buyer";
  po: PurchaseOrder;
};

// The supplier on this PO can post their payment method, issue invoices,
// and post production-timeline updates. The buyer (admin / supplier-editor)
// can do all of those too — handy when the buyer is entering data on the
// supplier's behalf.
async function assertCanActAsSupplier(poId: number): Promise<ActorContext> {
  await ensureOrdersSchema();
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: please sign in");
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) throw new Error("PO not found");

  // Buyer staff can act as either party.
  if (canViewSuppliers(profile) && canEdit(profile)) {
    return { profile, role: "buyer", po };
  }

  // Otherwise must be the supplier on this PO. Resolve by email match
  // against suppliers.email OR supplier_contacts.email for this supplier.
  if (isSupplierUser(profile) && po.supplierId) {
    const profileEmail = (profile.email ?? "").toLowerCase();
    const matches = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .leftJoin(supplierContacts, eq(supplierContacts.supplierId, suppliers.id))
      .where(
        and(
          eq(suppliers.id, po.supplierId),
          sql`(LOWER(${suppliers.email}) = ${profileEmail} OR LOWER(${supplierContacts.email}) = ${profileEmail})`,
        ),
      )
      .limit(1);
    if (matches.length > 0) return { profile, role: "supplier", po };
  }

  throw new Error("Unauthorized: not the supplier on this PO");
}

async function assertCanActAsBuyer(poId: number): Promise<ActorContext> {
  await ensureOrdersSchema();
  const profile = await requireSupplierEditor();
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) throw new Error("PO not found");
  return { profile, role: "buyer", po };
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS — same pattern as rfq-actions.ts but separated out so the
// payment-tracking events don't leak supplier emails to the buyer team and
// vice versa.
// ─────────────────────────────────────────────────────────────────────────────

async function notifyBuyerTeam(input: {
  kind: ErpNotification["kind"];
  title: string;
  body?: string;
  linkUrl?: string;
  poId?: number;
}): Promise<void> {
  try {
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
        poId: input.poId ?? null,
      })),
    );
  } catch (e) {
    console.warn("[po-tracking] notifyBuyerTeam failed:", e);
  }
}

async function notifySupplierUsers(input: {
  supplierId: number;
  kind: ErpNotification["kind"];
  title: string;
  body?: string;
  linkUrl?: string;
  poId?: number;
}): Promise<void> {
  try {
    const emails = (await db.execute(sql`
      SELECT LOWER(email) AS email FROM suppliers WHERE id = ${input.supplierId} AND email IS NOT NULL
      UNION
      SELECT LOWER(email) AS email FROM supplier_contacts WHERE supplier_id = ${input.supplierId}
    `)) as unknown as { rows?: Array<{ email: string }> } | Array<{ email: string }>;
    const list = Array.isArray(emails) ? emails : Array.isArray(emails?.rows) ? emails.rows : [];
    const emailSet = list.map((r) => r.email).filter(Boolean);
    if (emailSet.length === 0) return;
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
        poId: input.poId ?? null,
      })),
    );
  } catch (e) {
    console.warn("[po-tracking] notifySupplierUsers failed:", e);
  }
}

function revalidatePoPaths(poId: number): void {
  revalidatePath("/suppliers");
  revalidatePath("/portal");
  revalidatePath(`/suppliers/po/${poId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// READ — single bundle pulled by both buyer + supplier views
// ─────────────────────────────────────────────────────────────────────────────

export type PoTrackerPayload = {
  paymentMethod: PoPaymentMethod | null;
  invoices: PoInvoice[];
  payments: PoPayment[];
  timeline: PoTimelineEntry[];
};

export async function getPoTrackerData(poId: number): Promise<PoTrackerPayload> {
  await ensureOrdersSchema();
  // Read auth: buyer staff OR the matching supplier user.
  await assertCanActAsSupplier(poId);
  const [pm] = await db
    .select()
    .from(poPaymentMethods)
    .where(eq(poPaymentMethods.poId, poId))
    .orderBy(desc(poPaymentMethods.postedAt))
    .limit(1);
  const invoices = await db
    .select()
    .from(poInvoices)
    .where(eq(poInvoices.poId, poId))
    .orderBy(desc(poInvoices.createdAt));
  const payments = await db
    .select()
    .from(poPayments)
    .where(eq(poPayments.poId, poId))
    .orderBy(desc(poPayments.paidOn));
  const timeline = await db
    .select()
    .from(poTimeline)
    .where(eq(poTimeline.poId, poId))
    .orderBy(desc(poTimeline.postedAt));
  return { paymentMethod: pm ?? null, invoices, payments, timeline };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT METHOD — supplier (or buyer-on-behalf) posts banking instructions
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentMethodInput = {
  poId: number;
  bankName?: string;
  accountHolder?: string;
  iban?: string;
  swiftBic?: string;
  accountNumber?: string;
  routingNumber?: string;
  additionalMethods?: Array<{ kind: string; value: string }>;
  acceptedCurrencies?: string;
  paymentTerms?: string;
  additionalNotes?: string;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentPathname?: string;
};

export async function setPoPaymentMethod(input: PaymentMethodInput): Promise<void> {
  const ctx = await assertCanActAsSupplier(input.poId);
  const now = new Date();
  // Replace any existing row — the latest banking instructions stand. We
  // delete the prior row's blob if it had one and the new one is different.
  const [prev] = await db
    .select()
    .from(poPaymentMethods)
    .where(eq(poPaymentMethods.poId, input.poId))
    .orderBy(desc(poPaymentMethods.postedAt))
    .limit(1);
  if (prev?.attachmentUrl && prev.attachmentUrl !== (input.attachmentUrl ?? null)) {
    try { await del(prev.attachmentUrl); } catch (e) { console.warn("Blob del (payment method) failed", e); }
  }

  const baseValues = {
    poId: input.poId,
    bankName: input.bankName?.trim() || null,
    accountHolder: input.accountHolder?.trim() || null,
    iban: input.iban?.trim() || null,
    swiftBic: input.swiftBic?.trim() || null,
    accountNumber: input.accountNumber?.trim() || null,
    routingNumber: input.routingNumber?.trim() || null,
    additionalMethods: input.additionalMethods ?? [],
    acceptedCurrencies: input.acceptedCurrencies?.trim() || null,
    paymentTerms: input.paymentTerms?.trim() || null,
    additionalNotes: input.additionalNotes?.trim() || null,
    attachmentUrl: input.attachmentUrl ?? null,
    attachmentName: input.attachmentName ?? null,
    attachmentPathname: input.attachmentPathname ?? null,
    postedByClerkId: ctx.profile.clerkUserId,
    postedAt: now,
    updatedAt: now,
  };

  if (prev) {
    await db.update(poPaymentMethods).set(baseValues).where(eq(poPaymentMethods.id, prev.id));
  } else {
    await db.insert(poPaymentMethods).values(baseValues);
  }

  // Notify the buyer team so AP knows banking details are in.
  await notifyBuyerTeam({
    kind: "po.payment-method-set",
    title: `💳 Payment method posted for PO ${ctx.po.poNumber}`,
    body: `${ctx.po.supplierName} · Project ${ctx.po.projectNum}${input.paymentTerms ? ` · ${input.paymentTerms}` : ""}`,
    linkUrl: `/suppliers/po/${input.poId}`,
    poId: input.poId,
  });
  // Echo to supplier(s) for confirmation.
  if (ctx.po.supplierId) {
    await notifySupplierUsers({
      supplierId: ctx.po.supplierId,
      kind: "po.payment-method-set",
      title: `Payment instructions saved for PO ${ctx.po.poNumber}`,
      body: `The buyer can now see them in the AP tracker.`,
      linkUrl: `/suppliers/po/${input.poId}`,
      poId: input.poId,
    });
  }
  revalidatePoPaths(input.poId);
}

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES — supplier issues; buyer transitions through statuses
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceInput = {
  poId: number;
  invoiceNumber: string;
  amount: number;
  currency?: string;
  issueDate?: string | null;
  dueDate?: string | null;
  fileUrl?: string;
  fileName?: string;
  filePathname?: string;
  notes?: string;
};

export async function addPoInvoice(input: InvoiceInput): Promise<{ invoiceId: number }> {
  const ctx = await assertCanActAsSupplier(input.poId);
  if (!input.invoiceNumber.trim()) throw new Error("Invoice number is required");
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    throw new Error("Invoice amount must be positive");

  const [row] = await db
    .insert(poInvoices)
    .values({
      poId: input.poId,
      invoiceNumber: input.invoiceNumber.trim(),
      amount: String(input.amount),
      currency: input.currency?.trim() || ctx.po.currency,
      issueDate: input.issueDate ?? null,
      dueDate: input.dueDate ?? null,
      fileUrl: input.fileUrl ?? null,
      fileName: input.fileName ?? null,
      filePathname: input.filePathname ?? null,
      notes: input.notes?.trim() || null,
      status: "issued",
      postedByClerkId: ctx.profile.clerkUserId,
    })
    .returning({ id: poInvoices.id });

  await notifyBuyerTeam({
    kind: "po.invoice-issued",
    title: `🧾 Invoice ${input.invoiceNumber} issued for PO ${ctx.po.poNumber}`,
    body: `${ctx.po.supplierName} · ${input.currency ?? ctx.po.currency} ${input.amount.toFixed(2)}`,
    linkUrl: `/suppliers/po/${input.poId}`,
    poId: input.poId,
  });
  if (ctx.po.supplierId) {
    await notifySupplierUsers({
      supplierId: ctx.po.supplierId,
      kind: "po.invoice-issued",
      title: `Invoice ${input.invoiceNumber} sent to ${process.env.NEXT_PUBLIC_CLIENT_NAME ?? "buyer"}`,
      body: `Awaiting AP receipt confirmation.`,
      linkUrl: `/suppliers/po/${input.poId}`,
      poId: input.poId,
    });
  }
  revalidatePoPaths(input.poId);
  return { invoiceId: row.id };
}

export async function deletePoInvoice(input: {
  invoiceId: number;
}): Promise<void> {
  const [inv] = await db
    .select()
    .from(poInvoices)
    .where(eq(poInvoices.id, input.invoiceId))
    .limit(1);
  if (!inv) throw new Error("Invoice not found");
  await assertCanActAsSupplier(inv.poId);
  if (inv.fileUrl) {
    try { await del(inv.fileUrl); } catch (e) { console.warn("Blob del (invoice) failed", e); }
  }
  await db.delete(poInvoices).where(eq(poInvoices.id, input.invoiceId));
  revalidatePoPaths(inv.poId);
}

export async function setInvoiceStatus(input: {
  invoiceId: number;
  status: PoInvoice["status"];
  scheduledPaymentDate?: string | null;
  disputeReason?: string;
}): Promise<void> {
  // Only the buyer's AP team transitions invoice status — they're the ones
  // who see/pay the invoice.
  await ensureOrdersSchema();
  const profile = await requireSupplierEditor();
  const [inv] = await db
    .select()
    .from(poInvoices)
    .where(eq(poInvoices.id, input.invoiceId))
    .limit(1);
  if (!inv) throw new Error("Invoice not found");
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, inv.poId))
    .limit(1);
  if (!po) throw new Error("PO not found");

  const now = new Date();
  const set: Partial<typeof poInvoices.$inferInsert> = {
    status: input.status,
    updatedAt: now,
  };
  if (input.status === "received" && !inv.receivedAt) set.receivedAt = now;
  if (input.status === "approved") {
    if (!inv.receivedAt) set.receivedAt = now;
    set.approvedAt = now;
  }
  if (input.status === "scheduled") {
    if (!inv.receivedAt) set.receivedAt = now;
    if (!inv.approvedAt) set.approvedAt = now;
    set.scheduledAt = now;
    if (input.scheduledPaymentDate)
      set.scheduledPaymentDate = input.scheduledPaymentDate;
  }
  if (input.status === "paid") {
    if (!inv.receivedAt) set.receivedAt = now;
    if (!inv.approvedAt) set.approvedAt = now;
    set.paidAt = now;
  }
  if (input.status === "disputed") {
    set.disputeReason = input.disputeReason?.trim() || "Disputed";
  }
  void profile;
  await db.update(poInvoices).set(set).where(eq(poInvoices.id, input.invoiceId));

  // Inform the supplier so they see AP progress on their side.
  if (po.supplierId) {
    const labelMap: Record<PoInvoice["status"], string> = {
      issued: "issued",
      received: "received by buyer",
      approved: "approved by buyer",
      scheduled: "scheduled for payment",
      paid: "paid",
      disputed: "disputed by buyer",
      cancelled: "cancelled",
    };
    const detail =
      input.status === "scheduled" && input.scheduledPaymentDate
        ? ` · payment scheduled ${input.scheduledPaymentDate}`
        : input.status === "disputed" && input.disputeReason
          ? ` · ${input.disputeReason}`
          : "";
    await notifySupplierUsers({
      supplierId: po.supplierId,
      kind: "po.invoice-status",
      title: `Invoice ${inv.invoiceNumber} ${labelMap[input.status]}`,
      body: `PO ${po.poNumber}${detail}`,
      linkUrl: `/suppliers/po/${inv.poId}`,
      poId: inv.poId,
    });
  }
  revalidatePoPaths(inv.poId);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF OF PAYMENT — buyer records that they actually paid
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentInput = {
  poId: number;
  invoiceId?: number | null;
  amount: number;
  currency?: string;
  paidOn: string;            // YYYY-MM-DD
  method?: string;
  reference?: string;
  fileUrl?: string;
  fileName?: string;
  filePathname?: string;
  notes?: string;
};

export async function addPoPayment(input: PaymentInput): Promise<{ paymentId: number }> {
  const ctx = await assertCanActAsBuyer(input.poId);
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    throw new Error("Payment amount must be positive");
  if (!input.paidOn) throw new Error("Payment date is required");

  const [row] = await db
    .insert(poPayments)
    .values({
      poId: input.poId,
      invoiceId: input.invoiceId ?? null,
      amount: String(input.amount),
      currency: input.currency?.trim() || ctx.po.currency,
      paidOn: input.paidOn,
      method: input.method?.trim() || null,
      reference: input.reference?.trim() || null,
      fileUrl: input.fileUrl ?? null,
      fileName: input.fileName ?? null,
      filePathname: input.filePathname ?? null,
      notes: input.notes?.trim() || null,
      postedByClerkId: ctx.profile.clerkUserId,
    })
    .returning({ id: poPayments.id });

  // If this payment fully covers an invoice, mark the invoice paid.
  if (input.invoiceId) {
    const [inv] = await db
      .select()
      .from(poInvoices)
      .where(eq(poInvoices.id, input.invoiceId))
      .limit(1);
    if (inv && inv.status !== "paid") {
      // Sum every payment against this invoice — including the one we just inserted.
      const paidSum = await db
        .select({
          total: sql<number>`COALESCE(SUM(${poPayments.amount}), 0)::float`,
        })
        .from(poPayments)
        .where(eq(poPayments.invoiceId, input.invoiceId));
      const totalPaid = paidSum[0]?.total ?? 0;
      if (totalPaid >= Number(inv.amount) - 0.005) {
        const now = new Date();
        await db
          .update(poInvoices)
          .set({
            status: "paid",
            paidAt: now,
            receivedAt: inv.receivedAt ?? now,
            approvedAt: inv.approvedAt ?? now,
            updatedAt: now,
          })
          .where(eq(poInvoices.id, input.invoiceId));
      }
    }
  }

  if (ctx.po.supplierId) {
    await notifySupplierUsers({
      supplierId: ctx.po.supplierId,
      kind: "po.payment-recorded",
      title: `💸 Payment recorded for PO ${ctx.po.poNumber}`,
      body: `${input.currency ?? ctx.po.currency} ${input.amount.toFixed(2)} on ${input.paidOn}${input.method ? ` · ${input.method}` : ""}${input.reference ? ` · ref ${input.reference}` : ""}`,
      linkUrl: `/suppliers/po/${input.poId}`,
      poId: input.poId,
    });
  }
  revalidatePoPaths(input.poId);
  return { paymentId: row.id };
}

export async function deletePoPayment(input: { paymentId: number }): Promise<void> {
  const profile = await requireSupplierEditor();
  void profile;
  const [pay] = await db
    .select()
    .from(poPayments)
    .where(eq(poPayments.id, input.paymentId))
    .limit(1);
  if (!pay) throw new Error("Payment not found");
  if (pay.fileUrl) {
    try { await del(pay.fileUrl); } catch (e) { console.warn("Blob del (payment) failed", e); }
  }
  await db.delete(poPayments).where(eq(poPayments.id, input.paymentId));
  revalidatePoPaths(pay.poId);
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMELINE — production / delivery updates. Either party can post.
// When a `phase` is supplied (e.g. "in-production", "shipped"), the PO's
// own status field is updated too so the existing PO chips stay in sync.
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineInput = {
  poId: number;
  phase?: PurchaseOrder["status"];
  title: string;
  note?: string;
  trackingNumber?: string;
  carrier?: string;
  eta?: string | null;       // YYYY-MM-DD
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentPathname?: string;
};

export async function postPoTimelineUpdate(input: TimelineInput): Promise<{ entryId: number }> {
  const ctx = await assertCanActAsSupplier(input.poId);
  if (!input.title.trim()) throw new Error("Update title is required");

  const [row] = await db
    .insert(poTimeline)
    .values({
      poId: input.poId,
      phase: input.phase ?? null,
      title: input.title.trim(),
      note: input.note?.trim() || null,
      trackingNumber: input.trackingNumber?.trim() || null,
      carrier: input.carrier?.trim() || null,
      eta: input.eta ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      attachmentName: input.attachmentName ?? null,
      attachmentPathname: input.attachmentPathname ?? null,
      postedByRole: ctx.role,
      postedByClerkId: ctx.profile.clerkUserId,
    })
    .returning({ id: poTimeline.id });

  // Sync the PO's overall status when a phase value is provided. This
  // keeps the existing toolbar chips ("In Production", "Shipped") in lock-
  // step with the timeline's latest phase.
  if (input.phase && input.phase !== ctx.po.status) {
    const now = new Date();
    const set: Partial<typeof purchaseOrders.$inferInsert> = {
      status: input.phase,
      updatedAt: now,
    };
    if (input.phase === "acknowledged" && !ctx.po.acknowledgedAt) set.acknowledgedAt = now;
    if (input.phase === "shipped" && !ctx.po.shippedAt) set.shippedAt = now;
    if (input.phase === "received" && !ctx.po.receivedAt) set.receivedAt = now;
    await db.update(purchaseOrders).set(set).where(eq(purchaseOrders.id, input.poId));
  }

  // Notify the OTHER side so each party hears about updates without polling.
  const titleSummary = `${ctx.po.poNumber} · ${input.title}`;
  if (ctx.role === "supplier") {
    await notifyBuyerTeam({
      kind: "po.timeline-update",
      title: `📦 Update from ${ctx.po.supplierName}: ${input.title}`,
      body: input.note ?? input.phase ?? undefined,
      linkUrl: `/suppliers/po/${input.poId}`,
      poId: input.poId,
    });
  } else if (ctx.po.supplierId) {
    await notifySupplierUsers({
      supplierId: ctx.po.supplierId,
      kind: "po.timeline-update",
      title: `Update on PO ${titleSummary}`,
      body: input.note ?? input.phase ?? undefined,
      linkUrl: `/suppliers/po/${input.poId}`,
      poId: input.poId,
    });
  }
  revalidatePoPaths(input.poId);
  return { entryId: row.id };
}

export async function deletePoTimelineEntry(input: { entryId: number }): Promise<void> {
  const [entry] = await db
    .select()
    .from(poTimeline)
    .where(eq(poTimeline.id, input.entryId))
    .limit(1);
  if (!entry) throw new Error("Timeline entry not found");
  // Same authz as posting — either side can delete their own / buyer can delete any.
  await assertCanActAsSupplier(entry.poId);
  if (entry.attachmentUrl) {
    try { await del(entry.attachmentUrl); } catch (e) { console.warn("Blob del (timeline) failed", e); }
  }
  await db.delete(poTimeline).where(eq(poTimeline.id, input.entryId));
  revalidatePoPaths(entry.poId);
}
