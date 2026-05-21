"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { del } from "@vercel/blob";
import { isCanonicalCatId } from "./supplier-attachment-categories";
import { db } from "@/db";
import {
  suppliers,
  supplierProjectEntries,
  supplierComments,
  supplierAttachments,
  supplierContacts,
  type SupplierContact,
} from "@/db/schema";
import { requireSupplierEditor } from "@/lib/permissions";
import { ensureSupplierColumns } from "./_ensure-schema";

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
  manufacturingTypes?: string[];
  materials?: string[];
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

function cleanStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);
}

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
      manufacturingTypes: cleanStringArray(input.manufacturingTypes),
      materials: cleanStringArray(input.materials),
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
  if ("manufacturingTypes" in input) {
    updates.manufacturingTypes = cleanStringArray(input.manufacturingTypes);
  }
  if ("materials" in input) {
    updates.materials = cleanStringArray(input.materials);
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
  url: string;          // public Blob URL
  blobPathname: string; // returned from upload(), used for del() later
};

export async function addSupplierAttachment(
  supplierId: number,
  attachment: AttachmentInput,
) {
  const profile = await requireSupplierEditor();
  const name = cleanString(attachment.name);
  const catId = cleanString(attachment.catId);
  const url = cleanString(attachment.url);
  const blobPathname = cleanString(attachment.blobPathname);
  if (!name || !catId || !url || !blobPathname) {
    throw new Error("Attachment name, category, and uploaded URL are required");
  }

  await db.insert(supplierAttachments).values({
    supplierId,
    catId,
    name,
    size: attachment.size,
    mimeType: cleanString(attachment.mimeType),
    url,
    blobPathname,
    uploader: profile.displayName ?? profile.email,
    uploaderClerkId: profile.clerkUserId,
    date: new Date().toISOString().slice(0, 10),
  });
  revalidatePath("/suppliers");
}

export async function deleteSupplierAttachment(id: number) {
  await requireSupplierEditor();
  const [row] = await db
    .select()
    .from(supplierAttachments)
    .where(eq(supplierAttachments.id, id))
    .limit(1);
  if (row?.blobPathname) {
    try {
      // `del` accepts a pathname or full URL.
      await del(row.url);
    } catch (e) {
      // Don't block the DB delete if Blob cleanup fails — log and continue so
      // the user isn't stuck with a row they can't remove.
      console.error("Failed to remove blob", row.blobPathname, e);
    }
  }
  await db.delete(supplierAttachments).where(eq(supplierAttachments.id, id));
  revalidatePath("/suppliers");
}

// Bulk-delete every file in a CUSTOM section. Canonical sections are
// rejected server-side so the UI can't accidentally wipe a default
// bucket. Removes blobs first, then DB rows in one statement so the
// section disappears next render.
export async function deleteSupplierCustomSection(input: {
  supplierId: number;
  catId: string;
}): Promise<{ deleted: number }> {
  await requireSupplierEditor();
  const catId = input.catId.trim();
  if (!catId) throw new Error("Section is required");
  // Defense in depth: refuse to delete a default section even if a UI
  // bug or hand-crafted request tries to.
  if (isCanonicalCatId(catId)) {
    throw new Error("Default sections can't be deleted.");
  }
  const rows = await db
    .select({
      id: supplierAttachments.id,
      url: supplierAttachments.url,
      blobPathname: supplierAttachments.blobPathname,
    })
    .from(supplierAttachments)
    .where(
      and(
        eq(supplierAttachments.supplierId, input.supplierId),
        eq(supplierAttachments.catId, catId),
      ),
    );
  for (const r of rows) {
    if (r.blobPathname) {
      try { await del(r.url); } catch (e) {
        console.error("Failed to remove blob", r.blobPathname, e);
      }
    }
  }
  await db
    .delete(supplierAttachments)
    .where(
      and(
        eq(supplierAttachments.supplierId, input.supplierId),
        eq(supplierAttachments.catId, catId),
      ),
    );
  revalidatePath("/suppliers");
  return { deleted: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Star / unstar — toggles whether a supplier appears in the "Current
// suppliers" panel at the top of /suppliers. Pure write; no other side
// effects. Editors can flip; admins inherit edit access.
// ─────────────────────────────────────────────────────────────────────────────

export async function setSupplierStarred(input: {
  id: number;
  starred: boolean;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  await db
    .update(suppliers)
    .set({ isStarred: input.starred, updatedAt: new Date() })
    .where(eq(suppliers.id, input.id));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER CONTACTS — multi-POC management. The first contact added is
// auto-flipped to primary. setPrimary moves the flag (only one primary
// per supplier). Primary's email is mirrored back to suppliers.email so
// legacy queries that read suppliers.email keep working.
// ─────────────────────────────────────────────────────────────────────────────

export async function listSupplierContacts(supplierId: number): Promise<SupplierContact[]> {
  await ensureSupplierColumns();
  return db
    .select()
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, supplierId))
    .orderBy(supplierContacts.isPrimary, supplierContacts.createdAt);
}

export async function addSupplierContact(input: {
  supplierId: number;
  name?: string;
  email: string;
  phone?: string;
  role?: string;
  notes?: string;
}): Promise<{ id: number }> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const email = cleanString(input.email);
  if (!email || !email.includes("@")) throw new Error("Valid email is required");
  // First contact for a supplier becomes the primary automatically.
  const existing = await db
    .select({ id: supplierContacts.id })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, input.supplierId))
    .limit(1);
  const isPrimary = existing.length === 0;
  const [row] = await db
    .insert(supplierContacts)
    .values({
      supplierId: input.supplierId,
      name: cleanString(input.name),
      email,
      phone: cleanString(input.phone),
      role: cleanString(input.role),
      notes: cleanString(input.notes),
      isPrimary,
    })
    .returning();
  if (isPrimary) {
    // Mirror primary email back to suppliers.email for legacy compatibility.
    await db
      .update(suppliers)
      .set({ email, updatedAt: new Date() })
      .where(eq(suppliers.id, input.supplierId));
  }
  revalidatePath("/suppliers");
  revalidatePath("/admin");
  return { id: row.id };
}

