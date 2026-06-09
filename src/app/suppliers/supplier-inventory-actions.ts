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
  supplierProjectEntries,
  type SupplierProduct,
  type SupplierProductAttachment,
} from "@/db/schema";
import {
  canEdit,
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
  // Optional source URL — the brand storefront listing for this product.
  // Persists to supplier_products.product_url.
  productUrl?: string;
  // When set, the new row becomes a model / configuration nested under
  // the given part. Validated server-side to ensure the parent is part
  // of the same supplier (a hostile client can't reparent a row onto
  // somebody else's part).
  parentProductId?: number;
  // Reserved — the server overrides this with the auth-resolved role so
  // the supplier can't pass createdByRole: "lightbase" to forge an audit
  // entry. Field is kept on the type for API symmetry.
  createdByRole?: "lightbase" | "supplier";
}): Promise<{ id: number }> {
  const { profile, role } = await requireSupplierAccess(input.supplierId);
  await ensureSupplierInventorySchema();
  if (!input.name.trim()) throw new Error("Product name is required");

  // Validate the parent — it must belong to the same supplier AND itself
  // be a top-level part (we only allow one level of nesting: part →
  // model, no models-of-models).
  let parentProductId: number | null = null;
  if (input.parentProductId != null) {
    const [parent] = await db
      .select({
        id: supplierProducts.id,
        supplierId: supplierProducts.supplierId,
        parentProductId: supplierProducts.parentProductId,
      })
      .from(supplierProducts)
      .where(eq(supplierProducts.id, input.parentProductId))
      .limit(1);
    if (!parent) throw new Error("Parent part not found");
    if (parent.supplierId !== input.supplierId) {
      throw new Error("Parent part belongs to a different supplier");
    }
    if (parent.parentProductId != null) {
      throw new Error("Models can only nest one level under a part");
    }
    parentProductId = parent.id;
  }
  // Every row — part or config — gets its OWN globalProductId so each
  // can be linked to alternatives at its own level independently.
  // Linking part A↔B doesn't auto-link A's configurations to B's.
  const globalProductId = `gp-${crypto.randomUUID()}`;

  const [row] = await db
    .insert(supplierProducts)
    .values({
      supplierId: input.supplierId,
      parentProductId,
      globalProductId,
      // Fresh products are UNMARKED — the user explicitly promotes one
      // to primary later. Until then every product in the cluster is a
      // peer and the catalogue card shows no green PRIMARY badge.
      // (Configurations don't participate in primary/secondary
      // tracking; they inherit the implicit default.)
      isPrimarySupplier: false,
      name: input.name.trim(),
      productCode: input.productCode?.trim() || null,
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      notes: input.notes?.trim() || null,
      productUrl: input.productUrl?.trim() || null,
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

// Reparent existing flat products INTO a part as configurations. Used
// by the "Move existing products here" picker on a part's drawer — lets
// the admin promote a flat catalog (Asahi's AF21D12H… cards, etc.) into
// a single "AF Series-22mm" part without having to delete and re-upload.
//
// Server-side rules:
//   • All products + the target part must belong to the same supplier.
//   • The target part must itself be top-level (a model can't host
//     models — single-level nesting only).
//   • A product can't be moved under itself.
//   • Pass parentProductId: null to demote a model back to a top-level
//     part (release a configuration).
export async function moveSupplierProductsToPart(input: {
  productIds: number[];
  parentProductId: number | null;
}): Promise<{ moved: number }> {
  await ensureSupplierInventorySchema();
  if (input.productIds.length === 0) return { moved: 0 };

  // Authorise on each product the caller wants to move.
  for (const id of input.productIds) {
    await requireProductAccess(id);
  }

  // Resolve all the rows in one query so we can validate same-supplier
  // and detect models-of-models in one pass.
  const rows = await db
    .select({
      id: supplierProducts.id,
      supplierId: supplierProducts.supplierId,
      parentProductId: supplierProducts.parentProductId,
    })
    .from(supplierProducts)
    .where(
      inArray(supplierProducts.id, [
        ...input.productIds,
        ...(input.parentProductId != null ? [input.parentProductId] : []),
      ]),
    );

  if (input.parentProductId != null) {
    const parent = rows.find((r) => r.id === input.parentProductId);
    if (!parent) throw new Error("Target part not found");
    if (parent.parentProductId != null) {
      throw new Error("Configurations can only nest one level under a part");
    }
    // requireProductAccess on the parent too — admins can do anything
    // in their tenant, suppliers can only operate on their own catalog.
    await requireProductAccess(parent.id);

    // Same-supplier check for every row we're moving.
    for (const id of input.productIds) {
      if (id === parent.id) throw new Error("A part can't be moved under itself");
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`Product ${id} not found`);
      if (r.supplierId !== parent.supplierId) {
        throw new Error("All products must belong to the same supplier as the target part");
      }
    }
  }

  await db
    .update(supplierProducts)
    .set({
      parentProductId: input.parentProductId,
      updatedAt: new Date(),
    })
    .where(inArray(supplierProducts.id, input.productIds));

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { moved: input.productIds.length };
}

export async function updateSupplierProduct(input: {
  id: number;
  name?: string;
  productCode?: string | null;
  description?: string | null;
  category?: string | null;
  notes?: string | null;
  productUrl?: string | null;
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
  if (input.productUrl !== undefined) patch.productUrl = input.productUrl?.trim() || null;
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
  // Project routing — required when category === "project_doc". The
  // project_num ties to supplier_project_entries.project_num so the panel
  // can show project metadata next to the file.
  projectNum?: string | null;
  projectDocType?: "rfq" | "quote" | "po" | "pi" | "invoice" | null;
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

  // Project routing validation — only meaningful for project_doc category.
  let projectNum: string | null = null;
  let projectDocType: "rfq" | "quote" | "po" | "pi" | "invoice" | null = null;
  if (input.category === "project_doc") {
    if (!input.projectDocType) {
      throw new Error("Pick a document type (RFQ / Quote / PO / PI / Invoice).");
    }
    projectDocType = input.projectDocType;
    projectNum = input.projectNum?.trim().slice(0, 64) || null;
  }

  const [row] = await db
    .insert(supplierProductAttachments)
    .values({
      productId: input.productId,
      category: input.category,
      customCategoryLabel: customLabel,
      projectNum,
      projectDocType,
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


// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE INVENTORY — every part across every supplier in the tenant,
// powering the ERP system's "Supplier Inventory" overview tab. Returns
// top-level parts only (parentProductId IS NULL) with their supplier
// name, configuration count, attachment count, and the set of project
// numbers their supplier has been involved in (used for the project
// filter dropdown).
// ─────────────────────────────────────────────────────────────────────────────

// A small summary of one configuration under a parent. Used so the parent
// card can list its configs by code/name and highlight the primary ones
// without having to refetch.
export type AggregateConfigSummary = {
  id: number;
  name: string;
  productCode: string | null;
  isPrimarySupplier: boolean;
  attachmentCount: number;
  thumbnailUrl: string | null;
};

export type AggregateInventoryPart = {
  id: number;
  supplierId: number;
  supplierName: string;
  name: string;
  productCode: string | null;
  category: string | null;
  description: string | null;
  productUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  modelCount: number;
  attachmentCount: number;
  projectNums: string[];
  // Cross-supplier product identity. Two cards with the same
  // globalProductId represent the same part on different suppliers.
  globalProductId: string | null;
  isPrimarySupplier: boolean;
  // Number of other supplier_products rows that share the cluster
  // (excluding this one). Drives the "+N backup suppliers" badge.
  alternativeSupplierCount: number;
  // ── New: catalogue classification ──────────────────────────────────────
  // "standalone"   = top-level part with zero configurations
  // "parent"       = top-level part with ≥ 1 configurations
  // "configuration" = nested row (parent_product_id is set)
  kind: "standalone" | "parent" | "configuration";
  // Only set when kind === "configuration".
  parentProductId: number | null;
  parentName: string | null;
  parentProductCode: string | null;
  // Inherited thumbnail — for configurations that have no image of their
  // own, the catalogue card falls back to the parent's thumbnail. Same
  // semantics for inherited file counts (parent's attachments rolled
  // into the config card's total).
  parentThumbnailUrl: string | null;
  parentAttachmentCount: number;
  // Only set when kind === "parent". The lightweight list of its
  // configurations so the card can display primary highlights inline.
  configurations: AggregateConfigSummary[];
  // Convenience pre-computed counters for the catalogue's "primary"
  // toggles. For "parent" rows: how many of the configurations are
  // marked primary. For "configuration" and "standalone": 0.
  primaryConfigCount: number;
};

export async function listAggregateSupplierInventory(): Promise<{
  parts: AggregateInventoryPart[];
  projectNums: string[];
}> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  await ensureSupplierInventorySchema();

  // Scope to the user's tenant. CADuniQ staff see every tenant (their
  // clientId is null on user_profiles), so we let them through with no
  // supplier-side filter; everyone else only sees their own tenant.
  const tenantClientId = profile.clientId ?? null;
  const supplierRows = tenantClientId == null
    ? await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
    : await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.clientId, tenantClientId));
  if (supplierRows.length === 0) return { parts: [], projectNums: [] };
  const supplierIds = supplierRows.map((s) => s.id);
  const supplierNameById = new Map(supplierRows.map((s) => [s.id, s.name]));

  // Parts (top-level rows). Each surfaces as a card on the catalogue
  // either as a standalone (no configs) or as a parent (has configs).
  const parts = await db
    .select()
    .from(supplierProducts)
    .where(
      and(
        inArray(supplierProducts.supplierId, supplierIds),
        sql`${supplierProducts.parentProductId} IS NULL`,
        eq(supplierProducts.archived, false),
      ),
    )
    .orderBy(desc(supplierProducts.updatedAt));
  if (parts.length === 0) {
    // Even with no parts, surface the project list so the filter
    // dropdown is still useful for empty-state navigation.
    const allProjects = await db
      .select({ projectNum: supplierProjectEntries.projectNum })
      .from(supplierProjectEntries)
      .where(inArray(supplierProjectEntries.supplierId, supplierIds));
    const projSet = new Set<string>();
    for (const p of allProjects) projSet.add(p.projectNum);
    return { parts: [], projectNums: Array.from(projSet).sort() };
  }
  const partIds = parts.map((p) => p.id);
  const partsById = new Map(parts.map((p) => [p.id, p]));

  // FULL configuration rows under these parts. We use these to (a) build
  // separate catalogue cards in "All products" view, and (b) populate the
  // configuration summary on parent cards in "Parent products" view.
  const configRows = await db
    .select()
    .from(supplierProducts)
    .where(
      and(
        inArray(supplierProducts.parentProductId, partIds),
        eq(supplierProducts.archived, false),
      ),
    );
  const configsByParent = new Map<number, typeof configRows>();
  const configCountByParent = new Map<number, number>();
  const primaryConfigCountByParent = new Map<number, number>();
  for (const c of configRows) {
    if (c.parentProductId == null) continue;
    const arr = configsByParent.get(c.parentProductId) ?? [];
    arr.push(c);
    configsByParent.set(c.parentProductId, arr);
    configCountByParent.set(c.parentProductId, (configCountByParent.get(c.parentProductId) ?? 0) + 1);
    if (c.isPrimarySupplier) {
      primaryConfigCountByParent.set(
        c.parentProductId,
        (primaryConfigCountByParent.get(c.parentProductId) ?? 0) + 1,
      );
    }
  }

  // Attachment counts — bulk fetch one row per product id (parts +
  // configs) so we can compose each card's rollup count.
  const allProductIdsToCount: number[] = [
    ...partIds,
    ...configRows.map((c) => c.id),
  ];
  const attachmentCountRows = allProductIdsToCount.length > 0
    ? await db
        .select({
          productId: supplierProductAttachments.productId,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(supplierProductAttachments)
        .where(inArray(supplierProductAttachments.productId, allProductIdsToCount))
        .groupBy(supplierProductAttachments.productId)
    : [];
  const attachmentCountByProduct = new Map<number, number>();
  for (const r of attachmentCountRows) attachmentCountByProduct.set(r.productId, r.n);

  // Projects each supplier has been involved in — drives the
  // project-filter dropdown on the overview AND tags each card.
  const projectRows = await db
    .select({
      supplierId: supplierProjectEntries.supplierId,
      projectNum: supplierProjectEntries.projectNum,
    })
    .from(supplierProjectEntries)
    .where(inArray(supplierProjectEntries.supplierId, supplierIds));
  const projectsBySupplier = new Map<number, Set<string>>();
  for (const r of projectRows) {
    const s = projectsBySupplier.get(r.supplierId) ?? new Set<string>();
    s.add(r.projectNum);
    projectsBySupplier.set(r.supplierId, s);
  }
  const allProjectSet = new Set<string>();
  for (const r of projectRows) allProjectSet.add(r.projectNum);

  // Cluster sizes per globalProductId — drives the "+N alternative
  // suppliers" badge on each card. We compute clusters separately for
  // top-level parts and for configurations because each level has its own
  // sub-cluster (a config can be linked to alternative configs without
  // dragging in the part-level cluster).
  const partGlobalIds = Array.from(
    new Set(parts.map((p) => p.globalProductId).filter((g): g is string => !!g)),
  );
  const configGlobalIds = Array.from(
    new Set(configRows.map((c) => c.globalProductId).filter((g): g is string => !!g)),
  );
  const clusterCountByGlobalId = new Map<string, number>();
  async function loadClusterCounts(ids: string[], isParentLevel: boolean) {
    if (ids.length === 0) return;
    const rows = await db
      .select({
        globalProductId: supplierProducts.globalProductId,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(supplierProducts)
      .where(
        and(
          inArray(supplierProducts.globalProductId, ids),
          isParentLevel
            ? sql`${supplierProducts.parentProductId} IS NULL`
            : sql`${supplierProducts.parentProductId} IS NOT NULL`,
          eq(supplierProducts.archived, false),
        ),
      )
      .groupBy(supplierProducts.globalProductId);
    for (const r of rows) {
      if (r.globalProductId) clusterCountByGlobalId.set(r.globalProductId, r.n);
    }
  }
  await loadClusterCounts(partGlobalIds, true);
  await loadClusterCounts(configGlobalIds, false);

  const assembled: AggregateInventoryPart[] = [];

  for (const p of parts) {
    const childConfigs = configsByParent.get(p.id) ?? [];
    // Rollup attachment count for the parent card = own + every child.
    let attachmentCount = attachmentCountByProduct.get(p.id) ?? 0;
    for (const c of childConfigs) {
      attachmentCount += attachmentCountByProduct.get(c.id) ?? 0;
    }
    const clusterSize = p.globalProductId
      ? clusterCountByGlobalId.get(p.globalProductId) ?? 1
      : 1;
    const configSummaries: AggregateConfigSummary[] = childConfigs.map((c) => ({
      id: c.id,
      name: c.name,
      productCode: c.productCode,
      isPrimarySupplier: c.isPrimarySupplier,
      attachmentCount: attachmentCountByProduct.get(c.id) ?? 0,
      thumbnailUrl: c.thumbnailUrl,
    }));
    assembled.push({
      id: p.id,
      supplierId: p.supplierId,
      supplierName: supplierNameById.get(p.supplierId) ?? "—",
      name: p.name,
      productCode: p.productCode,
      category: p.category,
      description: p.description,
      productUrl: p.productUrl,
      thumbnailUrl: p.thumbnailUrl,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      modelCount: configCountByParent.get(p.id) ?? 0,
      attachmentCount,
      projectNums: Array.from(projectsBySupplier.get(p.supplierId) ?? []).sort(),
      globalProductId: p.globalProductId,
      isPrimarySupplier: p.isPrimarySupplier,
      alternativeSupplierCount: Math.max(0, clusterSize - 1),
      kind: childConfigs.length > 0 ? "parent" : "standalone",
      parentProductId: null,
      parentName: null,
      parentProductCode: null,
      parentThumbnailUrl: null,
      parentAttachmentCount: 0,
      configurations: configSummaries,
      primaryConfigCount: primaryConfigCountByParent.get(p.id) ?? 0,
    });
  }

  // Now emit one row per CONFIGURATION as its own catalogue card. Each
  // inherits its parent's thumbnail (when the config has none) and its
  // parent's attachment count so the rolled-up file pill on the card is
  // meaningful.
  for (const c of configRows) {
    if (c.parentProductId == null) continue;
    const parent = partsById.get(c.parentProductId);
    if (!parent) continue;
    const ownAttachmentCount = attachmentCountByProduct.get(c.id) ?? 0;
    const parentAttachmentCount = attachmentCountByProduct.get(parent.id) ?? 0;
    const clusterSize = c.globalProductId
      ? clusterCountByGlobalId.get(c.globalProductId) ?? 1
      : 1;
    assembled.push({
      id: c.id,
      supplierId: c.supplierId,
      supplierName: supplierNameById.get(c.supplierId) ?? "—",
      name: c.name,
      productCode: c.productCode,
      // Inheritance rule (per user requirement): "All information that is
      // in the configuration should be the parent information + the
      // information inside the configuration." Where there's a single
      // value (category, description, thumbnail, productUrl) we prefer
      // the PARENT's, falling back to the config's own. The parent
      // represents the product family — its photo, its description, its
      // category are the canonical product info; the config carries the
      // specific variant code + any spec-sheet doc.
      category: parent.category ?? c.category,
      description: parent.description ?? c.description,
      productUrl: parent.productUrl ?? c.productUrl,
      thumbnailUrl: parent.thumbnailUrl ?? c.thumbnailUrl,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      modelCount: 0,
      // File-count inheritance: configs roll up their parent's file count
      // alongside their own so the catalogue pill reads honestly. The
      // drawer surfaces both buckets distinctly.
      attachmentCount: ownAttachmentCount + parentAttachmentCount,
      projectNums: Array.from(projectsBySupplier.get(c.supplierId) ?? []).sort(),
      globalProductId: c.globalProductId,
      isPrimarySupplier: c.isPrimarySupplier,
      alternativeSupplierCount: Math.max(0, clusterSize - 1),
      kind: "configuration",
      parentProductId: parent.id,
      parentName: parent.name,
      parentProductCode: parent.productCode,
      parentThumbnailUrl: parent.thumbnailUrl,
      parentAttachmentCount,
      configurations: [],
      primaryConfigCount: 0,
    });
  }

  // Stable ordering: newest first across both kinds.
  assembled.sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );

  return { parts: assembled, projectNums: Array.from(allProjectSet).sort() };
}


// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY / ALTERNATIVE SUPPLIERS
// Same product code, multiple suppliers — one is primary, rest are
// backups. The cluster is identified by globalProductId.
// ─────────────────────────────────────────────────────────────────────────────

export type AlternativeSupplierPart = {
  id: number;
  supplierId: number;
  supplierName: string;
  name: string;
  productCode: string | null;
  productUrl: string | null;
  isPrimarySupplier: boolean;
  thumbnailUrl: string | null;
  attachmentCount: number;
  modelCount: number;
};

// List every alternative supplier for the same global product (i.e.,
// every supplier_products row sharing globalProductId with the given
// part OR configuration). The query is scoped to the SAME nesting
// level as the input — parts cluster with parts, configurations with
// configurations — so a part's alternatives don't accidentally drag
// in unrelated configurations and vice versa.
export async function listAlternativeSuppliersForPart(input: {
  partId: number;
}): Promise<AlternativeSupplierPart[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: cannot view suppliers");
  }
  await ensureSupplierInventorySchema();

  const [target] = await db
    .select({
      globalProductId: supplierProducts.globalProductId,
      parentProductId: supplierProducts.parentProductId,
    })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, input.partId))
    .limit(1);
  if (!target?.globalProductId) return [];
  const isConfig = target.parentProductId != null;

  // Rows in the cluster, with each supplier's name. Same-level
  // scoping: configs cluster with configs, parts with parts.
  const rows = await db
    .select({
      id: supplierProducts.id,
      supplierId: supplierProducts.supplierId,
      supplierName: suppliers.name,
      name: supplierProducts.name,
      productCode: supplierProducts.productCode,
      productUrl: supplierProducts.productUrl,
      isPrimarySupplier: supplierProducts.isPrimarySupplier,
      thumbnailUrl: supplierProducts.thumbnailUrl,
      supplierClientId: suppliers.clientId,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        eq(supplierProducts.globalProductId, target.globalProductId),
        isConfig
          ? sql`${supplierProducts.parentProductId} IS NOT NULL`
          : sql`${supplierProducts.parentProductId} IS NULL`,
        eq(supplierProducts.archived, false),
      ),
    );
  if (rows.length === 0) return [];

  // Tenant scope: non-CADuniQ users only see alternatives on their
  // own tenant's suppliers.
  const tenantClientId = profile.clientId ?? null;
  const inTenant = (clientId: number | null) =>
    tenantClientId == null || clientId === tenantClientId;
  const visibleRows = rows.filter((r) => inTenant(r.supplierClientId));
  if (visibleRows.length === 0) return [];

  const ids = visibleRows.map((r) => r.id);
  const attachmentCountRows = await db
    .select({
      productId: supplierProductAttachments.productId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(supplierProductAttachments)
    .where(inArray(supplierProductAttachments.productId, ids))
    .groupBy(supplierProductAttachments.productId);
  const attachmentCountByProduct = new Map<number, number>();
  for (const r of attachmentCountRows) attachmentCountByProduct.set(r.productId, r.n);

  const modelCountRows = await db
    .select({
      parentProductId: supplierProducts.parentProductId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(supplierProducts)
    .where(
      and(
        inArray(supplierProducts.parentProductId, ids),
        eq(supplierProducts.archived, false),
      ),
    )
    .groupBy(supplierProducts.parentProductId);
  const modelCountByParent = new Map<number, number>();
  for (const r of modelCountRows) {
    if (r.parentProductId != null) modelCountByParent.set(r.parentProductId, r.n);
  }

  return visibleRows
    .map((r) => ({
      id: r.id,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      name: r.name,
      productCode: r.productCode,
      productUrl: r.productUrl,
      isPrimarySupplier: r.isPrimarySupplier,
      thumbnailUrl: r.thumbnailUrl,
      attachmentCount: attachmentCountByProduct.get(r.id) ?? 0,
      modelCount: modelCountByParent.get(r.id) ?? 0,
    }))
    .sort((a, b) => {
      if (a.isPrimarySupplier !== b.isPrimarySupplier) return a.isPrimarySupplier ? -1 : 1;
      return a.supplierName.localeCompare(b.supplierName);
    });
}

// Link an EXISTING product from the catalogue as an alternative for
// the current part. Both rows must be top-level parts that already
// exist (each was created independently against its own supplier).
// We merge the two clusters: every part currently sharing the target's
// globalProductId (plus its configurations) is rewritten to share the
// current part's globalProductId. Neither row's primary flag is
// touched — the user still chooses which one (if any) is primary.
export async function linkAlternativeProduct(input: {
  existingPartId: number;
  alternativePartId: number;
}): Promise<{ mergedRows: number }> {
  // Authorise on both products separately so we never reach across
  // tenant boundaries via this action.
  await requireProductAccess(input.existingPartId);
  await requireProductAccess(input.alternativePartId);
  await ensureSupplierInventorySchema();

  if (input.existingPartId === input.alternativePartId) {
    throw new Error("Pick a different product to link");
  }

  const rows = await db
    .select({
      id: supplierProducts.id,
      supplierId: supplierProducts.supplierId,
      parentProductId: supplierProducts.parentProductId,
      globalProductId: supplierProducts.globalProductId,
    })
    .from(supplierProducts)
    .where(inArray(supplierProducts.id, [input.existingPartId, input.alternativePartId]));
  const source = rows.find((r) => r.id === input.existingPartId);
  const target = rows.find((r) => r.id === input.alternativePartId);
  if (!source || !target) throw new Error("Product not found");
  // Same-level only — parts cluster with parts, configurations with
  // configurations. Mixing the two would let a part's cluster bleed
  // into the configuration tree (or vice versa) and break the
  // semantics on every screen that filters by nesting level.
  const sourceIsConfig = source.parentProductId != null;
  const targetIsConfig = target.parentProductId != null;
  if (sourceIsConfig !== targetIsConfig) {
    throw new Error(
      "Link a part to a part, or a configuration to a configuration",
    );
  }
  if (!source.globalProductId || !target.globalProductId) {
    throw new Error("Both rows must have a global product ID");
  }
  if (source.globalProductId === target.globalProductId) {
    // Already in the same cluster — silently no-op.
    return { mergedRows: 0 };
  }

  // Merge the target cluster INTO the source cluster. Every row
  // (parts + configurations) currently using target's globalProductId
  // gets rewritten to source's globalProductId.
  const updated = await db
    .update(supplierProducts)
    .set({
      globalProductId: source.globalProductId,
      updatedAt: new Date(),
    })
    .where(eq(supplierProducts.globalProductId, target.globalProductId))
    .returning({ id: supplierProducts.id });

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { mergedRows: updated.length };
}

// Unmark the current part as primary without promoting anyone else
// — the cluster has no primary chosen. Used when the admin wants to
// clear the green badge entirely.
export async function unmarkPrimarySupplier(input: {
  partId: number;
}): Promise<void> {
  await requireProductAccess(input.partId);
  await ensureSupplierInventorySchema();
  await db
    .update(supplierProducts)
    .set({ isPrimarySupplier: false, updatedAt: new Date() })
    .where(eq(supplierProducts.id, input.partId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

// Unlink a part from its current cluster so it stands alone again.
// Generates a fresh globalProductId for this part (and its
// configurations) and demotes it from primary if it was. Useful when
// an alternative turns out to be a different product after all.
export async function unlinkFromAlternativeCluster(input: {
  partId: number;
}): Promise<void> {
  await requireProductAccess(input.partId);
  await ensureSupplierInventorySchema();
  const freshId = `gp-${crypto.randomUUID()}`;
  // Rewrite the part + its configurations.
  await db
    .update(supplierProducts)
    .set({
      globalProductId: freshId,
      isPrimarySupplier: false,
      updatedAt: new Date(),
    })
    .where(eq(supplierProducts.id, input.partId));
  await db
    .update(supplierProducts)
    .set({ globalProductId: freshId, updatedAt: new Date() })
    .where(eq(supplierProducts.parentProductId, input.partId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

// Catalogue picker source: every other top-level part across the
// user's tenant suppliers (except the one being looked at). Returns
// supplier name + part info so the linker dialog can render rich
// rows. Tenant-scoped automatically.
export type CataloguePickerPart = {
  id: number;
  supplierId: number;
  supplierName: string;
  name: string;
  productCode: string | null;
  category: string | null;
  globalProductId: string | null;
  thumbnailUrl: string | null;
  // Populated only when picking a configuration — gives the picker
  // enough context to show "Foo configuration · under AF Series-22mm"
  // so the user knows which part it belongs to.
  parentName: string | null;
  parentProductCode: string | null;
};

export async function listCataloguePartsForLinking(input: {
  excludePartId: number;
}): Promise<CataloguePickerPart[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: cannot view suppliers");
  }
  await ensureSupplierInventorySchema();

  // Detect whether we're linking from a part or a configuration — the
  // picker only surfaces rows at the same nesting level.
  const [target] = await db
    .select({ parentProductId: supplierProducts.parentProductId })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, input.excludePartId))
    .limit(1);
  if (!target) return [];
  const isConfig = target.parentProductId != null;

  const tenantClientId = profile.clientId ?? null;
  const supplierRows = tenantClientId == null
    ? await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers)
    : await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.clientId, tenantClientId));
  if (supplierRows.length === 0) return [];
  const supplierIds = supplierRows.map((s) => s.id);
  const nameById = new Map(supplierRows.map((s) => [s.id, s.name]));

  const rows = await db
    .select({
      id: supplierProducts.id,
      supplierId: supplierProducts.supplierId,
      name: supplierProducts.name,
      productCode: supplierProducts.productCode,
      category: supplierProducts.category,
      globalProductId: supplierProducts.globalProductId,
      thumbnailUrl: supplierProducts.thumbnailUrl,
      parentProductId: supplierProducts.parentProductId,
    })
    .from(supplierProducts)
    .where(
      and(
        inArray(supplierProducts.supplierId, supplierIds),
        isConfig
          ? sql`${supplierProducts.parentProductId} IS NOT NULL`
          : sql`${supplierProducts.parentProductId} IS NULL`,
        eq(supplierProducts.archived, false),
        sql`${supplierProducts.id} <> ${input.excludePartId}`,
      ),
    )
    .orderBy(desc(supplierProducts.updatedAt));
  if (rows.length === 0) return [];

  // For configurations, fetch each parent's name/code in one query so
  // we can render "<config> · under <parent>".
  const parentMap = new Map<number, { name: string; productCode: string | null }>();
  if (isConfig) {
    const parentIds = Array.from(
      new Set(rows.map((r) => r.parentProductId).filter((v): v is number => v != null)),
    );
    if (parentIds.length > 0) {
      const parents = await db
        .select({
          id: supplierProducts.id,
          name: supplierProducts.name,
          productCode: supplierProducts.productCode,
        })
        .from(supplierProducts)
        .where(inArray(supplierProducts.id, parentIds));
      for (const p of parents) parentMap.set(p.id, { name: p.name, productCode: p.productCode });
    }
  }

  return rows.map((p) => {
    const parent =
      p.parentProductId != null ? parentMap.get(p.parentProductId) ?? null : null;
    return {
      id: p.id,
      supplierId: p.supplierId,
      supplierName: nameById.get(p.supplierId) ?? "—",
      name: p.name,
      productCode: p.productCode,
      category: p.category,
      globalProductId: p.globalProductId,
      thumbnailUrl: p.thumbnailUrl,
      parentName: parent?.name ?? null,
      parentProductCode: parent?.productCode ?? null,
    };
  });
}

// Promote an alternative supplier's part to the primary for its
// globalProductId cluster. Demotes whichever row was previously
// primary in the same cluster.
export async function promoteToPrimarySupplier(input: {
  partId: number;
}): Promise<void> {
  await requireProductAccess(input.partId);
  await ensureSupplierInventorySchema();

  const [target] = await db
    .select({
      id: supplierProducts.id,
      globalProductId: supplierProducts.globalProductId,
      parentProductId: supplierProducts.parentProductId,
    })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, input.partId))
    .limit(1);
  if (!target) throw new Error("Row not found");
  if (!target.globalProductId) {
    throw new Error("Row has no globalProductId");
  }

  // Server-side enforcement of the rule the UI already enforces: a part
  // that has configurations cannot itself be marked primary — only its
  // configurations can. The parent functions as a container.
  const isConfig = target.parentProductId != null;
  if (!isConfig) {
    const [{ n: childCount }] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(supplierProducts)
      .where(
        and(
          eq(supplierProducts.parentProductId, target.id),
          eq(supplierProducts.archived, false),
        ),
      );
    if (childCount > 0) {
      throw new Error(
        "This part has configurations — mark one of its configurations as primary instead.",
      );
    }
  }

  // Demote every other row in the cluster (same nesting level only),
  // then promote this one.
  await db
    .update(supplierProducts)
    .set({ isPrimarySupplier: false, updatedAt: new Date() })
    .where(
      and(
        eq(supplierProducts.globalProductId, target.globalProductId),
        isConfig
          ? sql`${supplierProducts.parentProductId} IS NOT NULL`
          : sql`${supplierProducts.parentProductId} IS NULL`,
        sql`${supplierProducts.id} <> ${target.id}`,
      ),
    );
  await db
    .update(supplierProducts)
    .set({ isPrimarySupplier: true, updatedAt: new Date() })
    .where(eq(supplierProducts.id, target.id));

  revalidatePath("/suppliers");
  revalidatePath("/portal");
}


// ─────────────────────────────────────────────────────────────────────────────
// Add-product orchestration helpers
// Used by /api/suppliers/add-product/* routes. Kept adjacent to the other
// supplier-inventory queries so they share the same auth / tenant scoping.
// The streaming + commit orchestration itself lives in
// src/app/suppliers/add-product-actions.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierResolutionCandidate = {
  id: number;
  name: string;
  website: string | null;
  // "domain" = supplierWebsite domain matched this supplier's website domain.
  // "name"   = case-insensitive name equality.
  // "hint"   = the user-supplied hint matched fuzzily.
  matchKind: "domain" | "name" | "hint";
};

function normaliseDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export async function findSuppliersForResolution(input: {
  supplierName: string | null;
  supplierWebsite: string | null;
  supplierHint: string | null;
}): Promise<SupplierResolutionCandidate[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  await ensureSupplierInventorySchema();

  const tenantClientId = profile.clientId ?? null;
  const rows = tenantClientId == null
    ? await db
        .select({ id: suppliers.id, name: suppliers.name, website: suppliers.website })
        .from(suppliers)
    : await db
        .select({ id: suppliers.id, name: suppliers.name, website: suppliers.website })
        .from(suppliers)
        .where(eq(suppliers.clientId, tenantClientId));

  const targetDomain = normaliseDomain(input.supplierWebsite);
  const targetName = input.supplierName?.trim().toLowerCase() ?? "";
  const hint = input.supplierHint?.trim().toLowerCase() ?? "";

  const out: SupplierResolutionCandidate[] = [];
  const seen = new Set<number>();
  function push(c: SupplierResolutionCandidate) {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  }

  if (targetDomain) {
    for (const r of rows) {
      if (normaliseDomain(r.website) === targetDomain) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "domain" });
      }
    }
  }
  if (targetName) {
    for (const r of rows) {
      if (r.name.trim().toLowerCase() === targetName) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "name" });
      }
    }
  }
  if (hint) {
    for (const r of rows) {
      if (r.name.trim().toLowerCase().includes(hint)) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "hint" });
      }
    }
  }
  return out;
}

