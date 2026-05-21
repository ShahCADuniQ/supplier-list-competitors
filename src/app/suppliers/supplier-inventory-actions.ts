"use server";

// Server actions for the Supplier Inventory tab — each supplier maintains
// their own product catalog (separate from Lightbase's `inventory_items`).
// Both Lightbase admins and the supplier themselves can create + edit;
// audit trail tracks who did what via `created_by_role` / `uploaded_by_role`.

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { del } from "@vercel/blob";

import { db } from "@/db";
import {
  suppliers,
  supplierContacts,
  supplierProducts,
  supplierProductAttachments,
  type SupplierProduct,
  type SupplierProductAttachment,
} from "@/db/schema";
import {
  canViewSuppliers,
  getOrCreateProfile,
  isSupplierUser,
  requireSupplierAccess,
} from "@/lib/permissions";
import type { UserProfile } from "@/db/schema";
import { ensureSupplierInventorySchema } from "./_ensure-supplier-inventory-schema";
import {
  SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES,
  type SupplierProductAttachmentCategory,
} from "./supplier-inventory-constants";

// Same auth flow as @/lib/permissions:requireSupplierAccess, scoped to a product id. Looks up the product's supplier
// then delegates to requireSupplierAccess.
async function requireProductAccess(productId: number): Promise<{
  profile: UserProfile;
  role: "lightbase" | "supplier";
  supplierId: number;
}> {
  await ensureSupplierInventorySchema();
  const [row] = await db
    .select({ supplierId: supplierProducts.supplierId })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, productId))
    .limit(1);
  if (!row) throw new Error("Product not found");
  const access = await requireSupplierAccess(row.supplierId);
  return { ...access, supplierId: row.supplierId };
}

// Read-side gate: admins + supplier-self. Returns the role so the UI can
// hide admin-only chrome from the supplier view.
async function resolveReadAccess(supplierId: number): Promise<{
  profile: UserProfile;
  role: "lightbase" | "supplier";
}> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (canViewSuppliers(profile)) return { profile, role: "lightbase" };
  if (isSupplierUser(profile) && profile.email) {
    const emailLc = profile.email.toLowerCase();
    const [match] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .leftJoin(supplierContacts, eq(supplierContacts.supplierId, suppliers.id))
      .where(
        and(
          eq(suppliers.id, supplierId),
          or(
            sql`LOWER(${suppliers.email}) = ${emailLc}`,
            sql`LOWER(${supplierContacts.email}) = ${emailLc}`,
          ),
        ),
      )
      .limit(1);
    if (match) return { profile, role: "supplier" };
  }
  throw new Error("Unauthorized: cannot view this supplier's catalog");
}

// ─────────────────────────────────────────────────────────────────────────────
// READS
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierWithProductCount = {
  id: number;
  name: string;
  category: string | null;
  logoUrl: string | null;
  productCount: number;
  attachmentCount: number;
  // Most recent upload across this supplier's whole catalog — drives the
  // "Last activity" column on the supplier list.
  lastUploadAt: Date | null;
};

// Top-level list shown when you click the Supplier Inventory tab — every
// supplier with at least one product, plus their counts. Suppliers with
// ZERO products are excluded so the list doesn't drown the user; admins
// can still add a supplier via the "Add product" flow which auto-creates
// the supplier-product relationship.
export async function listSuppliersWithCatalog(): Promise<SupplierWithProductCount[]> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile)) {
    throw new Error("Unauthorized: cannot view supplier catalogs");
  }
  await ensureSupplierInventorySchema();

  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      category: suppliers.category,
      logoUrl: suppliers.logoUrl,
      productCount: sql<number>`COUNT(DISTINCT ${supplierProducts.id})::int`,
      attachmentCount: sql<number>`COUNT(${supplierProductAttachments.id})::int`,
      lastUploadAt: sql<Date | null>`MAX(${supplierProductAttachments.uploadedAt})`,
    })
    .from(suppliers)
    .innerJoin(supplierProducts, eq(supplierProducts.supplierId, suppliers.id))
    .leftJoin(
      supplierProductAttachments,
      eq(supplierProductAttachments.productId, supplierProducts.id),
    )
    .where(eq(supplierProducts.archived, false))
    .groupBy(suppliers.id, suppliers.name, suppliers.category, suppliers.logoUrl)
    .orderBy(suppliers.name);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    logoUrl: r.logoUrl,
    productCount: Number(r.productCount ?? 0),
    attachmentCount: Number(r.attachmentCount ?? 0),
    lastUploadAt: r.lastUploadAt ? new Date(r.lastUploadAt) : null,
  }));
}

