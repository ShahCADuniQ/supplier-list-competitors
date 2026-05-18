import { CLIENT_CONFIG } from "@/lib/client-config";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { suppliers as suppliersTable } from "@/db/schema";
import { getVendorPortal } from "@/app/suppliers/rfq-actions";
import VendorPortal from "./VendorPortal";

// Public, no-auth vendor portal. The magic-link token in the URL identifies
// the supplier; everything inside is scoped to that one RFQ + recipient.
// No layout wrapping (no Sidebar / TopBar) so the supplier sees a clean
// branded page, not the internal employee shell.

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const portal = await getVendorPortal(token);
  return {
    title: portal
      ? `Quote · ${portal.rfq.rfqNumber} · ${CLIENT_CONFIG.name}`
      : `Vendor portal · ${CLIENT_CONFIG.name}`,
  };
}

export default async function VendorPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const portal = await getVendorPortal(token);
  if (!portal) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--lb-bg)",
          color: "var(--lb-text)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, marginBottom: 12 }}>Link expired or invalid</h1>
          <p style={{ color: "var(--lb-text-3)", fontSize: 14 }}>
            The magic link you used is no longer valid. Reach out to your
            Lightbase buyer for a new invite.
          </p>
        </div>
      </div>
    );
  }
  // Pull the supplier's stable home-portal token (if any) so the per-RFQ
  // page can show a "← My dashboard" link. Not all RFQs are tied to a
  // supplier_id, so the value is optional.
  let supplierHomeToken: string | null = null;
  if (portal.recipient.supplierId) {
    const [s] = await db
      .select({ portalToken: suppliersTable.portalToken })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, portal.recipient.supplierId))
      .limit(1);
    supplierHomeToken = s?.portalToken ?? null;
  }
  return (
    <VendorPortal
      token={token}
      portal={portal}
      clientName={CLIENT_CONFIG.name}
      supplierHomeToken={supplierHomeToken}
    />
  );
}
