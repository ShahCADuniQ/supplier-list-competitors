"use server";

// CADuniQ-staff-only server actions. Used by the CADuniQ HQ dashboard
// (rendered on / for @caduniq.com users) to manage tenant-level state
// that isn't available to client-tenant admins:
//
//   • setClientModuleAccess — toggle a module on/off for a whole client
//     tenant. Effective module access for a user is the AND of this
//     tenant-level flag with their per-user can_view_* gate, so flipping
//     it off here shuts the module for every user under that client at
//     once.
//
// All actions throw if the caller isn't a CADuniQ user (cross-tenant
// staff). Lightbase admins, supplier-portal accounts, etc. can't reach
// this surface from the UI but the server-side guard is what actually
// enforces the boundary.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, suppliers, userProfiles } from "@/db/schema";
import {
  ensureUserProfileColumns,
  getOrCreateProfile,
  isCaduniqUser,
} from "@/lib/permissions";

export type ClientModule =
  | "suppliers"
  | "competitors"
  | "handbook"
  | "engineering"
  | "designEngineering"
  | "crm"
  | "oee";

const COLUMN_BY_MODULE: Record<ClientModule, keyof typeof clients.$inferInsert> = {
  suppliers: "canUseSuppliers",
  competitors: "canUseCompetitors",
  handbook: "canUseHandbook",
  engineering: "canUseEngineering",
  designEngineering: "canUseDesignEngineering",
  crm: "canUseCrm",
  oee: "canUseOee",
};

async function requireCaduniq(): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in first");
  if (!isCaduniqUser(profile)) {
    throw new Error("CADuniQ staff only");
  }
}

export async function setClientModuleAccess(input: {
  clientId: number;
  module: ClientModule;
  enabled: boolean;
}): Promise<void> {
  await requireCaduniq();
  await ensureUserProfileColumns();

  const column = COLUMN_BY_MODULE[input.module];
  if (!column) throw new Error(`Unknown module: ${input.module}`);

  // Build a typed update set with just the one column we're touching.
  const patch: Partial<typeof clients.$inferInsert> = {
    [column]: input.enabled,
    updatedAt: new Date(),
  };

  await db.update(clients).set(patch).where(eq(clients.id, input.clientId));

  revalidatePath("/");
  revalidatePath("/admin");
}

// Remove a client tenant — CADuniQ-staff only. Wipes the tenant's
// suppliers (the supplier-scoped tables cascade off of suppliers.id
// already), unlinks every user_profiles row that pointed at this
// tenant (their accounts stay; they just lose tenant access and get
// bounced back to /get-started on next sign-in), then deletes the
// clients row itself.
//
// Caller passes the expected tenant name as `confirmName` and we
// reject if it doesn't match — guards against accidental clicks. The
// CADuniQ HQ UI surfaces a typed-confirmation dialog before calling.
export async function deleteClient(input: {
  clientId: number;
  confirmName: string;
}): Promise<{ removed: { name: string; suppliers: number; users: number } }> {
  await requireCaduniq();
  await ensureUserProfileColumns();

  const [tenant] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);
  if (!tenant) throw new Error("Tenant not found");
  if (tenant.name.trim().toLowerCase() !== input.confirmName.trim().toLowerCase()) {
    throw new Error(
      `Type the tenant name exactly to confirm. Expected "${tenant.name}".`,
    );
  }

  // 1. Unlink every user_profiles row on this tenant. The Clerk
  // identities stay — we just drop our local linkage + permission
  // flags AND clear approvedAt/approvedBy so the home page's
  // mid-signup detection re-fires for them and routes back to
  // /get-started instead of leaving them on AwaitingAccess.
  const unlinked = await db
    .update(userProfiles)
    .set({
      clientId: null,
      isSupplier: false,
      isRetailer: false,
      role: "pending",
      pendingSignupRole: null,
      canViewSuppliers: false,
      canViewCompetitors: false,
      canViewHandbook: false,
      canViewEngineering: false,
      canViewDesignEngineering: false,
      canViewCrm: false,
      canViewOee: false,
      canEdit: false,
      approvedAt: null,
      approvedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.clientId, input.clientId))
    .returning({ id: userProfiles.clerkUserId });

  // 2. Delete every supplier on this tenant. Cascading FKs handle the
  // supplier-scoped data: supplier_contacts, supplier_attachments,
  // supplier_products (which cascades to supplier_product_attachments),
  // supplier_onboarding_submissions, etc. RFQs / POs that linked to
  // these suppliers via supplier_id are typically tied through
  // rfq_recipients (which cascades) so the cleanup is contained.
  const deletedSuppliers = await db
    .delete(suppliers)
    .where(eq(suppliers.clientId, input.clientId))
    .returning({ id: suppliers.id });

  // 3. Drop the clients row.
  await db.delete(clients).where(eq(clients.id, input.clientId));

  revalidatePath("/");
  revalidatePath("/admin");
  return {
    removed: {
      name: tenant.name,
      suppliers: deletedSuppliers.length,
      users: unlinked.length,
    },
  };
}
