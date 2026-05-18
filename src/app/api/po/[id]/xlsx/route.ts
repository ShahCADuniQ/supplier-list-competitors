// Excel export for a Purchase Order. Built from the structured DB record
// (purchase_orders + purchase_order_lines) — mirrors the visible PO HTML
// at /suppliers/po/[id] so the spreadsheet matches what the buyer sees on
// screen. Same XLSX is downloadable from either the buyer-side PO page
// or the supplier's portal once they're awarded.

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/db";
import {
  purchaseOrderLines,
  purchaseOrders,
  rfqRecipients,
  suppliers,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  canViewSuppliers,
  isSupplierUser,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const profile = await getOrCreateProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .limit(1);
  if (!po) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Auth: internal staff with supplier view OR the supplier whose row
  // matches the PO's supplier_id. Supplier accounts can only download
  // their own POs.
  const staffOk = canViewSuppliers(profile) || isAdmin(profile);
  let supplierOk = false;
  if (isSupplierUser(profile) && po.supplierId) {
    const [s] = await db
      .select({ email: suppliers.email })
      .from(suppliers)
      .where(eq(suppliers.id, po.supplierId))
      .limit(1);
    supplierOk = !!s?.email && s.email.toLowerCase() === profile.email.toLowerCase();
  }
  if (!staffOk && !supplierOk) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.poId, id))
    .orderBy(purchaseOrderLines.lineNo);

  // Header block — mirrors the buyer's "PURCHASE ORDER (Bon de commande)"
  // template. Spread across two top sections so the spreadsheet reads like
  // the printed PDF.
  const headerRows: Array<Array<string | number | null>> = [
    ["LIGHTBASE", "", "", "", "", ""],
    [
      "10871 Avenue Salk, Montreal (QC) Canada, H1G 6M7",
      "",
      "",
      "PURCHASE ORDER",
      "",
      "",
    ],
    [
      "Tel +1.514.600.5140 · info@lightbase.ca",
      "",
      "",
      "(Bon de commande)",
      "",
      "",
    ],
    [
      "GST/HST: 737875302RT0001",
      "",
      "",
      "PO Number",
      po.poNumber,
      "",
    ],
    [
      "QST: 1228299711TQ0001",
      "",
      "",
      "Project reference",
      po.projectNum,
      "",
    ],
    [
      "",
      "",
      "",
      "Proposition reference",
      po.propositionReference ?? "",
      "",
    ],
    [
      "",
      "",
      "",
      "Creation date",
      new Date(po.createdAt).toLocaleDateString(),
      "",
    ],
    [],
    [
      "Supplier",
      po.supplierName,
      "",
      "Status",
      po.status,
      "",
    ],
    [
      "Billing address",
      (po.billingAddress ?? "").replace(/\n/g, " · "),
      "",
      "Currency",
      po.currency,
      "",
    ],
    [
      "Shipping address",
      (po.shippingAddress ?? "").replace(/\n/g, " · "),
      "",
      "Incoterms",
      po.incoterms ?? "",
      "",
    ],
    [
      "",
      "",
      "",
      "Transport",
      po.transportMode,
      "",
    ],
    [],
    ["REF", "Description", "Quantité (QTY)", "Unit price", "Total", ""],
  ];

  const sub = Number(po.subtotal);
  const disc = Number(po.discountAmount);
  const tax = Number(po.taxAmount);
  const total = Number(po.totalAmount);

  const lineRows = lines.map((l) => [
    l.ref ?? "",
    l.description,
    l.qty,
    Number(l.unitPrice),
    Number(l.totalPrice),
    "",
  ]);

  const totalsRows: Array<Array<string | number | null>> = [
    [],
    ["", "", "", "PO amount (Montant du PO)", sub, ""],
    ["", "", "", "Discount amount (Montant du rabais)", disc, ""],
    ["", "", "", "Amount after discount", sub - disc, ""],
    ["", "", "", "Shipping / tax (Frais d'expédition)", tax, ""],
    ["", "", "", "AMOUNT WITH TAXES (Montant avec taxes)", total, ""],
  ];

  const aoa: Array<Array<string | number | null>> = [
    ...headerRows,
    ...lineRows,
    ...totalsRows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 18 },
    { wch: 42 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 4 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PO");
  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${po.poNumber}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

void rfqRecipients; // imported for future "include RFQ context" sheet
