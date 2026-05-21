"use server";

// Supplier onboarding workflow — checklist submission, admin review,
// approve / reject. Suppliers can only access the catalog / orders / chat
// AFTER an admin has approved their submission.

import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { isCanonicalCatId } from "./supplier-attachment-categories";
import {
  erpNotifications,
  suppliers,
  supplierAttachments,
  supplierContacts,
  supplierOnboardingSubmissions,
  supplierTaxonomyTerms,
  userProfiles,
  type Supplier,
  type SupplierOnboardingSubmission,
} from "@/db/schema";
import { auth } from "@clerk/nextjs/server";
import {
  requireSupplierAccess,
  requireSupplierEditor,
} from "@/lib/permissions";
import { ensureOnboardingSchema } from "./_ensure-onboarding-schema";
import { ensureSupplierColumns } from "./_ensure-schema";

// What the supplier portal asks step-2 for. Step 2 is the compliance
// checklist only: it captures regulatory answers + a free-text notes
// field, nothing else. All the shop-side facts (company name, contact,
// capability, materials, manufacturing processes, etc.) were collected
// in step 1 at /onboarding and live on the suppliers row already, so
// this shape stays narrow on purpose — no duplicate questions across
// the two screens.
//
// The blob is stored as-is on supplier_onboarding_submissions.form_data
// so we can extend it later without a migration; the admin's pending
// queue reads from the suppliers row, not from this blob.
export type SupplierOnboardingFormData = {
  answers?: Record<string, "yes" | "no" | "na">;
  notes?: string;
};

export type SupplierOnboardingState = {
  status: Supplier["onboardingStatus"];
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewerNotes: string | null;
  // Most recent submission's form data (so the supplier can edit + resubmit
  // after a rejection, and the admin can read what they filled in).
  latestSubmission: SupplierOnboardingSubmission | null;
};

// READ — supplier-self or admin. Returns the current gate state for one
// supplier, including the last submission so the form can pre-fill.
export async function getSupplierOnboardingState(input: {
  supplierId: number;
}): Promise<SupplierOnboardingState> {
  await requireSupplierAccess(input.supplierId);
  await ensureOnboardingSchema();

  const [row] = await db
    .select({
      onboardingStatus: suppliers.onboardingStatus,
      onboardingSubmittedAt: suppliers.onboardingSubmittedAt,
      onboardingReviewedAt: suppliers.onboardingReviewedAt,
      onboardingReviewerNotes: suppliers.onboardingReviewerNotes,
    })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);

  const [latest] = await db
    .select()
    .from(supplierOnboardingSubmissions)
    .where(eq(supplierOnboardingSubmissions.supplierId, input.supplierId))
    .orderBy(desc(supplierOnboardingSubmissions.submittedAt))
    .limit(1);

  return {
    status: row?.onboardingStatus ?? "approved",
    submittedAt: row?.onboardingSubmittedAt ?? null,
    reviewedAt: row?.onboardingReviewedAt ?? null,
    reviewerNotes: row?.onboardingReviewerNotes ?? null,
    latestSubmission: latest ?? null,
  };
}

// DRAFT — supplier-self only. Writes the in-progress form blob to the
// supplier row so the supplier can sign out mid-flow and resume later
// without losing their answers. Distinct from submit: no submission row
// is created, the admin queue is NOT triggered, status stays 'pending'.
// Cleared by submitSupplierOnboarding once they actually file.
export async function saveSupplierOnboardingDraft(input: {
  supplierId: number;
  formData: SupplierOnboardingFormData;
}): Promise<{ savedAt: Date }> {
  await requireSupplierAccess(input.supplierId);
  await ensureOnboardingSchema();
  const now = new Date();
  await db
    .update(suppliers)
    .set({
      onboardingDraft: input.formData as Record<string, unknown>,
      onboardingDraftUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.supplierId));
  return { savedAt: now };
}