export type ExistingProductMatchCandidate = {
  partId: number;
  globalProductId: string;
  productCode: string;
  name: string;
  supplierName: string;
};

export async function findExistingProductsByCode(input: {
  productCode: string;
}): Promise<ExistingProductMatchCandidate[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  await ensureSupplierInventorySchema();

  const code = input.productCode.trim();
  if (!code) return [];

  const tenantClientId = profile.clientId ?? null;
  const rows = await db
    .select({
      partId: supplierProducts.id,
      globalProductId: supplierProducts.globalProductId,
      productCode: supplierProducts.productCode,
      name: supplierProducts.name,
      supplierName: suppliers.name,
      supplierClientId: suppliers.clientId,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        sql`LOWER(TRIM(${supplierProducts.productCode})) = LOWER(${code})`,
        sql`${supplierProducts.parentProductId} IS NULL`,
        eq(supplierProducts.archived, false),
      ),
    );

  return rows
    .filter(
      (r) => tenantClientId == null || r.supplierClientId === tenantClientId,
    )
    .filter(
      (r): r is typeof r & { globalProductId: string; productCode: string } =>
        !!r.globalProductId && !!r.productCode,
    )
    .map((r) => ({
      partId: r.partId,
      globalProductId: r.globalProductId,
      productCode: r.productCode,
      name: r.name,
      supplierName: r.supplierName,
    }));
}

