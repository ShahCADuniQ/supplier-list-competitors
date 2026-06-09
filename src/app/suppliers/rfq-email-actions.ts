"use server";

// Email lifecycle for the RFQ "send via email" + procurement-routed
// review feature. The buyer drafts an email tied to an RFQ recipient;
// they either send it direct to the supplier, or route it through
// procurement (currently imendo@lightbase.ca) for review. Procurement
// approves with optional edits → goes out; or rejects with a comment.
//
// Wraps src/lib/email/index.ts for the actual transport. When no
// RESEND_API_KEY is configured the transport logs to the console + saves
// the draft as "sent" with a dev message id so the workflow can be
// exercised without real email delivery.

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpNotifications,
  rfqEmailDrafts,
  rfqRecipients,
  rfqs,
  rfqItems,
  suppliers,
  userProfiles,
  type RfqEmailDraft,
} from "@/db/schema";
import { getOrCreateProfile, requireSupplierEditor } from "@/lib/permissions";
import { ensureOrdersSchema } from "./_ensure-orders-schema";
import { sendEmail, defaultFromAddress } from "@/lib/email";
import { claudeClient, CLAUDE_MODEL } from "@/lib/ai/claude";

// Configurable elsewhere via env, but defaults to Imen so the team
// doesn't have to set anything for the procurement route to work.
const PROCUREMENT_EMAIL =
  process.env.PROCUREMENT_EMAIL || "imendo@lightbase.ca";
const PROCUREMENT_NAME =
  process.env.PROCUREMENT_NAME || "Procurement (Imen)";

export type RfqEmailDraftRoute = "direct_to_supplier" | "via_procurement";

// In-app notification for the procurement reviewer (Imen/Itzel). Looks up
// the user profile whose email matches PROCUREMENT_EMAIL and inserts an
// erp_notifications row so their bell lights up.
async function notifyProcurementInApp(input: {
  title: string;
  body?: string;
  linkUrl?: string;
  rfqId?: number;
}): Promise<void> {
  try {
    const [profile] = await db
      .select({ clerkUserId: userProfiles.clerkUserId })
      .from(userProfiles)
      .where(sql`LOWER(${userProfiles.email}) = ${PROCUREMENT_EMAIL.toLowerCase()}`)
      .limit(1);
    if (!profile) return;
    await db.insert(erpNotifications).values({
      targetClerkId: profile.clerkUserId,
      kind: "rfq.sent",
      title: input.title,
      body: input.body ?? null,
      linkUrl: input.linkUrl ?? null,
      rfqId: input.rfqId ?? null,
    });
  } catch (e) {
    console.warn("[rfq-email] notifyProcurementInApp failed:", e);
  }
}

// In-app notification for the supplier. Mirrors the existing
// notifySupplier flow in rfq-actions.ts: find every user profile whose
// email matches a supplier_contacts row (or suppliers.email) and write a
// row to erp_notifications.
async function notifySupplierInApp(input: {
  supplierId: number;
  title: string;
  body?: string;
  linkUrl?: string;
  rfqId?: number;
}): Promise<void> {
  try {
    const emails = (await db.execute(sql`
      SELECT LOWER(email) AS email FROM suppliers
        WHERE id = ${input.supplierId} AND email IS NOT NULL
      UNION
      SELECT LOWER(email) AS email FROM supplier_contacts
        WHERE supplier_id = ${input.supplierId}
    `)) as unknown as { rows?: Array<{ email: string }> } | Array<{ email: string }>;
    const list = Array.isArray(emails)
      ? emails
      : Array.isArray(emails?.rows)
        ? emails.rows
        : [];
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
        kind: "rfq.sent" as const,
        title: input.title,
        body: input.body ?? null,
        linkUrl: input.linkUrl ?? null,
        rfqId: input.rfqId ?? null,
      })),
    );
  } catch (e) {
    console.warn("[rfq-email] notifySupplierInApp failed:", e);
  }
}

// ── Compose helpers ─────────────────────────────────────────────────────────

export type ComposeRfqEmailInput = {
  rfqId: number;
  // Either point at an existing recipient row, OR pass to_email / to_name
  // to address an ad-hoc supplier contact. Recipient row is preferred so
  // we can include the magic-link URL.
  recipientId?: number | null;
  toEmail: string;
  toName?: string | null;
};

