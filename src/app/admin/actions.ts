"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userProfiles } from "@/db/schema";
import { ADMIN_EMAIL, requireAdmin } from "@/lib/permissions";

export type AccessUpdate = {
  clerkUserId: string;
  role?: "admin" | "member" | "pending";
  canViewSuppliers?: boolean;
  canViewCompetitors?: boolean;
  canEdit?: boolean;
};

export async function updateUserAccess(update: AccessUpdate) {
  const admin = await requireAdmin();

  const [target] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, update.clerkUserId))
    .limit(1);
  if (!target) throw new Error("User not found");

  // Prevent the seeded admin from being demoted via the UI.
  if (target.email === ADMIN_EMAIL.toLowerCase() && update.role && update.role !== "admin") {
    throw new Error("Cannot demote the primary admin account");
  }

  const wasPending = target.role === "pending";
  const becomingActive = update.role && update.role !== "pending";

  const updates: Partial<typeof userProfiles.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (update.role !== undefined) updates.role = update.role;
  if (update.canViewSuppliers !== undefined)
    updates.canViewSuppliers = update.canViewSuppliers;
  if (update.canViewCompetitors !== undefined)
    updates.canViewCompetitors = update.canViewCompetitors;
  if (update.canEdit !== undefined) updates.canEdit = update.canEdit;

  if (wasPending && becomingActive && !target.approvedAt) {
    updates.approvedAt = new Date();
    updates.approvedBy = admin.clerkUserId;
  }

  // If they're being promoted to admin, give full access automatically.
  if (update.role === "admin") {
    updates.canViewSuppliers = true;
    updates.canViewCompetitors = true;
    updates.canEdit = true;
  }

  await db
    .update(userProfiles)
    .set(updates)
    .where(eq(userProfiles.clerkUserId, update.clerkUserId));

  revalidatePath("/admin");
  revalidatePath("/");
}

export async function approveUser(
  clerkUserId: string,
  access: { canViewSuppliers: boolean; canViewCompetitors: boolean; canEdit: boolean },
) {
  await updateUserAccess({
    clerkUserId,
    role: "member",
    ...access,
  });
}

export async function revokeUser(clerkUserId: string) {
  await updateUserAccess({
    clerkUserId,
    role: "pending",
    canViewSuppliers: false,
    canViewCompetitors: false,
    canEdit: false,
  });
}