// Purchase-source flat list on the product itself.
// Adding a source does NOT create a new catalogue card — it just appends an
// entry to supplier_products.purchase_sources for the row we're on. The UI
// renders these as a list of clickable links inside the same product card.

export type PurchaseSource = {
  id: string;
  name: string;
  url: string;
  website?: string | null;
  notes?: string | null;
  addedAt: string;
  addedByClerkId?: string | null;
};

function normalisePurchaseSource(raw: unknown): PurchaseSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.url !== "string") {
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    website: typeof r.website === "string" ? r.website : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date().toISOString(),
    addedByClerkId: typeof r.addedByClerkId === "string" ? r.addedByClerkId : null,
  };
}

export async function addPurchaseSource(input: {
  productId: number;
  name: string;
  url: string;
  website?: string | null;
  notes?: string | null;
}): Promise<{ sourceId: string }> {
  const { profile } = await requireProductAccess(input.productId);
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }
  await ensureSupplierInventorySchema();

  const url = input.url.trim();
  const name = input.name.trim();
  if (!url) throw new Error("Product URL is required");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Product URL must start with http:// or https://");
  }
  if (!name) throw new Error("Source name is required");

  const [row] = await db
    .select({ purchaseSources: supplierProducts.purchaseSources })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, input.productId))
    .limit(1);
  const current = (row?.purchaseSources ?? [])
    .map(normalisePurchaseSource)
    .filter((s): s is PurchaseSource => s !== null);

  // Dedupe by URL (case-insensitive) — if the same URL is already in the
  // list, no-op rather than creating a redundant entry.
  const urlLc = url.toLowerCase();
  const existing = current.find((s) => s.url.toLowerCase() === urlLc);
  if (existing) {
    revalidatePath("/suppliers");
    return { sourceId: existing.id };
  }

  const sourceId = crypto.randomUUID();
  const next: PurchaseSource[] = [
    ...current,
    {
      id: sourceId,
      name,
      url,
      website: input.website?.trim() || null,
      notes: input.notes?.trim() || null,
      addedAt: new Date().toISOString(),
      addedByClerkId: profile.clerkUserId,
    },
  ];

  await db
    .update(supplierProducts)
    .set({ purchaseSources: next, updatedAt: new Date() })
    .where(eq(supplierProducts.id, input.productId));

  revalidatePath("/suppliers");
  return { sourceId };
}