// EDIT SHOP INFO — supplier-self only. Lets the supplier amend the
// step-1 facts (company, contact, capability, materials, products,
// manufacturing processes, country) AND swap the engineering company
// they applied to (by entering a different engineering email). Allowed
// only while onboarding_status is 'pending' or 'rejected'; once they
// hit submit on step 2 the row is locked for editing. The admin can
// always edit from /admin via the existing supplier editor.
export async function updateSupplierShopInfo(input: {
  supplierId: number;
  companyName: string;
  contactName?: string | null;
  phone?: string | null;
  website?: string | null;
  category?: string | null;
  subCategory?: string | null;
  origin?: string | null;
  products?: string | null;
  manufacturingTypes?: string[];
  materials?: string[];
  // Distributor flag. When true the supplier explicitly identifies as
  // buy-and-sell only; we store the boolean and the manufacturing /
  // materials arrays are kept empty regardless of what was passed.
  isDistributor?: boolean;
  // Optional re-targeting: if the supplier wants to apply to a
  // different engineering company than the one they originally picked.
  // Pass undefined to leave it alone; pass a string to re-validate
  // against the clients table and re-scope the supplier row.
  newEngineeringCompanyEmail?: string;
}): Promise<{ updatedAt: Date }> {
  await requireSupplierAccess(input.supplierId);
  await ensureSupplierColumns();
  await ensureOnboardingSchema();

  // Lock check: only block self-edits while the row is "submitted"
  // (under review). The supplier can edit before submitting (pending,
  // rejected) AND after they've been approved — the post-approval edits
  // come from the "About Us" tab on the portal, where the supplier
  // keeps their company info / files up to date over time.
  const [current] = await db
    .select({ status: suppliers.onboardingStatus })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!current) throw new Error("Supplier not found");
  if (current.status === "submitted") {
    throw new Error(
      "Your application is under review. The reviewer needs to send it back before you can edit it again.",
    );
  }

  if (!input.companyName.trim()) {
    throw new Error("Company name is required");
  }

  // If the supplier wants to retarget to a different engineering
  // company, validate the new email against an existing client tenant
  // BEFORE we mutate anything. Otherwise we keep the existing clientId.
  let nextClientId: number | undefined;
  if (input.newEngineeringCompanyEmail !== undefined) {
    const wantedEmail = input.newEngineeringCompanyEmail.trim().toLowerCase();
    if (!wantedEmail) {
      throw new Error("Engineering company email is required");
    }
    const [match] = await db
      .select({ clientId: userProfiles.clientId })
      .from(userProfiles)
      .where(
        and(
          sql`LOWER(${userProfiles.email}) = ${wantedEmail}`,
          sql`${userProfiles.clientId} IS NOT NULL`,
        ),
      )
      .limit(1);
    if (!match?.clientId) {
      throw new Error(
        `We couldn't find an Engineering/Designer Company on CADuniQ with the email "${input.newEngineeringCompanyEmail.trim()}". Double-check the spelling or try a different address.`,
      );
    }
    nextClientId = match.clientId;
  }

  // Only touch the manufacturing/materials/distributor columns if the
  // caller explicitly passed them in. Step 2's editor doesn't surface
  // those fields anymore (they're a step-1 question), so omitting them
  // here preserves whatever the supplier picked at signup instead of
  // clearing it. When isDistributor IS passed and true, both arrays
  // get wiped so the reviewer sees a clean distributor signal.
  const distributorPassed = input.isDistributor !== undefined;
  const distributor = Boolean(input.isDistributor);
  const manufacturingTypesPassed = input.manufacturingTypes !== undefined;
  const materialsPassed = input.materials !== undefined;
  const manufacturingTypes = distributorPassed && distributor
    ? []
    : manufacturingTypesPassed
      ? (input.manufacturingTypes ?? []).map((s) => s.trim()).filter(Boolean)
      : undefined;
  const materials = distributorPassed && distributor
    ? []
    : materialsPassed
      ? (input.materials ?? []).map((s) => s.trim()).filter(Boolean)
      : undefined;

  const now = new Date();
  await db
    .update(suppliers)
    .set({
      name: input.companyName.trim(),
      contactName: input.contactName?.trim() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      category: input.category?.trim() || null,
      subCategory: input.subCategory?.trim() || null,
      origin: input.origin?.trim() || null,
      products: input.products?.trim() || null,
      ...(manufacturingTypes !== undefined ? { manufacturingTypes } : {}),
      ...(materials !== undefined ? { materials } : {}),
      ...(distributorPassed ? { isDistributor: distributor } : {}),
      ...(nextClientId !== undefined ? { clientId: nextClientId } : {}),
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.supplierId));

  revalidatePath("/portal");
  revalidatePath("/admin");
  return { updatedAt: now };
}