export type SupplierProductWithAttachments = SupplierProduct & {
  supplierName: string;
  attachments: SupplierProductAttachment[];
  // Pre-computed per-category counts so the card view doesn't have to
  // group the attachments array in the browser.
  attachmentCountByCategory: Record<SupplierProductAttachmentCategory, number>;
};

// Every product belonging to one supplier, with all attachments inlined.
export async function listSupplierProducts(input: {
  supplierId: number;
}): Promise<SupplierProductWithAttachments[]> {
  await resolveReadAccess(input.supplierId);
  await ensureSupplierInventorySchema();

  const [supplier] = await db
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!supplier) return [];

  const products = await db
    .select()
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, input.supplierId),
        eq(supplierProducts.archived, false),
      ),
    )
    .orderBy(desc(supplierProducts.createdAt));
  if (products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const attachments = await db
    .select()
    .from(supplierProductAttachments)
    .where(inArray(supplierProductAttachments.productId, productIds))
    .orderBy(desc(supplierProductAttachments.uploadedAt));

  const byProduct = new Map<number, SupplierProductAttachment[]>();
  for (const a of attachments) {
    const list = byProduct.get(a.productId) ?? [];
    list.push(a);
    byProduct.set(a.productId, list);
  }

  return products.map((p) => {
    const list = byProduct.get(p.id) ?? [];
    const counts = Object.fromEntries(
      SUPPLIER_PRODUCT_ATTACHMENT_CATEGORIES.map((c) => [c.key, 0]),
    ) as Record<SupplierProductAttachmentCategory, number>;
    for (const a of list) {
      const key = a.category as SupplierProductAttachmentCategory;
      if (counts[key] !== undefined) counts[key] += 1;
    }
    return {
      ...p,
      supplierName: supplier.name,
      attachments: list,
      attachmentCountByCategory: counts,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES — CRUD on products
// ─────────────────────────────────────────────────────────────────────────────

export async function createSupplierProduct(input: {
  supplierId: number;
  name: string;
  productCode?: string;
  description?: string;
  category?: string;
  notes?: string;
  thumbnailUrl?: string;
  thumbnailPathname?: string;
  // Reserved — the server overrides this with the auth-resolved role so
  // the supplier can't pass createdByRole: "lightbase" to forge an audit
  // entry. Field is kept on the type for API symmetry.
  createdByRole?: "lightbase" | "supplier";
}): Promise<{ id: number }> {
  const { profile, role } = await requireSupplierAccess(input.supplierId);
  await ensureSupplierInventorySchema();
  if (!input.name.trim()) throw new Error("Product name is required");

  const [row] = await db
    .insert(supplierProducts)
    .values({
      supplierId: input.supplierId,
      name: input.name.trim(),
      productCode: input.productCode?.trim() || null,
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      notes: input.notes?.trim() || null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      thumbnailPathname: input.thumbnailPathname ?? null,
      createdByRole: role,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: supplierProducts.id });

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { id: row.id };
}

export async function updateSupplierProduct(input: {
  id: number;
  name?: string;
  productCode?: string | null;
  description?: string | null;
  category?: string | null;
  notes?: string | null;
  thumbnailUrl?: string | null;
  thumbnailPathname?: string | null;
}): Promise<void> {
  await requireProductAccess(input.id);
  await ensureSupplierInventorySchema();

  const patch: Partial<typeof supplierProducts.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("Product name cannot be empty");
    patch.name = input.name.trim();
  }
  if (input.productCode !== undefined) patch.productCode = input.productCode?.trim() || null;
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.category !== undefined) patch.category = input.category?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.thumbnailUrl !== undefined) patch.thumbnailUrl = input.thumbnailUrl;
  if (input.thumbnailPathname !== undefined) patch.thumbnailPathname = input.thumbnailPathname;

  await db.update(supplierProducts).set(patch).where(eq(supplierProducts.id, input.id));
  revalidatePath("/suppliers");
}

export async function deleteSupplierProduct(input: { id: number }): Promise<void> {
  await requireProductAccess(input.id);
  await ensureSupplierInventorySchema();

  // Pull every attachment's blob_pathname so we can free Vercel Blob
  // storage before deleting the rows. ON DELETE CASCADE handles the DB
  // side automatically.
  const attachments = await db
    .select({ pathname: supplierProductAttachments.blobPathname })
    .from(supplierProductAttachments)
    .where(eq(supplierProductAttachments.productId, input.id));
  for (const a of attachments) {
    if (a.pathname) {
      try { await del(a.pathname); } catch { /* tolerate missing blobs */ }
    }
  }

  await db.delete(supplierProducts).where(eq(supplierProducts.id, input.id));
  revalidatePath("/suppliers");
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES — attachments per category
// ─────────────────────────────────────────────────────────────────────────────

export async function addSupplierProductAttachment(input: {
  productId: number;
  // Accept the broader DB-level category (the postgres enum) so callers
  // can pass "other_file" for custom-section uploads. The narrowed
  // SupplierProductAttachmentCategory excludes "other_file" since that
  // value never renders as a fixed rail entry anymore.
  category: SupplierProductAttachmentCategory | "other_file";
  // Free-text section name. Only meaningful when category === "other_file".
  // When set, the row is grouped under this label in the drawer's
  // "custom sections" area.
  customCategoryLabel?: string | null;
  name: string;
  url: string;
  blobPathname?: string;
  contentType?: string;
  size?: number;
  notes?: string;
  // Reserved — overridden server-side from the auth-resolved role.
  uploadedByRole?: "lightbase" | "supplier";
}): Promise<{ id: number; uploadedAt: Date }> {
  const { profile, role } = await requireProductAccess(input.productId);
  await ensureSupplierInventorySchema();
  if (!input.name.trim()) throw new Error("File name is required");

  const customLabel =
    input.category === "other_file" && input.customCategoryLabel
      ? input.customCategoryLabel.trim().slice(0, 80) || null
      : null;
  if (input.category === "other_file" && !customLabel) {
    throw new Error("A custom section name is required for this upload.");
  }

  const [row] = await db
    .insert(supplierProductAttachments)
    .values({
      productId: input.productId,
      category: input.category,
      customCategoryLabel: customLabel,
      name: input.name.trim(),
      url: input.url,
      blobPathname: input.blobPathname ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? 0,
      notes: input.notes?.trim() || null,
      uploadedByRole: role,
      uploadedByClerkId: profile.clerkUserId,
    })
    .returning({
      id: supplierProductAttachments.id,
      uploadedAt: supplierProductAttachments.uploadedAt,
    });

  // Convenience: if THIS upload is a photo AND the product has no cover
  // image yet, set this as the cover automatically. The supplier can pick
  // a different one via the "Set as cover" button later.
  if (input.category === "photo_media") {
    const [product] = await db
      .select({ thumbnailUrl: supplierProducts.thumbnailUrl })
      .from(supplierProducts)
      .where(eq(supplierProducts.id, input.productId))
      .limit(1);
    if (product && !product.thumbnailUrl) {
      await db
        .update(supplierProducts)
        .set({
          thumbnailUrl: input.url,
          thumbnailPathname: input.blobPathname ?? null,
        })
        .where(eq(supplierProducts.id, input.productId));
    }
  }

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { id: row.id, uploadedAt: row.uploadedAt };
}

// Edit the comment / file name on an existing attachment. The blob itself
// isn't replaced — to swap the file the supplier should delete + re-upload.
// Auth flow: same as deleteSupplierProductAttachment (resolve product →
// supplier → admin-or-self).
export async function updateSupplierProductAttachment(input: {
  id: number;
  notes?: string | null;
  name?: string;
}): Promise<void> {
  await ensureSupplierInventorySchema();
  const [row] = await db
    .select({ productId: supplierProductAttachments.productId })
    .from(supplierProductAttachments)
    .where(eq(supplierProductAttachments.id, input.id))
    .limit(1);
  if (!row) throw new Error("Attachment not found");
  await requireProductAccess(row.productId);

  const patch: Partial<typeof supplierProductAttachments.$inferInsert> = {};
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("File name cannot be empty");
    patch.name = input.name.trim();
  }
  if (Object.keys(patch).length === 0) return;
  await db
    .update(supplierProductAttachments)
    .set(patch)
    .where(eq(supplierProductAttachments.id, input.id));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

export async function deleteSupplierProductAttachment(input: { id: number }): Promise<void> {
  // Look up the attachment → product → supplierId once. Use the product
  // id to scope the auth check, and the pathname to free Blob storage.
  // Also pull the URL so we can detect whether this attachment is the
  // product's current cover image and cascade a replacement.
  await ensureSupplierInventorySchema();
  const [row] = await db
    .select({
      productId: supplierProductAttachments.productId,
      pathname: supplierProductAttachments.blobPathname,
      url: supplierProductAttachments.url,
      category: supplierProductAttachments.category,
    })
    .from(supplierProductAttachments)
    .where(eq(supplierProductAttachments.id, input.id))
    .limit(1);
  if (!row) return; // already gone
  await requireProductAccess(row.productId);
  if (row.pathname) {
    try { await del(row.pathname); } catch { /* tolerate missing blobs */ }
  }

  await db
    .delete(supplierProductAttachments)
    .where(eq(supplierProductAttachments.id, input.id));

  // If the row we just deleted was the product's cover image, pick the
  // next photo_media attachment as the new cover. If none remains, clear
  // the cover columns so the card falls back to the empty placeholder.
  const [product] = await db
    .select({
      id: supplierProducts.id,
      thumbnailUrl: supplierProducts.thumbnailUrl,
    })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, row.productId))
    .limit(1);
  if (product?.thumbnailUrl === row.url) {
    const [next] = await db
      .select({
        url: supplierProductAttachments.url,
        pathname: supplierProductAttachments.blobPathname,
      })
      .from(supplierProductAttachments)
      .where(
        and(
          eq(supplierProductAttachments.productId, row.productId),
          eq(supplierProductAttachments.category, "photo_media"),
        ),
      )
      .orderBy(desc(supplierProductAttachments.uploadedAt))
      .limit(1);
    await db
      .update(supplierProducts)
      .set({
        thumbnailUrl: next?.url ?? null,
        thumbnailPathname: next?.pathname ?? null,
      })
      .where(eq(supplierProducts.id, row.productId));
  }

  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

// Delete every file in a CUSTOM product section. Only the user-defined
// sections (category='other_file' rows carrying a customCategoryLabel)
// can be cleared this way — the eight canonical product sections are
// fixed and can't be removed. Frees blobs first, then deletes the rows.
export async function deleteSupplierProductCustomSection(input: {
  productId: number;
  customCategoryLabel: string;
}): Promise<{ deleted: number }> {
  await requireProductAccess(input.productId);
  await ensureSupplierInventorySchema();
  const label = input.customCategoryLabel.trim();
  if (!label) throw new Error("Section name is required");

  const rows = await db
    .select({
      id: supplierProductAttachments.id,
      url: supplierProductAttachments.url,
      blobPathname: supplierProductAttachments.blobPathname,
    })
    .from(supplierProductAttachments)
    .where(
      and(
        eq(supplierProductAttachments.productId, input.productId),
        eq(supplierProductAttachments.category, "other_file"),
        eq(supplierProductAttachments.customCategoryLabel, label),
      ),
    );
  for (const r of rows) {
    if (r.blobPathname) {
      try { await del(r.url); } catch (e) {
        console.warn("Blob cleanup failed", r.blobPathname, e);
      }
    }
  }
  await db
    .delete(supplierProductAttachments)
    .where(
      and(
        eq(supplierProductAttachments.productId, input.productId),
        eq(supplierProductAttachments.category, "other_file"),
        eq(supplierProductAttachments.customCategoryLabel, label),
      ),
    );

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { deleted: rows.length };
}
