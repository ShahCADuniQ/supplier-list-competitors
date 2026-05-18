// Excel export for an RFQ — mirrors the buyer's template (image 1) so
// the spreadsheet downloads in the same shape the team sent out before
// the platform existed. Staff-only.

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/db";
import { rfqItems, rfqs } from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  canViewSuppliers,
} from "@/lib/permissions";
import { TRANSPORT_MODE_META } from "@/app/suppliers/_orders-constants";

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
  if (!canViewSuppliers(profile) && !isAdmin(profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [rfq] = await db
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, id))
    .limit(1);
  if (!rfq) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const items = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, id))
    .orderBy(rfqItems.lineNo);

  const tm = TRANSPORT_MODE_META[rfq.transportMode].label;

  const aoa: Array<Array<string | number | null>> = [
    ["LIGHTBASE", "", "", "REQUEST FOR QUOTATION", "", "", "", "", ""],
    [
      "10871 Avenue Salk, Montreal (QC) Canada, H1G 6M7",
      "",
      "",
      "(Demande de prix)",
      "",
      "",
      "",
      "",
      "",
    ],
    [
      "Tel +1.514.600.5140 · info@lightbase.ca",
      "",
      "",
      "RFQ Number",
      rfq.rfqNumber,
      "",
      "",
      "",
      "",
    ],
    [
      "GST/HST: 737875302RT0001",
      "",
      "",
      "Project number",
      rfq.projectNum,
      "",
      "",
      "",
      "",
    ],
    [
      "QST: 1228299711TQ0001",
      "",
      "",
      "Project name",
      rfq.projectName ?? "",
      "",
      "",
      "",
      "",
    ],
    [
      "",
      "",
      "",
      "Niche",
      rfq.niche ?? "",
      "",
      "",
      "",
      "",
    ],
    [
      "",
      "",
      "",
      "Currency",
      rfq.targetCurrency,
      "",
      "Incoterms",
      rfq.incoterms ?? "",
      "",
    ],
    [
      "",
      "",
      "",
      "Transport preference",
      tm,
      "",
      "Deadline",
      rfq.quoteDeadline
        ? new Date(rfq.quoteDeadline).toLocaleDateString()
        : "",
      "",
    ],
    [
      "",
      "",
      "",
      "Stage",
      rfq.stage,
      "",
      "Status",
      rfq.status,
      "",
    ],
    [],
    [
      "CLIENT REF.",
      "PRODUCT CODE",
      "PRODUCT URL",
      "SPECIFICATIONS",
      "QTY",
      "SECURITY STOCK",
      "TOTAL QTY",
      "TARGET PRICE",
      "NOTES",
    ],
  ];

  for (const it of items) {
    aoa.push([
      it.clientRef ?? "",
      it.productCode ?? "",
      it.productUrl ?? "",
      `${it.description}${it.specifications ? ` — ${it.specifications}` : ""}`,
      it.qty,
      it.securityStock,
      it.qty + it.securityStock,
      it.targetUnitPrice != null ? Number(it.targetUnitPrice) : "",
      it.notes ?? "",
    ]);
  }

  if (rfq.notes) {
    aoa.push([], ["NOTES", rfq.notes, "", "", "", "", "", "", ""]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 28 },
    { wch: 40 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 24 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "RFQ");
  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${rfq.rfqNumber}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
