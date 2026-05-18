"use server";

import { revalidatePath } from "next/cache";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, suppliers, userProfiles, type Client } from "@/db/schema";
import {
  ensureUserProfileColumns,
  isCaduniqUser,
  isSeededAdminEmail,
  requireAdmin,
} from "@/lib/permissions";
import { JOB_ROLES, type JobRole } from "@/lib/job-roles";

export type AccessUpdate = {
  clerkUserId: string;
  role?: "admin" | "member" | "pending";
  canViewSuppliers?: boolean;
  canViewCompetitors?: boolean;
  canViewHandbook?: boolean;
  canViewEngineering?: boolean;
  canViewDesignEngineering?: boolean;
  canViewCrm?: boolean;
  canViewOee?: boolean;
  canEdit?: boolean;
};

export async function updateUserAccess(update: AccessUpdate) {
  const admin = await requireAdmin();
  await ensureUserProfileColumns();

  const [target] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, update.clerkUserId))
    .limit(1);
  if (!target) throw new Error("User not found");

  // Prevent the seeded admin accounts from being demoted via the UI.
  if (isSeededAdminEmail(target.email) && update.role && update.role !== "admin") {
    throw new Error("Cannot demote a seeded admin account");
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
  if (update.canViewHandbook !== undefined)
    updates.canViewHandbook = update.canViewHandbook;
  if (update.canViewEngineering !== undefined)
    updates.canViewEngineering = update.canViewEngineering;
  if (update.canViewDesignEngineering !== undefined)
    updates.canViewDesignEngineering = update.canViewDesignEngineering;
  if (update.canViewCrm !== undefined) updates.canViewCrm = update.canViewCrm;
  if (update.canViewOee !== undefined) updates.canViewOee = update.canViewOee;
  if (update.canEdit !== undefined) updates.canEdit = update.canEdit;

  if (wasPending && becomingActive && !target.approvedAt) {
    updates.approvedAt = new Date();
    updates.approvedBy = admin.clerkUserId;
  }

  // If they're being promoted to admin, give full access automatically.
  if (update.role === "admin") {
    updates.canViewSuppliers = true;
    updates.canViewCompetitors = true;
    updates.canViewHandbook = true;
    updates.canViewEngineering = true;
    updates.canViewDesignEngineering = true;
    updates.canViewCrm = true;
    updates.canViewOee = true;
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
  access: {
    canViewSuppliers: boolean;
    canViewCompetitors: boolean;
    canViewHandbook?: boolean;
    canViewEngineering?: boolean;
    canViewDesignEngineering?: boolean;
    canViewCrm?: boolean;
    canViewOee?: boolean;
    canEdit: boolean;
  },
) {
  await updateUserAccess({
    clerkUserId,
    role: "member",
    ...access,
  });
}

// Approve with EVERY sidebar surface enabled (read-only). Useful as the
// default for new internal members on a client deployment where the admin
// just wants them to "see everything" without thinking.
export async function approveUserFullView(clerkUserId: string) {
  await approveUser(clerkUserId, {
    canViewSuppliers: true,
    canViewCompetitors: true,
    canViewHandbook: true,
    canViewEngineering: true,
    canViewDesignEngineering: true,
    canViewCrm: true,
    canViewOee: true,
    canEdit: false,
  });
}

export async function revokeUser(clerkUserId: string) {
  await updateUserAccess({
    clerkUserId,
    role: "pending",
    canViewSuppliers: false,
    canViewCompetitors: false,
    canViewHandbook: false,
    canViewEngineering: false,
    canViewDesignEngineering: false,
    canViewCrm: false,
    canViewOee: false,
    canEdit: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS (multi-tenant). CADuniQ staff can manage every client; client
// admins can only see the one row they're scoped to.
// ─────────────────────────────────────────────────────────────────────────────

export async function listClients(): Promise<Client[]> {
  await requireAdmin();
  await ensureUserProfileColumns();
  return db.select().from(clients).orderBy(asc(clients.name));
}

export async function createClient(input: {
  name: string;
  industry?: string;
  notes?: string;
}): Promise<{ id: number }> {
  const admin = await requireAdmin();
  if (!isCaduniqUser(admin)) {
    throw new Error("Only CADuniQ staff can create new clients");
  }
  await ensureUserProfileColumns();
  const name = input.name.trim();
  if (!name) throw new Error("Client name is required");
  const [row] = await db
    .insert(clients)
    .values({
      name,
      industry: input.industry?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .returning();
  revalidatePath("/admin");
  return { id: row.id };
}

export async function setUserClient(input: {
  clerkUserId: string;
  clientId: number | null;
}): Promise<void> {
  const admin = await requireAdmin();
  if (!isCaduniqUser(admin)) {
    throw new Error("Only CADuniQ staff can re-assign users between clients");
  }
  await ensureUserProfileColumns();
  await db
    .update(userProfiles)
    .set({ clientId: input.clientId, updatedAt: new Date() })
    .where(eq(userProfiles.clerkUserId, input.clerkUserId));
  revalidatePath("/admin");
}

export async function setSupplierClient(input: {
  supplierId: number;
  clientId: number | null;
}): Promise<void> {
  const admin = await requireAdmin();
  if (!isCaduniqUser(admin)) {
    throw new Error("Only CADuniQ staff can re-assign suppliers between clients");
  }
  await ensureUserProfileColumns();
  await db
    .update(suppliers)
    .set({ clientId: input.clientId, updatedAt: new Date() })
    .where(eq(suppliers.id, input.supplierId));
  revalidatePath("/admin");
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB ROLE — pick from JOB_ROLES dropdown. Editable by any admin within
// their tenant scope (caduniq users are cross-tenant).
// ─────────────────────────────────────────────────────────────────────────────

export async function setUserJobRole(input: {
  clerkUserId: string;
  jobRole: string | null;
}): Promise<void> {
  const admin = await requireAdmin();
  await ensureUserProfileColumns();
  const clean = input.jobRole?.trim() || null;
  if (clean) {
    const match = JOB_ROLES.find(
      (r) => r.toLowerCase() === clean.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `"${clean}" is not a recognised job role. Pick from: ${JOB_ROLES.join(", ")}`,
      );
    }
  }
  if (!isCaduniqUser(admin)) {
    const [target] = await db
      .select({ clientId: userProfiles.clientId })
      .from(userProfiles)
      .where(eq(userProfiles.clerkUserId, input.clerkUserId))
      .limit(1);
    if (!target || target.clientId !== admin.clientId) {
      throw new Error("Cannot edit users outside your client tenant");
    }
  }
  await db
    .update(userProfiles)
    .set({ jobRole: clean as JobRole | null, updatedAt: new Date() })
    .where(eq(userProfiles.clerkUserId, input.clerkUserId));
  revalidatePath("/admin");
}

void sql;