export async function removePurchaseSource(input: {
  productId: number;
  sourceId: string;
}): Promise<void> {
  const { profile } = await requireProductAccess(input.productId);
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }
  await ensureSupplierInventorySchema();

  const [row] = await db
    .select({ purchaseSources: supplierProducts.purchaseSources })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, input.productId))
    .limit(1);
  if (!row) return;
  const next = (row.purchaseSources ?? [])
    .map(normalisePurchaseSource)
    .filter((s): s is PurchaseSource => s !== null && s.id !== input.sourceId);

  await db
    .update(supplierProducts)
    .set({ purchaseSources: next, updatedAt: new Date() })
    .where(eq(supplierProducts.id, input.productId));
  revalidatePath("/suppliers");
}

export async function createSupplierForExtraction(input: {
  name: string;
  website: string | null;
  email: string | null;
}): Promise<{ id: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }
  const name = input.name.trim();
  if (!name) throw new Error("Supplier name is required");

  const tenantClientId = profile.clientId ?? null;
  const [row] = await db
    .insert(suppliers)
    .values({
      name,
      website: input.website?.trim() || null,
      email: input.email?.trim() || null,
      clientId: tenantClientId,
      status: "Active",
    })
    .returning({ id: suppliers.id });

  revalidatePath("/suppliers");
  return { id: row.id };
}


