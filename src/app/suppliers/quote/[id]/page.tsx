import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  inventoryItems,
  rfqItemAttachments,
  rfqItems,
  rfqs,
  suppliers,
  supplierContacts,
  supplierQuoteLines,
  supplierQuotes,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  isAdmin,
  isSupplierUser,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import QuoteView from "./QuoteView";

// Always-available quote view. Mirrors PoPage in two ways:
//   • If the supplier uploaded a quote PDF (source_pdf_url) it's embedded
//     so the buyer sees exactly what was sent. Otherwise the structured
//     fields render as a print-friendly document.
//   • Auth: staff (any supplier-viewer) OR the supplier whose row matches
//     the quote's supplier_id (read-only).

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [q] = await db
    .select({ companyName: supplierQuotes.companyName, rfqId: supplierQuotes.rfqId })
    .from(supplierQuotes)
    .where(eq(supplierQuotes.id, Number(id)))
    .limit(1);
  return {
    title: q
      ? `${q.companyName} · Quote · ${CLIENT_CONFIG.name}`
      : `Quote · ${CLIENT_CONFIG.name}`,
  };
}

export default async function QuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  const { id } = await params;
  const quoteId = Number(id);
  if (!Number.isFinite(quoteId)) notFound();

  const [quote] = await db
    .select()
    .from(supplierQuotes)
    .where(eq(supplierQuotes.id, quoteId))
    .limit(1);
  if (!quote) notFound();

  // Auth: staff or the awarded supplier. Supplier match tries primary email
  // AND every supplier_contacts.email so a contact signing in works.
  const staffOk = canViewSuppliers(profile) || isAdmin(profile);
  let supplierOk = false;
  if (!staffOk && isSupplierUser(profile) && quote.supplierId) {
    const profileEmailLc = profile.email.toLowerCase();
    const [s] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .leftJoin(supplierContacts, eq(supplierContacts.supplierId, suppliers.id))
      .where(
        sql`${suppliers.id} = ${quote.supplierId} AND (LOWER(${suppliers.email}) = ${profileEmailLc} OR LOWER(${supplierContacts.email}) = ${profileEmailLc})`,
      )
      .limit(1);
    supplierOk = !!s;
  }
  if (!staffOk && !supplierOk) redirect("/");

  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, quote.rfqId))
    .limit(1);
  if (!rfq) notFound();

  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, quote.rfqId))
    .orderBy(rfqItems.lineNo);

  const lines = await db
    .select()
    .from(supplierQuoteLines)
    .where(eq(supplierQuoteLines.quoteId, quoteId));

  // Pull the supplier's brand mark (for letterhead) + client brand mark
  // (for the "FOR" block) + RFQ line-item photos (for the print).
  const supplierLogoRow = quote.supplierId
    ? (await db
        .select({ logoUrl: suppliers.logoUrl })
        .from(suppliers)
        .where(eq(suppliers.id, quote.supplierId))
        .limit(1))[0]
    : null;
  const [clientRow] = await db
    .select({ logoUrl: clients.logoUrl })
    .from(clients)
    .where(sql`LOWER(${clients.name}) = LOWER(${CLIENT_CONFIG.name})`)
    .limit(1);
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

  // Same inventory-properties join as RfqView so the quote prints with
  // WEIGHT / SURFACE AREA / VOLUME columns matching the original RFQ.
  const inventoryIds = items
    .map((it) => it.inventoryItemId)
    .filter((id): id is number => id != null);
  const invRows = inventoryIds.length > 0
    ? await db
        .select({
          id: inventoryItems.id,
          weightG: inventoryItems.weightG,
          surfaceAreaMm2: inventoryItems.surfaceAreaMm2,
          volumeMm3: inventoryItems.volumeMm3,
          material: inventoryItems.material,
        })
        .from(inventoryItems)
        .where(inArray(inventoryItems.id, inventoryIds))
    : [];
  const inventoryByItemId: Record<number, (typeof invRows)[number]> = {};
  for (const r of invRows) inventoryByItemId[r.id] = r;

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
        <QuoteView
          quote={quote}
          rfq={rfq}
          items={items}
          lines={lines}
          attachmentsByItem={attachmentsByItem}
          inventoryByItemId={inventoryByItemId}
          supplierLogoUrl={supplierLogoRow?.logoUrl ?? null}
          clientLogoUrl={clientRow?.logoUrl ?? null}
          clientName={CLIENT_CONFIG.name}
        />
      </div>
    </div>
  );
}