// Build the default email body for a new draft. Uses the RFQ's number +
// project + line-item summary so the buyer doesn't have to retype it.
// Caller can still override the body before saving the draft.
export async function suggestRfqEmailBody(input: {
  rfqId: number;
  toName?: string | null;
  includeMagicLink: boolean;
  magicLinkUrl?: string | null;
}): Promise<{ subject: string; body: string }> {
  await ensureOrdersSchema();
  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  if (!rfq) throw new Error("RFQ not found");

  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, input.rfqId))
    .orderBy(rfqItems.lineNo);

  const subject = `RFQ ${rfq.rfqNumber}${rfq.projectName ? ` — ${rfq.projectName}` : ""}`;
  const lines: string[] = [];
  lines.push(`Hi ${input.toName?.trim() || "team"},`);
  lines.push("");
  lines.push(
    `We'd like to request a quote on the items below for ${rfq.projectName ? `project ${rfq.projectName} (${rfq.projectNum})` : `project ${rfq.projectNum}`}.`,
  );
  lines.push("");
  if (items.length > 0) {
    lines.push("Items:");
    for (const it of items) {
      const qtyPart = it.qty != null ? ` — qty ${it.qty}` : "";
      const codePart = it.productCode ? ` (P/N ${it.productCode})` : "";
      lines.push(
        `  ${it.lineNo}. ${it.description ?? "(no description)"}${qtyPart}${codePart}`,
      );
    }
    lines.push("");
  }
  if (rfq.quoteDeadline) {
    lines.push(
      `Please respond by ${new Date(rfq.quoteDeadline).toLocaleDateString()}.`,
    );
    lines.push("");
  }
  if (input.includeMagicLink && input.magicLinkUrl) {
    lines.push(
      `Submit your quote directly through our portal — no account needed:`,
    );
    lines.push(input.magicLinkUrl);
    lines.push("");
  }
  lines.push("Thanks,");

  return { subject, body: lines.join("\n") };
}

// Optional AI plain-language summary. Used when the recipient is NOT a
// registered supplier — gives them full context without expecting them
// to click into the portal.
export async function buildAiSummary(input: {
  rfqId: number;
}): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  await ensureOrdersSchema();
  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, input.rfqId))
    .limit(1);
  if (!rfq) return null;
  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, input.rfqId));

  const itemsBlob = items
    .map(
      (i) =>
        `- ${i.description ?? "(no description)"}${
          i.qty != null ? ` qty ${i.qty}` : ""
        }${i.productCode ? ` P/N ${i.productCode}` : ""}`,
    )
    .join("\n");

  const prompt = [
    "Summarize this RFQ in 3-5 short sentences for a supplier who does NOT have a dashboard login. Be polite and concrete. Do not include any login link or call-to-action — that's added separately.",
    "",
    `RFQ ${rfq.rfqNumber}`,
    `Project: ${rfq.projectName ?? rfq.projectNum}`,
    rfq.quoteDeadline
      ? `Quote due: ${new Date(rfq.quoteDeadline).toLocaleDateString()}`
      : "",
    "",
    "Items:",
    itemsBlob,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await claudeClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : null;
  } catch (e) {
    console.warn("[rfq-email] buildAiSummary failed:", e);
    return null;
  }
}

// ── CRUD: drafts ────────────────────────────────────────────────────────────

export type SaveRfqEmailDraftInput = {
  draftId?: number; // when set, update in place; else create
  rfqId: number;
  recipientId?: number | null;
  supplierId?: number | null;
  toEmail: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  aiSummary?: string | null;
  includeMagicLink?: boolean;
  // Delivery flags. Mutual exclusion is UI-enforced too: if ANY of the
  // procurement flags is true, BOTH supplier flags must be false (and
  // vice versa). Otherwise this would create a weird half-routed flow.
  deliverToSupplierEmail: boolean;
  deliverToSupplierPlatform: boolean;
  procurementViaEmail: boolean;
  procurementViaPlatform: boolean;
};

