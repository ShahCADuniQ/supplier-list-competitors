"use server";

// Server actions for the Manage Account → Email section. Used to
// disconnect a connected mailbox; the connect flow is a plain GET
// redirect handled by /api/email/oauth/{microsoft,google}/start.

import { revalidatePath } from "next/cache";
import {
  deleteConnection,
  listConnections,
} from "@/lib/email/connections";
import { revokeGrant } from "@/lib/email/nylas";
import { getOrCreateProfile } from "@/lib/permissions";
import type { EmailProvider } from "@/lib/email/types";

export type ConnectionSummary = {
  provider: EmailProvider;
  emailAddress: string;
  scope: string | null;
  lastSyncAt: string | null;
};

export async function listMyEmailConnections(): Promise<ConnectionSummary[]> {
  const profile = await getOrCreateProfile();
  if (!profile) return [];
  const rows = await listConnections(profile.clerkUserId);
  return rows.map((r) => ({
    provider: r.provider,
    emailAddress: r.emailAddress,
    scope: r.scope,
    lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
  }));
}

export async function disconnectMyEmail(
  provider: EmailProvider,
): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Not signed in");
  const { grantId } = await deleteConnection(profile.clerkUserId, provider);
  // Best-effort revoke on Nylas's side so we don't keep paying for an
  // unused grant. Failures are logged but don't block the local delete.
  if (grantId) await revokeGrant(grantId);
  revalidatePath("/settings");
}
