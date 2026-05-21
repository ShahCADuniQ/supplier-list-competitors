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
import { clients } from "@/db/schema";
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
