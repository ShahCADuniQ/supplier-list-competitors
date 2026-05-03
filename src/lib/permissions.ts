import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userProfiles, type UserProfile } from "@/db/schema";

export const ADMIN_EMAIL = "hshah@lightbase.ca";

/**
 * Resolve the current Clerk user's profile. If they don't have one yet, create
 * it. The seeded admin email gets full access automatically; everyone else
 * starts as `pending` and has to be approved by an admin.
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

  // First request after sign-in — pull the email from Clerk and create a row.
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? "";
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null;

  const isAdmin = email === ADMIN_EMAIL.toLowerCase();

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
