"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  suppliers,
  supplierProjectEntries,
  supplierComments,
  supplierAttachments,
} from "@/db/schema";
import { requireSupplierEditor } from "@/lib/permissions";

const SUPPLIER_KPI_KEYS = [
  "leadTime",
  "moq",
  "capacity",
  "paymentTerms",
  "currency",
  "incoterms",
  "risk",
  "backup",
  "insurance",
  "iso",
  "ul",
  "ce",
  "rohs",
  "nda",
  "msa",
] as const;

const SUPPLIER_BASE_KEYS = [
  "name",
  "category",
  "subCategory",
  "origin",
  "status",
  "website",
  "email",
  "phone",
  "contactName",
  "products",
  "source",
  "tested",
  "onboarded",
  "notes",
] as const;

type SupplierInput = {
  [K in (typeof SUPPLIER_BASE_KEYS)[number]]?: string | null;
} & {
  kpis?: Record<string, string>;
};

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function cleanDate(v: unknown): string | null {
  const s = cleanString(v);
  if (!s) return null;
  // Date inputs already arrive as ISO YYYY-MM-DD; pass straight through.
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suppliers
// ─────────────────────────────────────────────────────────────────────────────

export async function createSupplier(input: SupplierInput) {
  await requireSupplierEditor();
  const name = cleanString(input.name);
  if (!name) throw new Error("Supplier name is required");

  const kpis: Record<string, string> = {};
  if (input.kpis) {
    for (const k of SUPPLIER_KPI_KEYS) {
      const v = input.kpis[k];
      if (typeof v === "string" && v.trim()) kpis[k] = v.trim();
    }
  }

  const [row] = await db
    .insert(suppliers)
    .values({
      name,
      category: cleanString(input.category),
      subCategory: cleanString(input.subCategory),
      origin: cleanString(input.origin),
      status:
        input.status === "Historical" ? "Historical" : "Active",
      website: cleanString(input.website),
      email: cleanString(input.email),
      phone: cleanString(input.phone),
      contactName: cleanString(input.contactName),
      products: cleanString(input.products),
      source: cleanString(input.source),
      tested: cleanString(input.tested),
      onboarded: cleanDate(input.onboarded),
      notes: cleanString(input.notes),
      kpis,
    })
    .returning();

  revalidatePath("/suppliers");
  return row;
}

export async function updateSupplier(id: number, input: SupplierInput) {
  await requireSupplierEditor();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of SUPPLIER_BASE_KEYS) {
    if (key in input) {
      const raw = input[key];
      updates[key] = key === "onboarded" ? cleanDate(raw) : cleanString(raw);
    }
  }
  if (input.status === "Historical" || input.status === "Active") {
    updates.status = input.status;
  }
  if (input.kpis) {
    const kpis: Record<string, string> = {};
    for (const k of SUPPLIER_KPI_KEYS) {
      const v = input.kpis[k];
      if (typeof v === "string" && v.trim()) kpis[k] = v.trim();
    }
    updates.kpis = kpis;
  }

  await db.update(suppliers).set(updates).where(eq(suppliers.id, id));
  revalidatePath("/suppliers");
}

