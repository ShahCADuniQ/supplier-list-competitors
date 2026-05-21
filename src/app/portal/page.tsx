import { redirect } from "next/navigation";
import { eq, sql, desc, and, or } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  purchaseOrders,
  rfqRecipients,
  rfqs,
  suppliers,
  supplierContacts,
  supplierQuotes,
  userProfiles,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  isSupplierUser,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { ensureSupplierColumns } from "@/app/suppliers/_ensure-schema";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";
import { ensureOnboardingSchema } from "@/app/suppliers/_ensure-onboarding-schema";
import { listSupplierOnboardingAttachments } from "@/app/suppliers/onboarding-actions";
import { supplierOnboardingSubmissions } from "@/db/schema";
import PortalView from "./PortalView";
import SupplierOnboardingForm, {
  type OnboardingPrefill,
  type ShopSummary,
} from "./SupplierOnboardingForm";

// Clerk-authenticated supplier dashboard. Renders the same UX as the
// magic-link /vendor/home/[token] page but identified by the signed-in
// user's email (matched against suppliers.email). This is the primary
// flow now — suppliers sign in to the same /sign-in URL as the team and
// land here automatically.

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Vendor Portal · ${CLIENT_CONFIG.name}`,
};

export default async function PortalPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  // Admins can browse the supplier portal for QA — handy for verifying
  // exactly what suppliers see. Internal employees who aren't admins are
  // bounced back to root (where they'd see the buyer dashboard).
  if (!isSupplierUser(profile) && !isAdmin(profile)) redirect("/");

  await ensureSupplierColumns();
  await ensureOrdersSchema();
  await ensureOnboardingSchema();

  // Find the supplier record matching this user's email. We try both the
  // suppliers.email column AND every supplier_contacts.email — many real
  // suppliers have multiple contacts, and the signed-in user may have
  // been invited via a non-primary contact email, so a strict suppliers.email
  // match would miss them.
  const profileEmailLc = (profile.email ?? "").toLowerCase();
  let supplier: typeof suppliers.$inferSelect | undefined;
  if (profileEmailLc) {
    [supplier] = await db
      .select()
      .from(suppliers)
      .where(sql`LOWER(${suppliers.email}) = ${profileEmailLc}`)
      .limit(1);
    if (!supplier) {
      const [contact] = await db
        .select({ supplierId: supplierContacts.supplierId })
        .from(supplierContacts)
        .where(sql`LOWER(${supplierContacts.email}) = ${profileEmailLc}`)
        .limit(1);
      if (contact) {
        [supplier] = await db
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, contact.supplierId))
          .limit(1);
      }
    }
  }
  if (!supplier) {
    // Their user_profiles row is still flagged isSupplier=true but the
    // supplier row they were linked to has been removed (admin deleted
    // it, or unmerged it, or the supplier's email was rotated off the
    // contact list). Instead of dead-ending here, bounce them through
    // the onboarding wizard so they can submit a fresh sign-up to a
    // retailer. The wizard at /onboarding has been taught to allow
    // re-entry when isSupplier is true but no matching supplier row
    // exists (see the existence check there) — otherwise we'd loop
    // back here. We pre-stamp pendingSignupRole='supplier' so a
    // refresh of /onboarding without the URL param still lands on the
    // supplier flow.
    if (isAdmin(profile)) {
      // Admins previewing a supplier with no row — keep the explanation
      // screen for QA, no redirect.
      return (
        <div
          style={{
            minHeight: "70vh",
            display: "grid",
            placeItems: "center",
            padding: 32,
            color: "var(--lb-text)",
            fontFamily: "system-ui",
          }}
        >
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>No supplier record</h1>
            <p style={{ color: "var(--lb-text-3)", fontSize: 13.5 }}>
              Your admin account has no associated supplier row to preview.
            </p>
          </div>
        </div>
      );
    }
    try {
      await db
        .update(userProfiles)
        .set({ pendingSignupRole: "supplier", updatedAt: new Date() })
        .where(eq(userProfiles.clerkUserId, profile.clerkUserId));
    } catch (e) {
      console.warn("[portal] failed to stamp pendingSignupRole:", e);
    }
    redirect("/onboarding?role=supplier&reason=unlinked");
  }

  // Gather every email tied to this supplier so an invite that went to ANY
  // contact (not just the primary suppliers.email) still shows up here.
  const contactRows = await db
    .select({ email: supplierContacts.email })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, supplier.id));
  const allEmails = new Set<string>();
  if (supplier.email) allEmails.add(supplier.email.toLowerCase());
  for (const c of contactRows) if (c.email) allEmails.add(c.email.toLowerCase());
  const emailList = Array.from(allEmails);

  // Pull every invite for this supplier — by FK link OR by email match
  // (covers RFQs sent by email before the supplier row was created).
  const rows = await db
    .select({ recipient: rfqRecipients, rfq: rfqs, quote: supplierQuotes })
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
      emailList.length > 0
        ? sql`${rfqRecipients.supplierId} = ${supplier.id} OR LOWER(${rfqRecipients.inviteEmail}) IN (${sql.join(
            emailList.map((e) => sql`${e}`),
            sql`, `,
          )})`
        : eq(rfqRecipients.supplierId, supplier.id),
    )
    .orderBy(desc(rfqRecipients.invitedAt));

  // Awarded POs for this supplier — every PO where supplier_id matches OR
  // the supplier name matches (covers legacy POs created before FKs were
  // back-filled) OR the PO is linked to an RFQ whose recipient was invited
  // by this contact's email (covers POs whose quote was created from a
  // recipient invited before the supplier_id back-fill).
  const poRows = await db
    .selectDistinct({ po: purchaseOrders })
    .from(purchaseOrders)
    .leftJoin(rfqRecipients, eq(rfqRecipients.rfqId, purchaseOrders.rfqId))
    .where(
      or(
        eq(purchaseOrders.supplierId, supplier.id),
        sql`LOWER(${purchaseOrders.supplierName}) = LOWER(${supplier.name})`,
        eq(rfqRecipients.supplierId, supplier.id),
        emailList.length > 0
          ? sql`LOWER(${rfqRecipients.inviteEmail}) IN (${sql.join(
              emailList.map((e) => sql`${e}`),
              sql`, `,
            )})`
          : sql`false`,
      ),
    )
    .orderBy(desc(purchaseOrders.createdAt));

  // ── ONBOARDING GATE ────────────────────────────────────────────────
  // Until the supplier's row is `approved`, the portal renders ONLY the
  // onboarding form / awaiting-review screen — no catalogue, no orders,
  // no chat. Admins viewing this page in QA-preview bypass the gate (so
  // they can verify what the supplier sees once approved).
  if (
    !isAdmin(profile) &&
    supplier.onboardingStatus !== "approved"
  ) {
    // Pull the most recent submission to pre-fill the form for resubmits
    // after a rejection (or for an in-progress save the supplier left).
    const [latestSubmission] = await db
      .select()
      .from(supplierOnboardingSubmissions)
      .where(eq(supplierOnboardingSubmissions.supplierId, supplier.id))
      .orderBy(desc(supplierOnboardingSubmissions.submittedAt))
      .limit(1);

    if (supplier.onboardingStatus === "submitted") {
      return (
        <div style={{ padding: 32, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui" }}>
          <div style={{
            padding: 22,
            borderRadius: 14,
            background: "linear-gradient(135deg, rgba(8,145,178,0.12), rgba(124,58,237,0.08))",
            border: "1px solid var(--lb-border)",
            marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
              {CLIENT_CONFIG.name} · Onboarding
            </div>
            <h1 style={{ fontSize: "clamp(22px, 2.6vw, 28px)", fontWeight: 800, margin: "6px 0 4px", letterSpacing: "-0.02em" }}>
              Thanks, {supplier.name} — we're reviewing your submission.
            </h1>
            <p style={{ fontSize: 13.5, color: "var(--lb-text-2)", marginTop: 10 }}>
              Your checklist and company info are with the {CLIENT_CONFIG.name} team.
              You'll get an email at <strong>{supplier.email ?? "your registered address"}</strong> as
              soon as you're approved — usually within one business day.
            </p>
            {latestSubmission?.submittedAt && (
              <p style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 10 }}>
                Submitted {new Date(latestSubmission.submittedAt).toLocaleString()}.
              </p>
            )}
          </div>
        </div>
      );
    }

    // status === 'pending' OR 'rejected' → render the compliance form.
    // Step 2 only takes compliance answers + notes, so the prefill blob
    // we look up here is narrow on purpose. Source precedence:
    //   1. Auto-saved draft on the supplier row (if they bailed mid-flow)
    //   2. Most recent SUBMITTED blob (resubmit-after-rejection flow)
    // The draft wins so a supplier who edited after a previous
    // rejection doesn't lose their newer answers.
    const draftBlob = (supplier.onboardingDraft ?? {}) as OnboardingPrefill;
    const submissionBlob = (latestSubmission?.formData ?? {}) as OnboardingPrefill;
    const prefillFromSubmission: OnboardingPrefill =
      supplier.onboardingDraft &&
      Object.keys(draftBlob as Record<string, unknown>).length > 0
        ? draftBlob
        : submissionBlob;

    // Read-only shop summary for step 2 (toggleable to an editor by the
    // supplier). Every field comes straight off the suppliers row
    // (written by claimSupplier at step 1). `invitingClientName` is
    // resolved from suppliers.clientId so the supplier sees who they
    // applied to and can retarget if needed before submit.
    let invitingClientName: string | null = null;
    if (supplier.clientId) {
      const [c] = await db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, supplier.clientId))
        .limit(1);
      invitingClientName = c?.name ?? null;
    }

    const shopSummary: ShopSummary = {
      companyName: supplier.name,
      contactName: supplier.contactName ?? null,
      email: supplier.email ?? null,
      phone: supplier.phone ?? null,
      website: supplier.website ?? null,
      category: supplier.category ?? null,
      subCategory: supplier.subCategory ?? null,
      origin: supplier.origin ?? null,
      products: supplier.products ?? null,
      manufacturingTypes: Array.isArray(supplier.manufacturingTypes)
        ? (supplier.manufacturingTypes as string[])
        : [],
      materials: Array.isArray(supplier.materials)
        ? (supplier.materials as string[])
        : [],
      isDistributor: Boolean(supplier.isDistributor),
      invitingClientName,
    };

    // Pull the supplier's existing attachments so step 2 can show
    // counts + existing files per category without each category
    // mounting its own loading state.
    const onboardingAttachments = await listSupplierOnboardingAttachments({
      supplierId: supplier.id,
    });

    return (
      <div style={{ padding: 32, background: "var(--lb-bg)", minHeight: "100vh" }}>
        <SupplierOnboardingForm
          clientName={CLIENT_CONFIG.name}
          supplierId={supplier.id}
          supplierName={supplier.name}
          shopSummary={shopSummary}
          prefill={prefillFromSubmission}
          rejectionReason={
            supplier.onboardingStatus === "rejected"
              ? supplier.onboardingReviewerNotes ?? null
              : null
          }
          existingAttachments={onboardingAttachments}
        />
      </div>
    );
  }

  // Approved-supplier portal data: load the supplier's existing
  // attachments for the "About us" tab + resolve the inviting retailer's
  // name once for the same tab.
  const approvedAttachments = await listSupplierOnboardingAttachments({
    supplierId: supplier.id,
  });
  let approvedInvitingName: string | null = null;
  if (supplier.clientId) {
    const [c] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, supplier.clientId))
      .limit(1);
    approvedInvitingName = c?.name ?? null;
  }

  return (
    <PortalView
      clientName={CLIENT_CONFIG.name}
      supplier={{
        id: supplier.id,
        name: supplier.name,
        email: supplier.email,
        contactName: supplier.contactName,
        logoUrl: supplier.logoUrl ?? null,
        logoName: supplier.logoName ?? null,
      }}
      aboutUs={{
        companyName: supplier.name,
        contactName: supplier.contactName ?? null,
        email: supplier.email ?? null,
        phone: supplier.phone ?? null,
        website: supplier.website ?? null,
        category: supplier.category ?? null,
        subCategory: supplier.subCategory ?? null,
        origin: supplier.origin ?? null,
        products: supplier.products ?? null,
        invitingClientName: approvedInvitingName,
      }}
      aboutUsAttachments={approvedAttachments}
      invites={rows.map((r) => ({
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
        quoteStatus: r.quote?.status ?? null,
      }))}
      pos={poRows.map(({ po: p }) => ({
        id: p.id,
        poNumber: p.poNumber,
        projectNum: p.projectNum,
        projectName: p.projectName,
        currency: p.currency,
        totalAmount: Number(p.totalAmount),
        status: p.status,
        createdAt: p.createdAt,
      }))}
      isAdminPreview={!isSupplierUser(profile) && isAdmin(profile)}
    />
  );
}