function validateDeliveryFlags(input: {
  deliverToSupplierEmail: boolean;
  deliverToSupplierPlatform: boolean;
  procurementViaEmail: boolean;
  procurementViaPlatform: boolean;
}): "direct_to_supplier" | "via_procurement" {
  const supplierPicked =
    input.deliverToSupplierEmail || input.deliverToSupplierPlatform;
  const procurementPicked =
    input.procurementViaEmail || input.procurementViaPlatform;
  if (!supplierPicked && !procurementPicked) {
    throw new Error(
      "Pick at least one delivery option: send to the supplier, or route through procurement.",
    );
  }
  if (supplierPicked && procurementPicked) {
    throw new Error(
      "Pick EITHER supplier delivery OR procurement routing — not both at once.",
    );
  }
  return procurementPicked ? "via_procurement" : "direct_to_supplier";
}

export async function saveRfqEmailDraft(
  input: SaveRfqEmailDraftInput,
): Promise<{ id: number }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  const route = validateDeliveryFlags(input);
  const replyTo = profile.email ?? null;

  if (input.draftId) {
    const [existing] = await db
      .select()
      .from(rfqEmailDrafts)
      .where(eq(rfqEmailDrafts.id, input.draftId))
      .limit(1);
    if (!existing) throw new Error("Draft not found");
    if (existing.status === "sent")
      throw new Error("Already sent; can't edit");
    await db
      .update(rfqEmailDrafts)
      .set({
        toEmail: input.toEmail.trim(),
        toName: input.toName?.trim() || null,
        subject: input.subject.trim(),
        bodyText: input.bodyText,
        aiSummary: input.aiSummary ?? null,
        includeMagicLink: input.includeMagicLink ?? true,
        route,
        deliverToSupplierEmail: input.deliverToSupplierEmail,
        deliverToSupplierPlatform: input.deliverToSupplierPlatform,
        procurementViaEmail: input.procurementViaEmail,
        procurementViaPlatform: input.procurementViaPlatform,
        replyToEmail: existing.replyToEmail ?? replyTo,
        updatedAt: new Date(),
      })
      .where(eq(rfqEmailDrafts.id, input.draftId));
    revalidatePath("/suppliers");
    return { id: input.draftId };
  }

  const [row] = await db
    .insert(rfqEmailDrafts)
    .values({
      rfqId: input.rfqId,
      recipientId: input.recipientId ?? null,
      supplierId: input.supplierId ?? null,
      toEmail: input.toEmail.trim(),
      toName: input.toName?.trim() || null,
      replyToEmail: replyTo,
      subject: input.subject.trim(),
      bodyText: input.bodyText,
      aiSummary: input.aiSummary ?? null,
      includeMagicLink: input.includeMagicLink ?? true,
      route,
      deliverToSupplierEmail: input.deliverToSupplierEmail,
      deliverToSupplierPlatform: input.deliverToSupplierPlatform,
      procurementViaEmail: input.procurementViaEmail,
      procurementViaPlatform: input.procurementViaPlatform,
      status: "draft",
      composedByClerkId: profile.clerkUserId,
    })
    .returning({ id: rfqEmailDrafts.id });

  revalidatePath("/suppliers");
  return { id: row.id };
}

// Submit a draft. If the draft is routed through procurement → mark
// pending and notify procurement per the procurement_via_* flags. If
// the draft is direct → deliver per the deliver_to_supplier_* flags.
export async function submitRfqEmailDraft(input: {
  draftId: number;
}): Promise<{ sent: boolean; status: string }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  const [draft] = await db
    .select()
    .from(rfqEmailDrafts)
    .where(eq(rfqEmailDrafts.id, input.draftId))
    .limit(1);
  if (!draft) throw new Error("Draft not found");
  if (draft.status === "sent")
    throw new Error("This draft has already been sent");

  if (draft.route === "direct_to_supplier") {
    return await deliverDraftToSupplier(draft);
  }

  // Procurement route — mark pending and notify procurement on the
  // selected channel(s). The actual RFQ goes to the supplier later, when
  // procurement approves.
  await db
    .update(rfqEmailDrafts)
    .set({
      status: "pending_procurement_review",
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, draft.id));

  const baseAppUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const reviewUrl = `${baseAppUrl}/suppliers?procurement=${draft.id}`;
  const composerName = profile.displayName ?? profile.email ?? "A buyer";

  if (draft.procurementViaEmail) {
    try {
      await sendEmail({
        to: { email: PROCUREMENT_EMAIL, name: PROCUREMENT_NAME },
        replyTo: profile.email ?? undefined,
        subject: `[Review] RFQ email draft to ${draft.toEmail}`,
        text: [
          `${composerName} drafted an RFQ email and routed it through procurement for review.`,
          "",
          `Recipient: ${draft.toEmail}`,
          `Subject:   ${draft.subject}`,
          "",
          `Review + approve / reject:`,
          reviewUrl,
          "",
          "— CADuniQ",
        ].join("\n"),
      });
    } catch (e) {
      console.warn("[rfq-email] procurement email notify failed:", e);
    }
  }
  if (draft.procurementViaPlatform) {
    await notifyProcurementInApp({
      title: `[Review] RFQ ${draft.subject}`,
      body: `${composerName} routed an RFQ email to you for review (recipient ${draft.toEmail}).`,
      linkUrl: reviewUrl,
      rfqId: draft.rfqId,
    });
  }

  revalidatePath("/suppliers");
  return { sent: false, status: "pending_procurement_review" };
}