// ─────────────────────────────────────────────────────────────────────────────
// Per-product project routing
// Used by the "Projects" sidebar bucket on the product drawer. The bucket
// replaced the old "Quotes & Pricing" — every doc upload now sits inside a
// project (RFQ / Quote / PO / PI / Invoice).
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierProjectOption = {
  projectNum: string;
  status: string | null;
  poNumber: string | null;
  quoteDate: Date | null;
  poDate: Date | null;
  expectedDelivery: Date | null;
  orderedQuantity: number;
  quotedAmount: string;
  currency: string | null;
};

// Pulls every project the supplier has been involved in — used by the
// "+ Add to project" picker on a product. The picker shows the
// supplier's own projects first so the user doesn't free-text a number
// that already exists in the project tracker.
export async function listSupplierProjectsForPicker(input: {
  supplierId: number;
}): Promise<SupplierProjectOption[]> {
  await resolveReadAccess(input.supplierId);
  await ensureSupplierInventorySchema();

  const rows = await db
    .select({
      projectNum: supplierProjectEntries.projectNum,
      status: supplierProjectEntries.status,
      poNumber: supplierProjectEntries.poNumber,
      quoteDate: supplierProjectEntries.quoteDate,
      poDate: supplierProjectEntries.poDate,
      expectedDelivery: supplierProjectEntries.expectedDelivery,
      orderedQuantity: supplierProjectEntries.orderedQuantity,
      quotedAmount: supplierProjectEntries.quotedAmount,
      currency: supplierProjectEntries.currency,
    })
    .from(supplierProjectEntries)
    .where(eq(supplierProjectEntries.supplierId, input.supplierId))
    .orderBy(desc(supplierProjectEntries.createdAt));

  // Drizzle returns dates as strings for date columns and numerics as
  // strings — normalise to Date for the convenience of the UI.
  return rows.map((r) => ({
    projectNum: r.projectNum,
    status: r.status,
    poNumber: r.poNumber,
    quoteDate: r.quoteDate ? new Date(r.quoteDate) : null,
    poDate: r.poDate ? new Date(r.poDate) : null,
    expectedDelivery: r.expectedDelivery ? new Date(r.expectedDelivery) : null,
    orderedQuantity: r.orderedQuantity,
    quotedAmount: r.quotedAmount,
    currency: r.currency,
  }));
}

