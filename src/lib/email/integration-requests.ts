// Email-integration approval workflow.
//
// Each tenant has to be approved by CADuniQ HQ before its users can run
// the Nylas OAuth flow. Tenant admins click the "Connect work email"
// card on their home page → status goes from `none` → `requested`.
// CADuniQ staff see pending requests on the HQ dashboard and approve
// or reject → status flips to `approved` / `rejected`. The Connect
// buttons in Settings + onboarding stay disabled until `approved`.
//
// Reads are server-only (no client-component imports), writes are
// exposed as server actions in actions.ts so the UI can call them.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { ensureEmailConnectionsSchema } from "./_ensure-schema";

export type EmailIntegrationStatus =
  | "none"
  | "requested"
  | "approved"
  | "rejected";

export type EmailIntegrationState = {
  status: EmailIntegrationStatus;
  requestedBy: string | null;
  requestedAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  notes: string | null;
};

export async function getTenantIntegrationState(
  clientId: number,
): Promise<EmailIntegrationState | null> {
  await ensureEmailConnectionsSchema();
  const [row] = await db
    .select({
      status: clients.emailIntegrationStatus,
      requestedBy: clients.emailIntegrationRequestedBy,
      requestedAt: clients.emailIntegrationRequestedAt,
      decidedBy: clients.emailIntegrationDecidedBy,
      decidedAt: clients.emailIntegrationDecidedAt,
      notes: clients.emailIntegrationNotes,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) return null;
  return {
    status: (row.status ?? "none") as EmailIntegrationStatus,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    notes: row.notes,
  };
}

export async function isTenantApproved(clientId: number): Promise<boolean> {
  const s = await getTenantIntegrationState(clientId);
  return s?.status === "approved";
}

export type PendingIntegrationRequest = {
  clientId: number;
  clientName: string;
  requestedBy: string | null;
  requestedAt: Date | null;
  status: EmailIntegrationStatus;
  notes: string | null;
};

// Used by the CADuniQ HQ dashboard to surface tenants awaiting a
// decision. Includes `rejected` so HQ can re-approve a previously
// rejected tenant without the tenant having to re-request.
export async function listPendingIntegrationRequests(): Promise<
  PendingIntegrationRequest[]
> {
  await ensureEmailConnectionsSchema();
  const rows = await db
    .select({
      clientId: clients.id,
      clientName: clients.name,
      status: clients.emailIntegrationStatus,
      requestedBy: clients.emailIntegrationRequestedBy,
      requestedAt: clients.emailIntegrationRequestedAt,
      notes: clients.emailIntegrationNotes,
    })
    .from(clients);
  return rows
    .filter((r) => r.status === "requested" || r.status === "rejected")
    .map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      status: (r.status ?? "none") as EmailIntegrationStatus,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt,
      notes: r.notes,
    }));
}

export async function setTenantStatus(args: {
  clientId: number;
  status: EmailIntegrationStatus;
  requestedBy?: string;
  decidedBy?: string;
  notes?: string | null;
}): Promise<void> {
  await ensureEmailConnectionsSchema();
  const now = new Date();
  const patch: Record<string, unknown> = {
    emailIntegrationStatus: args.status,
    updatedAt: now,
  };
  if (args.requestedBy) {
    patch.emailIntegrationRequestedBy = args.requestedBy;
    patch.emailIntegrationRequestedAt = now;
  }
  if (args.decidedBy) {
    patch.emailIntegrationDecidedBy = args.decidedBy;
    patch.emailIntegrationDecidedAt = now;
  }
  if (args.notes !== undefined) {
    patch.emailIntegrationNotes = args.notes;
  }
  await db.update(clients).set(patch).where(eq(clients.id, args.clientId));
}