// Internal: deliver a draft to the supplier and flip status to 'sent'.
// Dispatches to email and/or in-app notification per the
// deliver_to_supplier_* flags. Called by the direct-send submit path and
// by the procurement-approval path (after Imen edits + approves).
async function deliverDraftToSupplier(
  draft: RfqEmailDraft,
): Promise<{ sent: boolean; status: string }> {
  let providerMessageId: string | null = null;
  let actuallySent = false;

  // Compose the final email body: bodyText + (optional) AI summary +
  // magic link block when the recipient has a portal token.
  let recipientPortalUrl: string | null = null;
  if (draft.recipientId != null) {
    const [recipient] = await db
      .select({ accessToken: rfqRecipients.accessToken })
      .from(rfqRecipients)
      .where(eq(rfqRecipients.id, draft.recipientId))
      .limit(1);
    if (recipient) {
      const baseAppUrl =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
      recipientPortalUrl = `${baseAppUrl}/vendor/${recipient.accessToken}`;
    }
  }

  if (draft.deliverToSupplierEmail) {
    const bodyParts: string[] = [draft.bodyText];
    if (draft.aiSummary && draft.aiSummary.trim()) {
      bodyParts.push("");
      bodyParts.push("— RFQ summary —");
      bodyParts.push(draft.aiSummary.trim());
    }
    if (draft.includeMagicLink && recipientPortalUrl) {
      bodyParts.push("");
      bodyParts.push("Submit your quote here (no account needed):");
      bodyParts.push(recipientPortalUrl);
    }
    const result = await sendEmail({
      from: defaultFromAddress(),
      to: draft.toName
        ? { email: draft.toEmail, name: draft.toName }
        : draft.toEmail,
      replyTo: draft.replyToEmail ?? undefined,
      subject: draft.subject,
      text: bodyParts.join("\n"),
    });
    providerMessageId = result.id;
    actuallySent = actuallySent || result.sent;
  }

  if (draft.deliverToSupplierPlatform && draft.supplierId != null) {
    await notifySupplierInApp({
      supplierId: draft.supplierId,
      title: `New RFQ: ${draft.subject}`,
      body: draft.bodyText.slice(0, 200),
      linkUrl: recipientPortalUrl ?? "/portal",
      rfqId: draft.rfqId,
    });
    actuallySent = true;
  }

  await db
    .update(rfqEmailDrafts)
    .set({
      status: "sent",
      sentAt: new Date(),
      providerMessageId,
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, draft.id));
  revalidatePath("/suppliers");
  return { sent: actuallySent, status: "sent" };
}

// ── Procurement review ──────────────────────────────────────────────────────

// Approve a pending draft — optionally with edits — and deliver. Imen
// picks which channel(s) the supplier gets the RFQ on (email, the
// platform notification, or both). At least one is required.
export async function approveAndSendRfqEmailDraft(input: {
  draftId: number;
  finalSubject?: string;
  finalBody?: string;
  reviewerNotes?: string;
  deliverToSupplierEmail: boolean;
  deliverToSupplierPlatform: boolean;
}): Promise<{ sent: boolean }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  if (!input.deliverToSupplierEmail && !input.deliverToSupplierPlatform) {
    throw new Error(
      "Pick at least one delivery channel: email, platform notification, or both.",
    );
  }

  const [draft] = await db
    .select()
    .from(rfqEmailDrafts)
    .where(eq(rfqEmailDrafts.id, input.draftId))
    .limit(1);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "pending_procurement_review") {
    throw new Error("Draft is not awaiting review");
  }

  // Apply Imen's edits + the chosen delivery channels.
  const subject = input.finalSubject?.trim() || draft.subject;
  const bodyText = input.finalBody ?? draft.bodyText;
  await db
    .update(rfqEmailDrafts)
    .set({
      subject,
      bodyText,
      status: "approved",
      deliverToSupplierEmail: input.deliverToSupplierEmail,
      deliverToSupplierPlatform: input.deliverToSupplierPlatform,
      reviewedByClerkId: profile.clerkUserId,
      reviewedAt: new Date(),
      reviewerNotes: input.reviewerNotes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, draft.id));

  const updated: RfqEmailDraft = {
    ...draft,
    subject,
    bodyText,
    deliverToSupplierEmail: input.deliverToSupplierEmail,
    deliverToSupplierPlatform: input.deliverToSupplierPlatform,
    status: "approved",
  };

  return await deliverDraftToSupplier(updated);
}

