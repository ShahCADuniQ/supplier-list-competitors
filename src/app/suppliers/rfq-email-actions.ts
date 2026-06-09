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
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
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
  route: RfqEmailDraftRoute;
};

export async function saveRfqEmailDraft(
  input: SaveRfqEmailDraftInput,
): Promise<{ id: number }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

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
        route: input.route,
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
      route: input.route,
      status: "draft",
      composedByClerkId: profile.clerkUserId,
    })
    .returning({ id: rfqEmailDrafts.id });

  revalidatePath("/suppliers");
  return { id: row.id };
}

// Submit a draft. If route === "direct_to_supplier" → sends now and marks
// as 'sent'. If route === "via_procurement" → marks as
// 'pending_procurement_review' and emails the procurement contact (Imen)
// a short heads-up with a link to the review page.
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
    return await deliverDraft(draft);
  }

  // Procurement route — mark pending and notify procurement.
  await db
    .update(rfqEmailDrafts)
    .set({
      status: "pending_procurement_review",
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, draft.id));

  // Notify procurement out of band so Imen knows there's something to
  // review. We send to the same transport (Resend) — a thin meta-email,
  // not the actual RFQ message. The actual RFQ goes out on approve.
  const baseAppUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const reviewUrl = `${baseAppUrl}/suppliers?procurement=${draft.id}`;
  try {
    await sendEmail({
      to: { email: PROCUREMENT_EMAIL, name: PROCUREMENT_NAME },
      replyTo: profile.email ?? undefined,
      subject: `[Review] RFQ email draft to ${draft.toEmail}`,
      text: [
        `${profile.displayName ?? profile.email ?? "A buyer"} drafted an RFQ email and routed it through procurement for review.`,
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
    // Logged but don't fail the submit — the draft is still queued for
    // review and Imen will see it in the dashboard either way.
    console.warn("[rfq-email] procurement notify failed:", e);
  }

  revalidatePath("/suppliers");
  return { sent: false, status: "pending_procurement_review" };
}

// Internal: actually send + flip status to 'sent'. Used by both the
// direct-send path and the procurement-approval path.
async function deliverDraft(
  draft: RfqEmailDraft,
): Promise<{ sent: boolean; status: string }> {
  // Compose the final body: bodyText + (optional) AI summary + magic
  // link block when the supplier is registered.
  const bodyParts: string[] = [draft.bodyText];
  if (draft.aiSummary && draft.aiSummary.trim()) {
    bodyParts.push("");
    bodyParts.push("— RFQ summary —");
    bodyParts.push(draft.aiSummary.trim());
  }
  if (draft.includeMagicLink && draft.recipientId != null) {
    const [recipient] = await db
      .select({ accessToken: rfqRecipients.accessToken })
      .from(rfqRecipients)
      .where(eq(rfqRecipients.id, draft.recipientId))
      .limit(1);
    if (recipient) {
      const baseAppUrl =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
      bodyParts.push("");
      bodyParts.push("Submit your quote here (no account needed):");
      bodyParts.push(`${baseAppUrl}/vendor/${recipient.accessToken}`);
    }
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

  await db
    .update(rfqEmailDrafts)
    .set({
      status: "sent",
      sentAt: new Date(),
      providerMessageId: result.id,
      updatedAt: new Date(),
    })
    .where(eq(rfqEmailDrafts.id, draft.id));
  revalidatePath("/suppliers");
  return { sent: result.sent, status: "sent" };
}

// ── Procurement review ──────────────────────────────────────────────────────

// Approve a pending draft — optionally with edits — and deliver.
export async function approveAndSendRfqEmailDraft(input: {
  draftId: number;
  finalSubject?: string;
  finalBody?: string;
  reviewerNotes?: string;
}): Promise<{ sent: boolean }> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();

  const [draft] = await db
    .select()
    .from(rfqEmailDrafts)
    .where(eq(rfqEmailDrafts.id, input.draftId))
    .limit(1);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "pending_procurement_review") {
    throw new Error("Draft is not awaiting review");
  }

  // Apply Imen's edits before sending.
  const subject = input.finalSubject?.trim() || draft.subject;
  const bodyText = input.finalBody ?? draft.bodyText;
  await db
    .update(rfqEmailDrafts)
    .set({
      subject,
      bodyText,
      status: "approved",
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
    status: "approved",
  };

  return await deliverDraft(updated);
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
