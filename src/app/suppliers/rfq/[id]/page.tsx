import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  rfqItemAttachments,
  rfqItems,
  rfqRecipients,
  rfqs,
  suppliers,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  isSupplierUser,
  canViewSuppliers,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";
import RfqView from "./RfqView";

// Standalone RFQ view + print template.
// Auth rules (any one passes):
//   • Staff (canViewSuppliers) — full access, plus the upload-PDF button
//   • Clerk-authed supplier whose email matches a recipient on this RFQ
//   • Magic-link supplier passing ?token=<rfq_recipients.access_token>
// Read-only for suppliers (no upload button rendered).

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [r] = await db
    .select({ rfqNumber: rfqs.rfqNumber })
    .from(rfqs)
    .where(eq(rfqs.id, Number(id)))
    .limit(1);
  return {
    title: r
      ? `${r.rfqNumber} · ${CLIENT_CONFIG.name}`
      : `RFQ · ${CLIENT_CONFIG.name}`,
  };
}

export default async function RfqPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const rfqId = Number(id);
  if (!Number.isFinite(rfqId)) notFound();

  await ensureOrdersSchema();

  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, rfqId))
    .limit(1);
  if (!rfq) notFound();

  // Authorization path 1 — magic-link token. No Clerk required. Token
  // must match a recipient on THIS rfq (so a token for a different RFQ
  // doesn't grant access here).
  let tokenOk = false;
  if (token) {
    const [rec] = await db
      .select({ id: rfqRecipients.id, exp: rfqRecipients.tokenExpiresAt })
      .from(rfqRecipients)
      .where(
        sql`${rfqRecipients.rfqId} = ${rfqId}
          AND ${rfqRecipients.accessToken} = ${token}`,
      )
      .limit(1);
    if (rec && (!rec.exp || rec.exp > new Date())) tokenOk = true;
  }

  // Authorization path 2 — Clerk-authed staff or supplier user
  let staffOk = false;
  let supplierClerkOk = false;
  let backUrl = "/suppliers";
  if (!tokenOk) {
    const profile = await getOrCreateProfile();
    if (!profile) {
      // Direct visit with no token + no Clerk session — push to sign-in
      redirect(`/sign-in?redirect_url=/suppliers/rfq/${rfqId}`);
    }
    staffOk = canViewSuppliers(profile) || isAdmin(profile);
    if (!staffOk && isSupplierUser(profile)) {
      // Check this supplier (by email) is on the recipient list for this RFQ
      const [rec] = await db
        .select({ id: rfqRecipients.id })
        .from(rfqRecipients)
        .leftJoin(suppliers, eq(suppliers.id, rfqRecipients.supplierId))
        .where(
          sql`${rfqRecipients.rfqId} = ${rfqId}
            AND (
              LOWER(${rfqRecipients.inviteEmail}) = LOWER(${profile.email})
              OR LOWER(${suppliers.email}) = LOWER(${profile.email})
            )`,
        )
        .limit(1);
      supplierClerkOk = !!rec;
      backUrl = "/portal";
    }
    if (!staffOk && !supplierClerkOk) redirect("/");
  }

  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, rfqId))
    .orderBy(rfqItems.lineNo);

  // Pull every multi-attachment row keyed by line item so the print + view
  // can show product photos + multiple datasheets. Bucketed here on the
  // server so the client component doesn't re-fetch on every render.
  const itemIds = items.map((it) => it.id);
  const allAttachments = itemIds.length > 0
    ? await db
        .select()
        .from(rfqItemAttachments)
        .where(inArray(rfqItemAttachments.rfqItemId, itemIds))
        .orderBy(desc(rfqItemAttachments.createdAt))
    : [];
  const attachmentsByItem: Record<number, typeof allAttachments> = {};
  for (const a of allAttachments) {
    (attachmentsByItem[a.rfqItemId] ?? (attachmentsByItem[a.rfqItemId] = [])).push(a);
  }

  // Resolve the client logo (used as letterhead on the printed RFQ).
  // Tenant scoping isn't strict here yet — we pull the first client whose
  // name matches the deployment's CLIENT_CONFIG.name. Falls back to no
  // logo if nothing's been uploaded.
  const [clientRow] = await db
    .select({ logoUrl: clients.logoUrl, logoName: clients.logoName })
    .from(clients)
    .where(sql`LOWER(${clients.name}) = LOWER(${CLIENT_CONFIG.name})`)
    .limit(1);

  // Staff sees recipients list; suppliers do NOT (privacy — they shouldn't
  // see who else was invited).
  const showRecipients = staffOk;
  const recipients = showRecipients
    ? await db
        .select()
        .from(rfqRecipients)
        .where(eq(rfqRecipients.rfqId, rfqId))
    : [];
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  return (
    <div style={{ background: "var(--lb-bg)", minHeight: "100%", padding: 24 }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {!tokenOk && (
          <div style={{ fontSize: 13 }}>
            <Link
              href={backUrl}
              style={{ color: "var(--lb-text-3)", textDecoration: "none", fontWeight: 500 }}
            >
              ← {backUrl === "/portal" ? "Back to portal" : "Back to ERP"}
            </Link>
          </div>
        )}
        <RfqView
          rfq={rfq}
          items={items}
          attachmentsByItem={attachmentsByItem}
          clientLogoUrl={clientRow?.logoUrl ?? null}
          recipients={recipients.map((r) => ({
            ...r,
            portalUrl: `${base}/vendor/${r.accessToken}`,
          }))}
          clientName={CLIENT_CONFIG.name}
          canEdit={staffOk}
          showRecipients={showRecipients}
        />
      </div>
    </div>
  );
}
