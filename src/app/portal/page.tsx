import { redirect } from "next/navigation";
import { eq, sql, desc, and, or } from "drizzle-orm";
import { db } from "@/db";
import {
  purchaseOrders,
  rfqRecipients,
  rfqs,
  suppliers,
  supplierContacts,
  supplierQuotes,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  isSupplierUser,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { ensureSupplierColumns } from "@/app/suppliers/_ensure-schema";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";
import PortalView from "./PortalView";

// Clerk-authenticated supplier dashboard. Renders the same UX as the
// magic-link /vendor/home/[token] page but identified by the signed-in
// user's email (matched against suppliers.email). This is the primary
// flow now — suppliers sign in to the same /sign-in URL as the team and
// land here automatically.

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Vendor Portal · ${CLIENT_CONFIG.name}`,
};

export default async function PortalPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  // Admins can browse the supplier portal for QA — handy for verifying
  // exactly what suppliers see. Internal employees who aren't admins are
  // bounced back to root (where they'd see the buyer dashboard).
  if (!isSupplierUser(profile) && !isAdmin(profile)) redirect("/");

  await ensureSupplierColumns();
  await ensureOrdersSchema();

  // Find the supplier record matching this user's email. We try both the
  // suppliers.email column AND every supplier_contacts.email — many real
  // suppliers have multiple contacts, and the signed-in user may have
  // been invited via a non-primary contact email, so a strict suppliers.email
  // match would miss them.
  const profileEmailLc = (profile.email ?? "").toLowerCase();
  let supplier: typeof suppliers.$inferSelect | undefined;
  if (profileEmailLc) {
    [supplier] = await db
      .select()
      .from(suppliers)
      .where(sql`LOWER(${suppliers.email}) = ${profileEmailLc}`)
      .limit(1);
    if (!supplier) {
      const [contact] = await db
        .select({ supplierId: supplierContacts.supplierId })
        .from(supplierContacts)
        .where(sql`LOWER(${supplierContacts.email}) = ${profileEmailLc}`)
        .limit(1);
      if (contact) {
        [supplier] = await db
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, contact.supplierId))
          .limit(1);
      }
    }
  }
  if (!supplier) {
    return (
      <div
        style={{
          minHeight: "70vh",
          display: "grid",
          placeItems: "center",
          padding: 32,
          color: "var(--lb-text)",
          fontFamily: "system-ui",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Your supplier record is missing</h1>
          <p style={{ color: "var(--lb-text-3)", fontSize: 13.5 }}>
            Your account is flagged as a supplier but we can't find your
            company in the {CLIENT_CONFIG.name} suppliers directory. Reach
            out to your buyer to get re-linked.
          </p>
        </div>
      </div>
    );
  }

  // Gather every email tied to this supplier so an invite that went to ANY
  // contact (not just the primary suppliers.email) still shows up here.
  const contactRows = await db
    .select({ email: supplierContacts.email })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, supplier.id));
  const allEmails = new Set<string>();
  if (supplier.email) allEmails.add(supplier.email.toLowerCase());
  for (const c of contactRows) if (c.email) allEmails.add(c.email.toLowerCase());
  const emailList = Array.from(allEmails);

  // Pull every invite for this supplier — by FK link OR by email match
  // (covers RFQs sent by email before the supplier row was created).
  const rows = await db
    .select({ recipient: rfqRecipients, rfq: rfqs, quote: supplierQuotes })
    .from(rfqRecipients)
    .innerJoin(rfqs, eq(rfqs.id, rfqRecipients.rfqId))
    .leftJoin(
      supplierQuotes,
      and(
        eq(supplierQuotes.recipientId, rfqRecipients.id),
        eq(supplierQuotes.rfqId, rfqs.id),
      ),
    )
    .where(
      emailList.length > 0
        ? sql`${rfqRecipients.supplierId} = ${supplier.id} OR LOWER(${rfqRecipients.inviteEmail}) IN (${sql.join(
            emailList.map((e) => sql`${e}`),
            sql`, `,
          )})`
        : eq(rfqRecipients.supplierId, supplier.id),
    )
    .orderBy(desc(rfqRecipients.invitedAt));

  // Awarded POs for this supplier — every PO where supplier_id matches OR
  // the supplier name matches (covers legacy POs created before FKs were
  // back-filled) OR the PO is linked to an RFQ whose recipient was invited
  // by this contact's email (covers POs whose quote was created from a
  // recipient invited before the supplier_id back-fill).
  const poRows = await db
    .selectDistinct({ po: purchaseOrders })
    .from(purchaseOrders)
    .leftJoin(rfqRecipients, eq(rfqRecipients.rfqId, purchaseOrders.rfqId))
    .where(
      or(
        eq(purchaseOrders.supplierId, supplier.id),
        sql`LOWER(${purchaseOrders.supplierName}) = LOWER(${supplier.name})`,
        eq(rfqRecipients.supplierId, supplier.id),
        emailList.length > 0
          ? sql`LOWER(${rfqRecipients.inviteEmail}) IN (${sql.join(
              emailList.map((e) => sql`${e}`),
              sql`, `,
            )})`
          : sql`false`,
      ),
    )
    .orderBy(desc(purchaseOrders.createdAt));

  return (
    <PortalView
      clientName={CLIENT_CONFIG.name}
      supplier={{
        id: supplier.id,
        name: supplier.name,
        email: supplier.email,
        contactName: supplier.contactName,
        logoUrl: supplier.logoUrl ?? null,
        logoName: supplier.logoName ?? null,
      }}
      invites={rows.map((r) => ({
        recipientId: r.recipient.id,
        rfqId: r.rfq.id,
        rfqNumber: r.rfq.rfqNumber,
        rfqStatus: r.rfq.status,
        rfqStage: r.rfq.stage,
        projectNum: r.rfq.projectNum,
        projectName: r.rfq.projectName,
        niche: r.rfq.niche,
        transportMode: r.rfq.transportMode,
        currency: r.rfq.targetCurrency,
        quoteDeadline: r.rfq.quoteDeadline,
        invitedAt: r.recipient.invitedAt,
        recipientStatus: r.recipient.status,
        accessToken: r.recipient.accessToken,
        tokenExpiresAt: r.recipient.tokenExpiresAt,
        quoteStatus: r.quote?.status ?? null,
      }))}
      pos={poRows.map(({ po: p }) => ({
        id: p.id,
        poNumber: p.poNumber,
        projectNum: p.projectNum,
        projectName: p.projectName,
        currency: p.currency,
        totalAmount: Number(p.totalAmount),
        status: p.status,
        createdAt: p.createdAt,
      }))}
      isAdminPreview={!isSupplierUser(profile) && isAdmin(profile)}
    />
  );
}