// Fan a notification out to every staff user on the engineering
// tenant the supplier belongs to. Mirrors notifyTeam() in rfq-actions
// but scopes by clientId so a Lightbase admin doesn't see Acme's
// supplier signups (and vice versa). Best-effort: never throws —
// notification failure shouldn't break the supplier action that
// triggered it.
async function notifyTenantTeam(input: {
  clientId: number | null;
  kind: "supplier.signed-up" | "supplier.status-update";
  title: string;
  body?: string;
  linkUrl?: string;
}): Promise<void> {
  try {
    if (input.clientId == null) return;
    const team = await db
      .select({ id: userProfiles.clerkUserId })
      .from(userProfiles)
      .where(sql`
        ${userProfiles.clientId} = ${input.clientId}
        AND ${userProfiles.isSupplier} = false
        AND ${userProfiles.isRetailer} = false
        AND (
          ${userProfiles.role} = 'admin'
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
      })),
    );
  } catch (e) {
    console.warn("[onboarding] notifyTenantTeam failed:", e);
  }
}

// SUBMIT — supplier-self only path. Saves the form, mirrors the headline
// fields onto the suppliers row (so the admin sees them where they
// expect — category, origin, contact, etc.), and flips the status to
// 'submitted' so the admin's pending queue picks it up.
export async function submitSupplierOnboarding(input: {
  supplierId: number;
  formData: SupplierOnboardingFormData;
  score?: number;
  scoreMax?: number;
  verdict?: "pre-qualified" | "conditional" | "not-qualified";
}): Promise<{ submissionId: number }> {
  const { profile } = await requireSupplierAccess(input.supplierId);
  await ensureOnboardingSchema();

  const now = new Date();
  const [submission] = await db
    .insert(supplierOnboardingSubmissions)
    .values({
      supplierId: input.supplierId,
      formData: input.formData,
      score: input.score ?? null,
      scoreMax: input.scoreMax ?? null,
      verdict: input.verdict ?? null,
      submittedAt: now,
      submittedByClerkId: profile.clerkUserId,
    })
    .returning({ id: supplierOnboardingSubmissions.id });

  // Mirror the headline fields onto the suppliers row so the admin's
  // existing UI (which renders from `suppliers`, not from the submission
  // blob) shows the supplier's self-reported data.
  // Step-2 submit doesn't touch any shop-side fields anymore — those
  // were written by claimSupplier at step 1. We only flip the status,
  // clear any previous reviewer decision, and wipe the in-progress
  // draft (the submission row is the authoritative copy from now on).
  const patch: Partial<typeof suppliers.$inferInsert> = {
    onboardingStatus: "submitted",
    onboardingSubmittedAt: now,
    onboardingReviewedAt: null,
    onboardingReviewedByClerkId: null,
    onboardingReviewerNotes: null,
    onboardingDraft: null,
    onboardingDraftUpdatedAt: null,
    updatedAt: now,
  };

  await db.update(suppliers).set(patch).where(eq(suppliers.id, input.supplierId));

  // Notify the tenant's review team — this is the moment the queue
  // lights up. Look up the supplier's name + clientId in one shot.
  const [supRow] = await db
    .select({ name: suppliers.name, clientId: suppliers.clientId })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (supRow) {
    await notifyTenantTeam({
      clientId: supRow.clientId ?? null,
      kind: "supplier.status-update",
      title: `${supRow.name} submitted their compliance checklist`,
      body: "Ready for review on the suppliers admin queue.",
      linkUrl: "/admin",
    });
  }

  revalidatePath("/portal");
  revalidatePath("/suppliers");
  return { submissionId: submission.id };
}

// APPROVE — admin-only. Flips the status to 'approved' so the supplier
// portal opens the catalog / orders / chat tabs.
export async function approveSupplierOnboarding(input: {
  supplierId: number;
  notes?: string;
}): Promise<void> {
  const profile = await requireSupplierEditor();
  await ensureOnboardingSchema();
  const now = new Date();
  await db
    .update(suppliers)
    .set({
      onboardingStatus: "approved",
      onboardingReviewedAt: now,
      onboardingReviewedByClerkId: profile.clerkUserId,
      onboardingReviewerNotes: input.notes?.trim() || null,
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/portal");
  revalidatePath("/suppliers");
}

// REJECT — admin-only. Sends the supplier back to fix things; their
// portal will show the rejection reason and the form pre-filled for
// resubmission.
export async function rejectSupplierOnboarding(input: {
  supplierId: number;
  notes: string;
}): Promise<void> {
  const profile = await requireSupplierEditor();
  await ensureOnboardingSchema();
  if (!input.notes.trim()) throw new Error("Rejection note is required");
  const now = new Date();
  await db
    .update(suppliers)
    .set({
      onboardingStatus: "rejected",
      onboardingReviewedAt: now,
      onboardingReviewedByClerkId: profile.clerkUserId,
      onboardingReviewerNotes: input.notes.trim(),
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/portal");
  revalidatePath("/suppliers");
}

// LIST PENDING — admin-only. Surfaces every supplier whose submission
// is waiting for review (status = 'submitted'). Used by the suppliers
// tab to show a "Review queue" banner.
export type PendingSupplier = {
  id: number;
  name: string;
  email: string | null;
  contactName: string | null;
  category: string | null;
  origin: string | null;
  submittedAt: Date | null;
  score: number | null;
  scoreMax: number | null;
  verdict: string | null;
};
export async function listPendingOnboardingSuppliers(): Promise<PendingSupplier[]> {
  await requireSupplierEditor();
  await ensureOnboardingSchema();
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      contactName: suppliers.contactName,
      category: suppliers.category,
      origin: suppliers.origin,
      submittedAt: suppliers.onboardingSubmittedAt,
    })
    .from(suppliers)
    .where(eq(suppliers.onboardingStatus, "submitted"))
    .orderBy(desc(suppliers.onboardingSubmittedAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const submissions = await db
    .select({
      supplierId: supplierOnboardingSubmissions.supplierId,
      score: supplierOnboardingSubmissions.score,
      scoreMax: supplierOnboardingSubmissions.scoreMax,
      verdict: supplierOnboardingSubmissions.verdict,
      submittedAt: supplierOnboardingSubmissions.submittedAt,
    })
    .from(supplierOnboardingSubmissions)
    .orderBy(desc(supplierOnboardingSubmissions.submittedAt));
  const latestBySupplier = new Map<number, (typeof submissions)[number]>();
  for (const s of submissions) {
    if (!ids.includes(s.supplierId)) continue;
    if (!latestBySupplier.has(s.supplierId)) latestBySupplier.set(s.supplierId, s);
  }
  return rows.map((r) => {
    const sub = latestBySupplier.get(r.id);
    return {
      ...r,
      score: sub?.score ?? null,
      scoreMax: sub?.scoreMax ?? null,
      verdict: sub?.verdict ?? null,
    };
  });
}


// ─────────────────────────────────────────────────────────────────────
// SHARED TAXONOMY (manufacturing capabilities + materials)
//
// Append-only catalog of free-text terms suppliers add during
// onboarding. The constants in supplier-inventory-constants.ts are the
// curated baseline; this table extends them so when supplier #2 signs
// up they see the custom entries supplier #1 added. Both helpers stay
// auth-gated (any signed-in user can read, any signed-in user can
// add). We do not allow deletion from the UI — the admin can prune
// from a SQL console if a typo ever needs cleaning up.
// ─────────────────────────────────────────────────────────────────────

export type SupplierTaxonomyKind = "manufacturing" | "material";

export async function listSupplierTaxonomyTerms(): Promise<{
  manufacturing: string[];
  material: string[];
}> {
  const { userId } = await auth();
  if (!userId) return { manufacturing: [], material: [] };
  await ensureOnboardingSchema();
  const rows = await db
    .select({
      kind: supplierTaxonomyTerms.kind,
      value: supplierTaxonomyTerms.value,
    })
    .from(supplierTaxonomyTerms)
    .orderBy(asc(supplierTaxonomyTerms.value));
  const manufacturing: string[] = [];
  const material: string[] = [];
  for (const r of rows) {
    if (r.kind === "manufacturing") manufacturing.push(r.value);
    else if (r.kind === "material") material.push(r.value);
  }
  return { manufacturing, material };
}

export async function addSupplierTaxonomyTerm(input: {
  kind: SupplierTaxonomyKind;
  value: string;
}): Promise<{ value: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Sign in first");
  if (input.kind !== "manufacturing" && input.kind !== "material") {
    throw new Error("Unknown taxonomy kind");
  }
  const value = input.value.trim();
  if (!value) throw new Error("Empty value");
  if (value.length > 80) {
    throw new Error("Keep custom entries under 80 characters.");
  }
  await ensureOnboardingSchema();

  // Case-insensitive dedupe: if a term with the same lowercased value
  // already exists for this kind, return the existing one and do not
  // insert a duplicate. The unique index on (kind, value) would block
  // exact dupes; this catches case variants ("aluminum" vs "Aluminum").
  const [existing] = await db
    .select({ value: supplierTaxonomyTerms.value })
    .from(supplierTaxonomyTerms)
    .where(
      and(
        eq(supplierTaxonomyTerms.kind, input.kind),
        sql`LOWER(${supplierTaxonomyTerms.value}) = ${value.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (existing) return { value: existing.value };

  await db
    .insert(supplierTaxonomyTerms)
    .values({ kind: input.kind, value })
    .onConflictDoNothing();
  return { value };
}


// ─────────────────────────────────────────────────────────────────────
// ONBOARDING ATTACHMENTS (supplier-self)
//
// Mirrors the existing addSupplierAttachment / deleteSupplierAttachment
// actions in src/app/suppliers/actions.ts but uses requireSupplierAccess
// instead of requireSupplierEditor — so the signed-in supplier can
// upload supporting docs (datasheets, certifications, NDAs, etc.)
// straight from the step-2 onboarding form without needing a Lightbase
// admin to do it for them. The Lightbase admin still has full access
// via the regular AttachmentsTab.
//
// Uploads go through /api/blob/upload, which already permits supplier-
// self uploads under suppliers/<id>/* (see onBeforeGenerateToken in
// that route's handler).
// ─────────────────────────────────────────────────────────────────────

export type OnboardingAttachmentRow = {
  id: number;
  catId: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  url: string | null;
  createdAt: Date | null;
  uploader: string | null;
};

export async function listSupplierOnboardingAttachments(input: {
  supplierId: number;
}): Promise<OnboardingAttachmentRow[]> {
  await requireSupplierAccess(input.supplierId);
  const rows = await db
    .select({
      id: supplierAttachments.id,
      catId: supplierAttachments.catId,
      name: supplierAttachments.name,
      size: supplierAttachments.size,
      mimeType: supplierAttachments.mimeType,
      url: supplierAttachments.url,
      createdAt: supplierAttachments.createdAt,
      uploader: supplierAttachments.uploader,
    })
    .from(supplierAttachments)
    .where(eq(supplierAttachments.supplierId, input.supplierId))
    .orderBy(desc(supplierAttachments.createdAt));
  return rows;
}

export async function addSupplierOnboardingAttachment(input: {
  supplierId: number;
  catId: string;
  name: string;
  size: number;
  mimeType?: string | null;
  url: string;
  blobPathname: string;
}): Promise<{ id: number }> {
  const { profile } = await requireSupplierAccess(input.supplierId);
  const name = (input.name ?? "").trim();
  const catId = (input.catId ?? "").trim();
  const url = (input.url ?? "").trim();
  const blobPathname = (input.blobPathname ?? "").trim();
  if (!name || !catId || !url || !blobPathname) {
    throw new Error("Attachment name, category, and uploaded URL are required");
  }
  const [row] = await db
    .insert(supplierAttachments)
    .values({
      supplierId: input.supplierId,
      catId,
      name,
      size: input.size,
      mimeType: (input.mimeType ?? "").trim() || null,
      url,
      blobPathname,
      uploader: profile.displayName ?? profile.email,
      uploaderClerkId: profile.clerkUserId,
      date: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: supplierAttachments.id });
  revalidatePath("/portal");
  revalidatePath("/suppliers");
  return { id: row.id };
}

export async function deleteSupplierOnboardingAttachment(input: {
  supplierId: number;
  attachmentId: number;
}): Promise<void> {
  await requireSupplierAccess(input.supplierId);
  // Cross-check that the attachment actually belongs to the supplier
  // the caller has access to — otherwise a supplier could pass a stray
  // id to delete someone else's file.
  const [row] = await db
    .select({
      id: supplierAttachments.id,
      supplierId: supplierAttachments.supplierId,
    })
    .from(supplierAttachments)
    .where(eq(supplierAttachments.id, input.attachmentId))
    .limit(1);
  if (!row || row.supplierId !== input.supplierId) {
    throw new Error("Attachment not found");
  }
  await db
    .delete(supplierAttachments)
    .where(eq(supplierAttachments.id, input.attachmentId));
  revalidatePath("/portal");
  revalidatePath("/suppliers");
}

// Supplier-self bulk delete of every file in a custom section. Default
// sections are rejected server-side. Mirrors the admin's
// deleteSupplierCustomSection but goes through requireSupplierAccess so
// a signed-in supplier can clean up their own portal without admin help.
export async function deleteSupplierOnboardingCustomSection(input: {
  supplierId: number;
  catId: string;
}): Promise<{ deleted: number }> {
  await requireSupplierAccess(input.supplierId);
  const catId = input.catId.trim();
  if (!catId) throw new Error("Section is required");
  if (isCanonicalCatId(catId)) {
    throw new Error("Default sections can't be deleted.");
  }
  const rows = await db
    .select({
      id: supplierAttachments.id,
      url: supplierAttachments.url,
      blobPathname: supplierAttachments.blobPathname,
    })
    .from(supplierAttachments)
    .where(
      and(
        eq(supplierAttachments.supplierId, input.supplierId),
        eq(supplierAttachments.catId, catId),
      ),
    );
  for (const r of rows) {
    if (r.blobPathname) {
      try { await del(r.url); } catch (e) {
        console.warn("Blob cleanup failed", r.blobPathname, e);
      }
    }
  }
  await db
    .delete(supplierAttachments)
    .where(
      and(
        eq(supplierAttachments.supplierId, input.supplierId),
        eq(supplierAttachments.catId, catId),
      ),
    );
  revalidatePath("/portal");
  revalidatePath("/suppliers");
  return { deleted: rows.length };
}


// ─────────────────────────────────────────────────────────────────────
// DUPLICATE DETECTION + MERGE-AND-APPROVE
//
// When a new supplier signs up at /onboarding we land a fresh row with
// onboarding_status='pending'. Most engineering tenants already track
// hundreds of suppliers in their directory, and there's a decent chance
// the new sign-up is one of them (sales rep filling out the wizard for
// a shop the engineering company already buys from). To prevent the
// reviewer from approving a duplicate by accident we surface "potential
// matches" inline on the review queue and let them approve-and-merge
// into the existing supplier in one click — or pick a different
// supplier from the same tenant's directory if the auto-suggestion is
// wrong.
//
// Match scoring (JS-side, after fetching same-tenant candidates):
//   • exact email (suppliers.email or any supplier_contacts.email)  +100
//   • email domain match                                             +30
//   • website host match (after stripping protocol/www)              +60
//   • normalised name exact                                          +80
//   • normalised name token Jaccard >= 0.7                           +50
//   • normalised name token Jaccard >= 0.4                           +20
// Candidates with combined score < 40 are dropped. Top 5 returned.
// ─────────────────────────────────────────────────────────────────────

function normaliseName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[.,'"()\-_/\\]/g, " ")
    .replace(/\b(inc|inc\.|incorporated|llc|ltd|limited|co|company|corp|corporation|gmbh|sa|srl|bv|oy|pty|plc|s\.a\.|s\.r\.l\.)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(raw: string | null | undefined): Set<string> {
  const n = normaliseName(raw);
  if (!n) return new Set();
  return new Set(n.split(" ").filter((t) => t.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function websiteHost(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  const host = cleaned.split(/[/?#]/)[0] || "";
  return host.replace(/^www\./, "");
}

function emailDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  const at = raw.indexOf("@");
  if (at < 0) return "";
  return raw.slice(at + 1).trim().toLowerCase();
}

export type SupplierMatchCandidate = {
  id: number;
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  website: string | null;
  origin: string | null;
  score: number;
  // Human-readable reasons, e.g. ["Email matches", "Same website domain"].
  reasons: string[];
};

export async function listPotentialSupplierMatches(input: {
  supplierId: number;
}): Promise<SupplierMatchCandidate[]> {
  await requireSupplierEditor();
  await ensureOnboardingSchema();

  // Pending supplier under review.
  const [pending] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      website: suppliers.website,
      clientId: suppliers.clientId,
    })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!pending) return [];
  if (pending.clientId == null) return [];

  // Existing approved suppliers in the same tenant (the directory the
  // reviewer would otherwise have to manually scan).
  const candidates = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      category: suppliers.category,
      contactName: suppliers.contactName,
      email: suppliers.email,
      website: suppliers.website,
      origin: suppliers.origin,
    })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.clientId, pending.clientId),
        sql`${suppliers.id} <> ${pending.id}`,
        eq(suppliers.onboardingStatus, "approved"),
      ),
    );
  if (candidates.length === 0) return [];

  // Pull every contact email for those candidates in one shot so the
  // email-match signal works even when the pending sign-up's email
  // points at a non-primary contact on the existing supplier row.
  const ids = candidates.map((c) => c.id);
  const contactRows = ids.length
    ? await db
        .select({
          supplierId: supplierContacts.supplierId,
          email: supplierContacts.email,
        })
        .from(supplierContacts)
        .where(sql`${supplierContacts.supplierId} IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`)
    : [];
  const contactEmailsBySupplier = new Map<number, string[]>();
  for (const c of contactRows) {
    const arr = contactEmailsBySupplier.get(c.supplierId) ?? [];
    arr.push((c.email ?? "").toLowerCase());
    contactEmailsBySupplier.set(c.supplierId, arr);
  }

  const pendingEmailLc = (pending.email ?? "").toLowerCase();
  const pendingEmailDomain = emailDomain(pending.email);
  const pendingHost = websiteHost(pending.website);
  const pendingTokens = nameTokens(pending.name);
  const pendingNormalised = normaliseName(pending.name);

  const scored: SupplierMatchCandidate[] = [];
  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];

    const candEmailLc = (c.email ?? "").toLowerCase();
    const contactEmails = contactEmailsBySupplier.get(c.id) ?? [];
    const allCandidateEmails = [candEmailLc, ...contactEmails].filter(Boolean);

    if (pendingEmailLc && allCandidateEmails.includes(pendingEmailLc)) {
      score += 100;
      reasons.push("Same email on file");
    } else if (pendingEmailDomain) {
      const candDomains = allCandidateEmails.map(emailDomain).filter(Boolean);
      if (candDomains.includes(pendingEmailDomain)) {
        score += 30;
        reasons.push(`Shared email domain (@${pendingEmailDomain})`);
      }
    }

    const candHost = websiteHost(c.website);
    if (pendingHost && candHost && pendingHost === candHost) {
      score += 60;
      reasons.push(`Same website (${candHost})`);
    }

    const candNormalised = normaliseName(c.name);
    if (pendingNormalised && candNormalised && pendingNormalised === candNormalised) {
      score += 80;
      reasons.push("Identical company name");
    } else {
      const candTokens = nameTokens(c.name);
      const j = jaccard(pendingTokens, candTokens);
      if (j >= 0.7) {
        score += 50;
        reasons.push("Very similar name");
      } else if (j >= 0.4) {
        score += 20;
        reasons.push("Similar name");
      }
    }

    if (score >= 40) {
      scored.push({
        id: c.id,
        name: c.name,
        category: c.category,
        contactName: c.contactName,
        email: c.email,
        website: c.website,
        origin: c.origin,
        score,
        reasons,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// Reviewer-facing search over the same tenant's approved supplier
// directory, used by the "link to a different supplier" picker when the
// auto-suggested matches are wrong. Limits to 25 hits ordered by name.
export type SupplierDirectoryRow = {
  id: number;
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  website: string | null;
  origin: string | null;
};

export async function searchSupplierDirectoryForMerge(input: {
  pendingSupplierId: number;
  query?: string;
}): Promise<SupplierDirectoryRow[]> {
  await requireSupplierEditor();
  await ensureOnboardingSchema();
  const [pending] = await db
    .select({ clientId: suppliers.clientId })
    .from(suppliers)
    .where(eq(suppliers.id, input.pendingSupplierId))
    .limit(1);
  if (!pending?.clientId) return [];

  const q = (input.query ?? "").trim().toLowerCase();
  const whereExpr = q
    ? and(
        eq(suppliers.clientId, pending.clientId),
        sql`${suppliers.id} <> ${input.pendingSupplierId}`,
        eq(suppliers.onboardingStatus, "approved"),
        sql`(LOWER(${suppliers.name}) LIKE ${"%" + q + "%"} OR LOWER(COALESCE(${suppliers.email}, '')) LIKE ${"%" + q + "%"} OR LOWER(COALESCE(${suppliers.website}, '')) LIKE ${"%" + q + "%"})`,
      )
    : and(
        eq(suppliers.clientId, pending.clientId),
        sql`${suppliers.id} <> ${input.pendingSupplierId}`,
        eq(suppliers.onboardingStatus, "approved"),
      );

  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      category: suppliers.category,
      contactName: suppliers.contactName,
      email: suppliers.email,
      website: suppliers.website,
      origin: suppliers.origin,
    })
    .from(suppliers)
    .where(whereExpr)
    .orderBy(asc(suppliers.name))
    .limit(25);
  return rows;
}

// Approve the pending sign-up by merging it INTO an existing supplier
// the reviewer picked. Strategy:
//   1. Move supplier_attachments from pending → target.
//   2. Move supplier_onboarding_submissions from pending → target.
//   3. Copy supplier_contacts (dedupe on email).
//   4. Add a "merged from pending sign-up" line to target.notes so the
//      history isn't silently lost (the reviewer's notes column).
//   5. Stamp the target row as approved (status, reviewer, timestamp).
//   6. DELETE the pending suppliers row — its dependent rows have all
//      been moved off, so the cascade fires on nothing.
// Preserves the existing target row's core fields (name, category,
// products, etc.) so curated supplier data isn't silently overwritten
// by what the sales rep typed into the wizard. The reviewer can still
// edit any field manually from the admin panel afterwards.
export async function approveSupplierByMerging(input: {
  pendingSupplierId: number;
  targetSupplierId: number;
  reviewerNotes?: string;
}): Promise<{ targetSupplierId: number }> {
  const profile = await requireSupplierEditor();
  await ensureOnboardingSchema();

  if (input.pendingSupplierId === input.targetSupplierId) {
    throw new Error("Cannot merge a supplier into itself.");
  }

  // Verify both rows exist on the same tenant — reviewers can't
  // accidentally (or maliciously) splice rows across tenants.
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      clientId: suppliers.clientId,
      notes: suppliers.notes,
      status: suppliers.onboardingStatus,
    })
    .from(suppliers)
    .where(
      sql`${suppliers.id} IN (${input.pendingSupplierId}, ${input.targetSupplierId})`,
    );
  const pending = rows.find((r) => r.id === input.pendingSupplierId);
  const target = rows.find((r) => r.id === input.targetSupplierId);
  if (!pending) throw new Error("Pending supplier not found.");
  if (!target) throw new Error("Target supplier not found.");
  if (pending.clientId == null || target.clientId == null) {
    throw new Error("Both suppliers must be linked to a tenant.");
  }
  if (pending.clientId !== target.clientId) {
    throw new Error("Suppliers belong to different tenants — cannot merge.");
  }

  // 1. Attachments
  await db
    .update(supplierAttachments)
    .set({ supplierId: input.targetSupplierId })
    .where(eq(supplierAttachments.supplierId, input.pendingSupplierId));

  // 2. Submissions
  await db
    .update(supplierOnboardingSubmissions)
    .set({ supplierId: input.targetSupplierId })
    .where(eq(supplierOnboardingSubmissions.supplierId, input.pendingSupplierId));

  // 3. Contacts — dedupe on lowercased email.
  const targetContacts = await db
    .select({ email: supplierContacts.email })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, input.targetSupplierId));
  const targetEmails = new Set(targetContacts.map((c) => c.email.toLowerCase()));
  const pendingContacts = await db
    .select()
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, input.pendingSupplierId));
  for (const c of pendingContacts) {
    if (!targetEmails.has(c.email.toLowerCase())) {
      await db.insert(supplierContacts).values({
        supplierId: input.targetSupplierId,
        name: c.name,
        email: c.email,
        phone: c.phone,
        role: c.role,
        // Never auto-promote the merged contact above the target's
        // existing primary contact — the reviewer reassigns manually
        // from the admin if they want to.
        isPrimary: false,
        notes: c.notes,
      });
      targetEmails.add(c.email.toLowerCase());
    }
  }

  // Make sure the pending row's primary email is on the target as a
  // contact even when there's no row in supplier_contacts (older sign-
  // ups only wrote the contact when profile.email existed). This is
  // what keeps the merged supplier reachable from the new user's
  // /portal sign-in (which matches on suppliers.email OR contact.email).
  if (pending.email && !targetEmails.has(pending.email.toLowerCase())) {
    await db.insert(supplierContacts).values({
      supplierId: input.targetSupplierId,
      name: pending.name ?? null,
      email: pending.email,
      isPrimary: false,
    });
  }

  // 4. History note on the target — keep a breadcrumb so the reviewer
  // (or anyone looking later) can see this supplier was approved via a
  // sign-up merge, with what the sign-up reported and any reviewer
  // note. Keep it short, prepend to whatever notes already exist.
  const now = new Date();
  const mergeNote = [
    `[${now.toISOString().slice(0, 10)}] Merged sign-up from ${pending.name}${pending.email ? ` <${pending.email}>` : ""}.`,
    input.reviewerNotes?.trim() ? `Reviewer: ${input.reviewerNotes.trim()}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const nextNotes = target.notes
    ? `${mergeNote}\n${target.notes}`
    : mergeNote;

  // 5. Stamp target as approved.
  await db
    .update(suppliers)
    .set({
      notes: nextNotes,
      onboardingStatus: "approved",
      onboardingReviewedAt: now,
      onboardingReviewedByClerkId: profile.clerkUserId,
      onboardingReviewerNotes: input.reviewerNotes?.trim() || null,
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.targetSupplierId));

  // 6. Delete the pending row. Nothing left dependent on it after the
  // moves above; the cascade on supplier_contacts / attachments /
  // submissions fires on empty sets.
  await db.delete(suppliers).where(eq(suppliers.id, input.pendingSupplierId));

  // Notify the supplier who signed up that they've been linked.
  if (pending.email) {
    try {
      const [u] = await db
        .select({ clerkUserId: userProfiles.clerkUserId })
        .from(userProfiles)
        .where(sql`LOWER(${userProfiles.email}) = ${pending.email.toLowerCase()}`)
        .limit(1);
      if (u?.clerkUserId) {
        await db.insert(erpNotifications).values({
          targetClerkId: u.clerkUserId,
          kind: "supplier.status-update",
          title: "Your account has been approved",
          body: `Your sign-up was linked to ${target.name} in the Engineering/Designer Company's directory. The full portal is now unlocked.`,
          linkUrl: "/portal",
        });
      }
    } catch (e) {
      console.warn("[approveSupplierByMerging] notify failed:", e);
    }
  }

  revalidatePath("/portal");
  revalidatePath("/suppliers");
  revalidatePath("/admin");
  return { targetSupplierId: input.targetSupplierId };
}
