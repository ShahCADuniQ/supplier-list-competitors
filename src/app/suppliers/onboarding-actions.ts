"use server";

// Supplier onboarding workflow — checklist submission, admin review,
// approve / reject. Suppliers can only access the catalog / orders / chat
// AFTER an admin has approved their submission.

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  suppliers,
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

  // Lock check: once the supplier has submitted step 2 (or already been
  // approved/rejected by a reviewer) we don't allow self-edits. They
  // need to ask the engineering admin to send it back via the reject
  // flow, which puts status back to 'rejected' and unlocks this path.
  const [current] = await db
    .select({ status: suppliers.onboardingStatus })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!current) throw new Error("Supplier not found");
  if (current.status !== "pending" && current.status !== "rejected") {
    throw new Error(
      "Your application has already been submitted. Ask the reviewer to send it back if you need to make changes.",
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
        `We couldn't find a retailer on CADuniQ with the email "${input.newEngineeringCompanyEmail.trim()}". Double-check the spelling or try a different address.`,
      );
    }
    nextClientId = match.clientId;
  }

  // When the supplier flips on the buy-and-sell flag we deliberately
  // wipe both lists so the reviewer sees a clean "distributor" signal
  // instead of a stale set of manufacturing capabilities.
  const distributor = Boolean(input.isDistributor);
  const manufacturingTypes = distributor
    ? []
    : (input.manufacturingTypes ?? []).map((s) => s.trim()).filter(Boolean);
  const materials = distributor
    ? []
    : (input.materials ?? []).map((s) => s.trim()).filter(Boolean);

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
      manufacturingTypes,
      materials,
      isDistributor: distributor,
      ...(nextClientId !== undefined ? { clientId: nextClientId } : {}),
      updatedAt: now,
    })
    .where(eq(suppliers.id, input.supplierId));

  revalidatePath("/portal");
  revalidatePath("/admin");
  return { updatedAt: now };
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
