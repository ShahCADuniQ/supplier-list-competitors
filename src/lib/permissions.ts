import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userProfiles, type UserProfile } from "@/db/schema";

// CADuniQ is the operator/vendor — every @caduniq.com mailbox is automatically
// a full admin across every client dashboard hosted on this codebase. The
// named list below covers explicit non-domain admins (e.g. legacy Lightbase
// owner) plus the canonical contact emails surfaced in the UI.
export const ADMIN_EMAIL_DOMAINS = ["caduniq.com"] as const;

export const ADMIN_EMAILS = [
  "hshah@caduniq.com",
  "hshah@lightbase.ca",
] as const;

export const ADMIN_EMAIL = ADMIN_EMAILS[0];

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Returns true if the email should be auto-promoted to admin on sign-in and
 * protected from being demoted via the UI. Matches either:
 *   - any address on a CADuniQ-staff domain (ADMIN_EMAIL_DOMAINS), or
 *   - one of the explicit named admin accounts (ADMIN_EMAILS).
 */
export function isSeededAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (ADMIN_EMAILS.some((a) => a.toLowerCase() === normalized)) return true;
  const domain = emailDomain(normalized);
  return ADMIN_EMAIL_DOMAINS.some((d) => d.toLowerCase() === domain);
}

/**
 * Resolve the current Clerk user's profile. If they don't have one yet, create
 * it. Seeded admin emails get full access automatically; everyone else starts
 * as `pending` and has to be approved by an admin.
 */
export async function getOrCreateProfile(): Promise<UserProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const existing = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, userId))
    .limit(1);

  if (existing.length) return existing[0];

  // First request after this Clerk user signed in — pull the email from Clerk.
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? "";
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null;

  const isAdmin = isSeededAdminEmail(email);

  // A row may already exist for this email under a *different* clerk_user_id
  // (e.g. a previous Clerk user for the same address, or a pre-seeded row).
  // The table has a UNIQUE index on email, so a naked INSERT would fail. Adopt
  // the existing row by repointing it at the current Clerk user.
  if (email) {
    const [existingByEmail] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.email, email))
      .limit(1);

    if (existingByEmail) {
      const updates: Partial<typeof userProfiles.$inferInsert> = {
        clerkUserId: userId,
        updatedAt: new Date(),
      };
      if (displayName && !existingByEmail.displayName) {
        updates.displayName = displayName;
      }
      // If this email is a seeded admin but the row was created in a less-
      // privileged state (pending/member from an earlier life), bring it up
      // to full admin so the bootstrap promise still holds.
      if (isAdmin && existingByEmail.role !== "admin") {
        updates.role = "admin";
        updates.canViewSuppliers = true;
        updates.canViewCompetitors = true;
        updates.canViewHandbook = true;
        updates.canViewEngineering = true;
        updates.canEdit = true;
        if (!existingByEmail.approvedAt) updates.approvedAt = new Date();
        if (!existingByEmail.approvedBy) updates.approvedBy = "system:bootstrap";
      }

      const [adopted] = await db
        .update(userProfiles)
        .set(updates)
        .where(eq(userProfiles.email, email))
        .returning();
      return adopted ?? existingByEmail;
    }
  }

  const [created] = await db
    .insert(userProfiles)
    .values({
      clerkUserId: userId,
      email,
      displayName,
      role: isAdmin ? "admin" : "pending",
      canViewSuppliers: isAdmin,
      canViewCompetitors: isAdmin,
      canViewHandbook: isAdmin,
      canViewEngineering: isAdmin,
      canEdit: isAdmin,
      approvedAt: isAdmin ? new Date() : null,
      approvedBy: isAdmin ? "system:bootstrap" : null,
    })
    .onConflictDoNothing({ target: userProfiles.clerkUserId })
    .returning();

  if (created) return created;

  // Race-condition fallback: another request created it first.
  const refetched = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, userId))
    .limit(1);
  return refetched[0] ?? null;
}

export function isAdmin(profile: UserProfile | null | undefined): boolean {
  return profile?.role === "admin";
}

export function canViewSuppliers(profile: UserProfile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewSuppliers;
}

export function canViewCompetitors(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewCompetitors;
}

export function canViewHandbook(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewHandbook;
}

export function canViewEngineering(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewEngineering;
}

export function canEdit(profile: UserProfile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canEdit;
}

/**
 * Throw if the current user is not an admin. Use inside server actions that
 * mutate users / approval state.
 */
export async function requireAdmin(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !isAdmin(profile)) {
    throw new Error("Unauthorized: admin access required");
  }
  return profile;
}

/** Throw if the current user can't view + edit suppliers. */
export async function requireSupplierEditor(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot edit suppliers");
  }
  return profile;
}

/** Throw if the current user can't view + edit competitors. */
export async function requireCompetitorEditor(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewCompetitors(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot edit competitors");
  }
  return profile;
}