export async function updateSupplierContact(input: {
  id: number;
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
  notes?: string;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const set: Partial<typeof supplierContacts.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = cleanString(input.name);
  if (input.email !== undefined) {
    const email = cleanString(input.email);
    if (!email || !email.includes("@")) throw new Error("Valid email is required");
    set.email = email;
  }
  if (input.phone !== undefined) set.phone = cleanString(input.phone);
  if (input.role !== undefined) set.role = cleanString(input.role);
  if (input.notes !== undefined) set.notes = cleanString(input.notes);
  const [row] = await db
    .update(supplierContacts)
    .set(set)
    .where(eq(supplierContacts.id, input.id))
    .returning();
  if (!row) throw new Error("Contact not found");
  // If this is the primary, mirror the new email back to suppliers.email
  if (row.isPrimary && input.email !== undefined) {
    await db
      .update(suppliers)
      .set({ email: row.email, updatedAt: new Date() })
      .where(eq(suppliers.id, row.supplierId));
  }
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

export async function setPrimarySupplierContact(contactId: number): Promise<void> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const [target] = await db
    .select()
    .from(supplierContacts)
    .where(eq(supplierContacts.id, contactId))
    .limit(1);
  if (!target) throw new Error("Contact not found");
  // Flip all contacts for this supplier to non-primary, then mark this one.
  await db
    .update(supplierContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(supplierContacts.supplierId, target.supplierId));
  await db
    .update(supplierContacts)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(eq(supplierContacts.id, contactId));
  // Mirror to suppliers.email for legacy queries.
  await db
    .update(suppliers)
    .set({ email: target.email, updatedAt: new Date() })
    .where(eq(suppliers.id, target.supplierId));
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

export async function deleteSupplierContact(contactId: number): Promise<void> {
  await requireSupplierEditor();
  await ensureSupplierColumns();
  const [target] = await db
    .select()
    .from(supplierContacts)
    .where(eq(supplierContacts.id, contactId))
    .limit(1);
  if (!target) return;
  await db.delete(supplierContacts).where(eq(supplierContacts.id, contactId));
  // If we just deleted the primary, promote the oldest remaining contact.
  if (target.isPrimary) {
    const [next] = await db
      .select()
      .from(supplierContacts)
      .where(eq(supplierContacts.supplierId, target.supplierId))
      .orderBy(supplierContacts.createdAt)
      .limit(1);
    if (next) {
      await db
        .update(supplierContacts)
        .set({ isPrimary: true })
        .where(eq(supplierContacts.id, next.id));
      await db
        .update(suppliers)
        .set({ email: next.email, updatedAt: new Date() })
        .where(eq(suppliers.id, target.supplierId));
    } else {
      // No remaining contacts — leave suppliers.email alone (might be
      // historical / pre-contact-table data).
    }
  }
  revalidatePath("/suppliers");
  revalidatePath("/admin");
}

// Used by the SupplierPicker so the buyer can see every POC of every
// supplier when staging RFQ invites.
export async function listAllSupplierContacts(): Promise<
  Array<SupplierContact & { supplierName: string }>
> {
  await ensureSupplierColumns();
  const rows = await db
    .select({
      c: supplierContacts,
      supplierName: suppliers.name,
    })
    .from(supplierContacts)
    .innerJoin(suppliers, eq(suppliers.id, supplierContacts.supplierId))
    .orderBy(suppliers.name, supplierContacts.isPrimary, supplierContacts.createdAt);
  return rows.map((r) => ({ ...r.c, supplierName: r.supplierName }));
}