// Reject a pending draft. The composer gets a notification (their bell)
// with the reviewer's comment so they can revise + resubmit.
export async function rejectRfqEmailDraft(input: {
  draftId: number;
  reviewerNotes: string;
}): Promise<void> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  const notes = input.reviewerNotes.trim();
  if (!notes) throw new Error("Reviewer notes are required to reject");

  await db
    .update(rfqEmailDrafts)
    .set({
      status: "rejected",
      reviewedByClerkId: profile.clerkUserId,
      reviewedAt: new Date(),
      reviewerNotes: notes,
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, input.draftId));
  revalidatePath("/suppliers");
}

// ── Listings ───────────────────────────────────────────────────────────────

export type PendingProcurementDraft = RfqEmailDraft & {
  rfqNumber: string;
  rfqProjectNum: string;
  rfqProjectName: string | null;
  composedByName: string | null;
};

export async function listPendingProcurementDrafts(): Promise<
  PendingProcurementDraft[]
> {
  await requireSupplierEditor();
  await ensureOrdersSchema();

  const rows = await db
    .select({
      draft: rfqEmailDrafts,
      rfqNumber: rfqs.rfqNumber,
      rfqProjectNum: rfqs.projectNum,
      rfqProjectName: rfqs.projectName,
    })
    .from(rfqEmailDrafts)
    .innerJoin(rfqs, eq(rfqs.id, rfqEmailDrafts.rfqId))
    .where(eq(rfqEmailDrafts.status, "pending_procurement_review"))
    .orderBy(desc(rfqEmailDrafts.composedAt));

  // Decorate with the composer's display name in a follow-up query — the
  // composedByClerkId column links to userProfiles. We do this in one
  // batched SELECT to keep latency low.
  const composerIds = Array.from(
    new Set(
      rows
        .map((r) => r.draft.composedByClerkId)
        .filter((s): s is string => !!s),
    ),
  );
  const composers =
    composerIds.length > 0
      ? await db
          .select({
            clerkUserId: userProfiles.clerkUserId,
            displayName: userProfiles.displayName,
            email: userProfiles.email,
          })
          .from(userProfiles)
          .where(inArray(userProfiles.clerkUserId, composerIds))
      : [];
  const nameByClerk = new Map(
    composers.map((c) => [c.clerkUserId, c.displayName ?? c.email] as const),
  );

  return rows.map((r) => ({
    ...r.draft,
    rfqNumber: r.rfqNumber,
    rfqProjectNum: r.rfqProjectNum,
    rfqProjectName: r.rfqProjectName,
    composedByName: r.draft.composedByClerkId
      ? nameByClerk.get(r.draft.composedByClerkId) ?? null
      : null,
  }));
}

export async function listRfqEmailDrafts(input: {
  rfqId: number;
}): Promise<RfqEmailDraft[]> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  return await db
    .select()
    .from(rfqEmailDrafts)
    .where(eq(rfqEmailDrafts.rfqId, input.rfqId))
    .orderBy(desc(rfqEmailDrafts.composedAt));
}

// Quick check: does this tenant have the email transport configured?
// Surfaced on the compose dialog so the user knows when their send is
// going to fall back to the console-log dev path.
export async function getEmailTransportStatus(): Promise<{
  configured: boolean;
  fromAddress: string;
}> {
  await getOrCreateProfile();
  return {
    configured: !!process.env.RESEND_API_KEY,
    fromAddress: defaultFromAddress(),
  };
}
