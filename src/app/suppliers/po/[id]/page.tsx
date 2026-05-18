import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  poInvoices,
  poPaymentMethods,
  poPayments,
  poTimeline,
  purchaseOrderLines,
  purchaseOrders,
  suppliers,
  supplierContacts,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  isAdmin,
  isSupplierUser,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";
import PoView from "./PoView";

// The PO page serves both buyer + the awarded supplier. Auth rule:
//   • staff (canViewSuppliers OR admin) — full access to every PO
//   • supplier user — only their OWN PO (matched by suppliers.email)
// Cleaner than gating on `canViewSuppliers` alone (which suppliers don't have).

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [po] = await db
    .select({ poNumber: purchaseOrders.poNumber })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, Number(id)))
    .limit(1);
  return {
    title: po
      ? `PO ${po.poNumber} · ${CLIENT_CONFIG.name}`
      : `Purchase Order · ${CLIENT_CONFIG.name}`,
  };
}

export default async function PoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  const { id } = await params;
  const poId = Number(id);
  if (!Number.isFinite(poId)) notFound();

  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) notFound();

  // Authorize: staff sees everything; a supplier user only sees their own.
  // Supplier match also tries every supplier_contacts.email so a contact
  // signing in (not the primary email) still gets through.
  const staffOk = canViewSuppliers(profile) || isAdmin(profile);
  let supplierOk = false;
  if (!staffOk && isSupplierUser(profile) && po.supplierId) {
    const profileEmailLc = profile.email.toLowerCase();
    const [s] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .leftJoin(supplierContacts, eq(supplierContacts.supplierId, suppliers.id))
      .where(
        sql`${suppliers.id} = ${po.supplierId} AND (LOWER(${suppliers.email}) = ${profileEmailLc} OR LOWER(${supplierContacts.email}) = ${profileEmailLc})`,
      )
      .limit(1);
    supplierOk = !!s;
  }
  if (!staffOk && !supplierOk) redirect("/");

  await ensureOrdersSchema();

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.poId, poId))
    .orderBy(purchaseOrderLines.lineNo);

  // Tracker bundle — payment method, invoices, payments, production timeline.
  // Pulled here on the server so the first render is hydrated; the client
  // component re-fetches via the server actions when the user mutates.
  const [paymentMethod] = await db
    .select()
    .from(poPaymentMethods)
    .where(eq(poPaymentMethods.poId, poId))
    .orderBy(desc(poPaymentMethods.postedAt))
    .limit(1);
  const invoices = await db
    .select()
    .from(poInvoices)
    .where(eq(poInvoices.poId, poId))
    .orderBy(desc(poInvoices.createdAt));
  const payments = await db
    .select()
    .from(poPayments)
    .where(eq(poPayments.poId, poId))
    .orderBy(desc(poPayments.paidOn));
  const timeline = await db
    .select()
    .from(poTimeline)
    .where(eq(poTimeline.poId, poId))
    .orderBy(desc(poTimeline.postedAt));

  // Letterhead logos — buyer's client logo + this PO's supplier logo.
  const [clientRow] = await db
    .select({ logoUrl: clients.logoUrl })
    .from(clients)
    .where(sql`LOWER(${clients.name}) = LOWER(${CLIENT_CONFIG.name})`)
    .limit(1);
  const supplierLogoRow = po.supplierId
    ? (await db
        .select({ logoUrl: suppliers.logoUrl })
        .from(suppliers)
        .where(eq(suppliers.id, po.supplierId))
        .limit(1))[0]
    : null;

  // Either party is "the supplier" or "the buyer" for this PO. Buyer staff
  // editing on behalf of the supplier counts as buyer here — but the tracker
  // component still allows them to use supplier-side forms (enforced server-
  // side). The role flag below just sets the default UX for new posts.
  const viewerRole: "buyer" | "supplier" = supplierOk ? "supplier" : "buyer";

  return (
    <div style={{ background: "var(--lb-bg)", minHeight: "100%", padding: 24 }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13 }}>
          <Link
            href={supplierOk ? "/portal" : "/suppliers"}
            style={{ color: "var(--lb-text-3)", textDecoration: "none", fontWeight: 500 }}
          >
            ← {supplierOk ? "Back to portal" : "Back to ERP"}
          </Link>
        </div>
        <PoView
          po={po}
          lines={lines}
          clientName={CLIENT_CONFIG.name}
          viewerRole={viewerRole}
          clientLogoUrl={clientRow?.logoUrl ?? null}
          supplierLogoUrl={supplierLogoRow?.logoUrl ?? null}
          tracker={{
            paymentMethod: paymentMethod ?? null,
            invoices,
            payments,
            timeline,
          }}
        />
      </div>
    </div>
  );
}