export async function deleteSupplier(id: number) {
  await requireSupplierEditor();
  await db.delete(suppliers).where(eq(suppliers.id, id));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// Project entries
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_STATUS = [
  "Quoted",
  "PO Issued",
  "In Production",
  "Shipped",
  "Delivered",
  "Closed",
  "Cancelled",
] as const;
type ProjectStatus = (typeof PROJECT_STATUS)[number];
function asProjectStatus(v: unknown): ProjectStatus {
  return PROJECT_STATUS.includes(v as ProjectStatus)
    ? (v as ProjectStatus)
    : "Quoted";
}

export type ProjectEntryInput = {
  id?: number;
  projectNum: string;
  poNumber?: string | null;
  status?: string;
  quoteDate?: string | null;
  poDate?: string | null;
  expectedDelivery?: string | null;
  actualDelivery?: string | null;
  quotedLeadTime?: number | string;
  actualLeadTime?: number | string;
  orderedQuantity?: number | string;
  deliveredQuantity?: number | string;
  defectiveQuantity?: number | string;
  returnedQuantity?: number | string;
  quotedAmount?: number | string;
  actualAmount?: number | string;
  currency?: string | null;
  incoterms?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
};

function asInt(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function asDecimal(v: unknown): string {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

export async function upsertProjectEntry(
  supplierId: number,
  entry: ProjectEntryInput,
) {
  await requireSupplierEditor();
  const projectNum = cleanString(entry.projectNum);
  if (!projectNum) throw new Error("Project # is required");

  const values = {
    supplierId,
    projectNum,
    poNumber: cleanString(entry.poNumber),
    status: asProjectStatus(entry.status),
    quoteDate: cleanDate(entry.quoteDate),
    poDate: cleanDate(entry.poDate),
    expectedDelivery: cleanDate(entry.expectedDelivery),
    actualDelivery: cleanDate(entry.actualDelivery),
    quotedLeadTime: asInt(entry.quotedLeadTime),
    actualLeadTime: asInt(entry.actualLeadTime),
    orderedQuantity: asInt(entry.orderedQuantity),
    deliveredQuantity: asInt(entry.deliveredQuantity),
    defectiveQuantity: asInt(entry.defectiveQuantity),
    returnedQuantity: asInt(entry.returnedQuantity),
    quotedAmount: asDecimal(entry.quotedAmount),
    actualAmount: asDecimal(entry.actualAmount),
    currency: cleanString(entry.currency) ?? "USD",
    incoterms: cleanString(entry.incoterms),
    paymentTerms: cleanString(entry.paymentTerms),
    notes: cleanString(entry.notes),
    updatedAt: new Date(),
  };

  if (entry.id) {
    await db
      .update(supplierProjectEntries)
      .set(values)
      .where(
        and(
          eq(supplierProjectEntries.id, entry.id),
          eq(supplierProjectEntries.supplierId, supplierId),
        ),
      );
  } else {
    await db.insert(supplierProjectEntries).values(values);
  }
  revalidatePath("/suppliers");
}

export async function deleteProjectEntry(id: number) {
  await requireSupplierEditor();
  await db.delete(supplierProjectEntries).where(eq(supplierProjectEntries.id, id));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────────

export async function addSupplierComment(
  supplierId: number,
  text: string,
  projectNum?: string | null,
  author?: string | null,
) {
  const profile = await requireSupplierEditor();
  const t = cleanString(text);
  if (!t) throw new Error("Comment text is required");

  await db.insert(supplierComments).values({
    supplierId,
    text: t,
    projectNum: cleanString(projectNum),
    author: cleanString(author) ?? profile.displayName ?? profile.email,
    authorClerkId: profile.clerkUserId,
    date: new Date().toISOString().slice(0, 10),
  });
  revalidatePath("/suppliers");
}

export async function deleteSupplierComment(id: number) {
  await requireSupplierEditor();
  await db.delete(supplierComments).where(eq(supplierComments.id, id));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────────────────────────────────────────

export type AttachmentInput = {
  catId: string;
  name: string;
  size: number;
  mimeType?: string | null;
  dataUrl: string; // base64 data URL of the file content
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB upload cap

export async function addSupplierAttachment(
  supplierId: number,
  attachment: AttachmentInput,
) {
  const profile = await requireSupplierEditor();
  const name = cleanString(attachment.name);
  const catId = cleanString(attachment.catId);
  const dataUrl = cleanString(attachment.dataUrl);
  if (!name || !catId || !dataUrl) {
    throw new Error("Attachment name, category, and content are required");
  }
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("File exceeds 8 MB upload limit");
  }

  await db.insert(supplierAttachments).values({
    supplierId,
    catId,
    name,
    size: attachment.size,
    mimeType: cleanString(attachment.mimeType),
    dataUrl,
    uploader: profile.displayName ?? profile.email,
    uploaderClerkId: profile.clerkUserId,
    date: new Date().toISOString().slice(0, 10),
  });
  revalidatePath("/suppliers");
}

export async function deleteSupplierAttachment(id: number) {
  await requireSupplierEditor();
  await db.delete(supplierAttachments).where(eq(supplierAttachments.id, id));
  revalidatePath("/suppliers");
}