export type ProductProjectDocCounts = {
  rfq: number;
  quote: number;
  po: number;
  pi: number;
  invoice: number;
};

export type ProductProjectGroup = {
  // null bucket for legacy uploads that don't have a project number set
  // (e.g. migrated quote_pricing rows).
  projectNum: string | null;
  // Pulled from supplier_project_entries if the project exists for this
  // supplier; null when the doc is attached to a project number that
  // doesn't have a tracker entry yet.
  status: string | null;
  poNumber: string | null;
  totalDocs: number;
  countsByType: ProductProjectDocCounts;
};

// Aggregate the project_doc attachments on a product into one row per
// project_num — used to render the Projects sidebar count + the panel
// header summary.
export async function listProductProjectGroups(input: {
  productId: number;
}): Promise<ProductProjectGroup[]> {
  await resolveReadAccessForProduct(input.productId);
  await ensureSupplierInventorySchema();

  const rows = await db
    .select({
      projectNum: supplierProductAttachments.projectNum,
      docType: supplierProductAttachments.projectDocType,
    })
    .from(supplierProductAttachments)
    .where(
      and(
        eq(supplierProductAttachments.productId, input.productId),
        eq(supplierProductAttachments.category, "project_doc"),
      ),
    );

  // Group by projectNum (null is a real bucket = "No project").
  const byProject = new Map<string | null, ProductProjectGroup>();
  for (const r of rows) {
    const key = r.projectNum ?? null;
    let group = byProject.get(key);
    if (!group) {
      group = {
        projectNum: key,
        status: null,
        poNumber: null,
        totalDocs: 0,
        countsByType: { rfq: 0, quote: 0, po: 0, pi: 0, invoice: 0 },
      };
      byProject.set(key, group);
    }
    group.totalDocs += 1;
    if (r.docType && r.docType in group.countsByType) {
      const t = r.docType as keyof ProductProjectDocCounts;
      group.countsByType[t] += 1;
    }
  }

  // Decorate with status / PO number from supplier_project_entries.
  const projectNums = Array.from(byProject.keys()).filter(
    (k): k is string => k != null,
  );
  if (projectNums.length > 0) {
    // We need the supplierId — look it up via the product row.
    const [productRow] = await db
      .select({ supplierId: supplierProducts.supplierId })
      .from(supplierProducts)
      .where(eq(supplierProducts.id, input.productId))
      .limit(1);
    if (productRow) {
      const entries = await db
        .select({
          projectNum: supplierProjectEntries.projectNum,
          status: supplierProjectEntries.status,
          poNumber: supplierProjectEntries.poNumber,
        })
        .from(supplierProjectEntries)
        .where(
          and(
            eq(supplierProjectEntries.supplierId, productRow.supplierId),
            inArray(supplierProjectEntries.projectNum, projectNums),
          ),
        );
      for (const e of entries) {
        const group = byProject.get(e.projectNum);
        if (group) {
          group.status = e.status;
          group.poNumber = e.poNumber;
        }
      }
    }
  }

  // Sort: real projects first (alphabetical), then the null bucket last.
  return Array.from(byProject.values()).sort((a, b) => {
    if (a.projectNum == null) return 1;
    if (b.projectNum == null) return -1;
    return a.projectNum.localeCompare(b.projectNum);
  });
}

// Same auth-check pattern as requireProductAccess but read-only — used
// by the per-product project listing.
async function resolveReadAccessForProduct(productId: number): Promise<void> {
  const [row] = await db
    .select({ supplierId: supplierProducts.supplierId })
    .from(supplierProducts)
    .where(eq(supplierProducts.id, productId))
    .limit(1);
  if (!row) throw new Error("Product not found");
  await resolveReadAccess(row.supplierId);
}
