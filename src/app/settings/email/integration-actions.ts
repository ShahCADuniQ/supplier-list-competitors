"use server";

// Server actions for the email-integration approval workflow.
// Tenant admins call requestEmailIntegration() from the home page card;
// CADuniQ HQ calls decideEmailIntegrationRequest() from their pending
// queue. Both are gated by their respective permission checks.

import { revalidatePath } from "next/cache";
import {
  getOrCreateProfile,
  isAdmin,
  isCaduniqUser,
} from "@/lib/permissions";
import {
  getTenantIntegrationState,
  setTenantStatus,
} from "@/lib/email/integration-requests";

export type RequestResult = {
  ok: boolean;
  status: "requested" | "approved" | "rejected" | "none";
  error?: string;
};

export async function requestEmailIntegration(input: {
  notes?: string;
}): Promise<RequestResult> {
  const profile = await getOrCreateProfile();
  if (!profile) return { ok: false, status: "none", error: "Not signed in" };
  if (!isAdmin(profile)) {
    return {
      ok: false,
      status: "none",
      error:
        "Only your company's administrator can request the email integration.",
    };
  }
  if (profile.clientId == null) {
    return {
      ok: false,
      status: "none",
      error: "Your account isn't attached to a company yet.",
    };
  }
  const current = await getTenantIntegrationState(profile.clientId);
  if (current?.status === "approved") {
    return { ok: true, status: "approved" };
  }
  if (current?.status === "requested") {
    // Idempotent: re-clicking doesn't error.
    return { ok: true, status: "requested" };
  }
  await setTenantStatus({
    clientId: profile.clientId,
    status: "requested",
    requestedBy: profile.clerkUserId,
    notes: input.notes?.trim() || null,
  });
  revalidatePath("/");
  revalidatePath("/settings");
  return { ok: true, status: "requested" };
}

export async function decideEmailIntegrationRequest(input: {
  clientId: number;
  approve: boolean;
  notes?: string;
}): Promise<RequestResult> {
  const profile = await getOrCreateProfile();
  if (!profile) return { ok: false, status: "none", error: "Not signed in" };
  if (!isCaduniqUser(profile)) {
    return {
      ok: false,
      status: "none",
      error: "Only CADuniQ HQ can approve email integration requests.",
    };
  }
  await setTenantStatus({
    clientId: input.clientId,
    status: input.approve ? "approved" : "rejected",
    decidedBy: profile.clerkUserId,
    notes: input.notes?.trim() || null,
  });
  revalidatePath("/");
  revalidatePath("/settings");
  return { ok: true, status: input.approve ? "approved" : "rejected" };
}
