"use server";

// Inventory module — every RFQ / quote / PO line ties back here via a
// "Lightbase Ref." code so one part can track its order history across
// every supplier. Auto-generates the next code on RFQ creation when the
// buyer leaves the field blank; strict-resolves when the buyer types one
// in (typos must not silently create duplicate parts).

import { revalidatePath } from "next/cache";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  inventoryItems,
  purchaseOrders,
  purchaseOrderLines,
  rfqItems,
  rfqs,
  rfqRecipients,
  suppliers,
  supplierQuoteLines,
  supplierQuotes,
  type InventoryItem,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Rfq,
  type RfqItem,
  type SupplierQuote,
  type SupplierQuoteLine,
} from "@/db/schema";
import { canViewSuppliers, getOrCreateProfile, requireSupplierEditor } from "@/lib/permissions";
import { ensureOrdersSchema } from "./_ensure-orders-schema";

// ─────────────────────────────────────────────────────────────────────────────
// CODE GENERATION — "LB-NNNNNN" zero-padded to 6 digits.
//
// We pick max(numeric suffix) + 1 over every existing code that matches the
// LB-NNNNNN shape. Codes the buyer typed in manually (legacy SAP-style,
// arbitrary strings) are ignored when finding the next number, so a custom
// code never accidentally fast-forwards the sequence past 1 million.
// ─────────────────────────────────────────────────────────────────────────────

const LB_REF_PREFIX = "LB-";
const LB_REF_RE = /^LB-(\d{6,})$/;

async function nextLightbaseRef(): Promise<string> {
  await ensureOrdersSchema();
  const rows = await db
    .select({ code: inventoryItems.code })
    .from(inventoryItems)
    .where(sql`${inventoryItems.code} ~ '^LB-[0-9]+$'`);
  let max = 0;
  for (const r of rows) {
    const m = r.code.match(LB_REF_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${LB_REF_PREFIX}${String(max + 1).padStart(6, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE-OR-CREATE — called by createRfq for each line item.
//
// Behaviour:
//   • If `code` is blank → mint the next LB-NNNNNN, create a fresh item,
//     return { id, code }.
//   • If `code` is provided → look it up. If found, return the existing
//     {id, code} (the line is linked to the pre-existing part). If NOT
//     found, throw — the buyer typed a code that doesn't exist in
//     inventory, and silent creation would mask typos. The caller can
//     choose to surface a "create new with this code?" prompt instead.
//
// When creating, we use the line's description/clientRef as defaults for
// name + spec so the brand-new inventory part is searchable straight away.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveResult = {
  id: number;
  code: string;
  isNew: boolean;
};

export async function resolveOrCreateInventoryItem(input: {
  // The user-entered code (may be blank to trigger auto-generation).
  code?: string;
  // Defaults applied when creating a new item.
  name?: string;
  description?: string;
  category?: string;
  // If true, allow creating an item with a user-provided code that doesn't
  // exist yet. Defaults to false (strict-resolve mode).
  createIfMissing?: boolean;
}): Promise<ResolveResult> {
  const profile = await requireSupplierEditor();
  await ensureOrdersSchema();
  const trimmed = (input.code ?? "").trim();

  if (trimmed) {
    // Look up exact match (case-insensitive — Lightbase Ref. shouldn't be
    // case-sensitive in practice).
    const [existing] = await db
      .select()
      .from(inventoryItems)
      .where(sql`LOWER(${inventoryItems.code}) = LOWER(${trimmed})`)
      .limit(1);
    if (existing) return { id: existing.id, code: existing.code, isNew: false };
    if (!input.createIfMissing) {
      throw new Error(
        `Lightbase Ref. "${trimmed}" doesn't exist in inventory. Leave the field blank to auto-generate a new part, or check the spelling.`,
      );
    }
    const [created] = await db
      .insert(inventoryItems)
      .values({
        code: trimmed,
        name: input.name?.trim() || trimmed,
        description: input.description?.trim() || null,
        category: input.category?.trim() || null,
        createdByClerkId: profile.clerkUserId,
      })
      .returning({ id: inventoryItems.id, code: inventoryItems.code });
    return { id: created.id, code: created.code, isNew: true };
  }

  // No code provided — auto-generate. Loop on unique-constraint failures
  // so two concurrent RFQs racing for the next code don't both lose.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await nextLightbaseRef();
    try {
      const [created] = await db
        .insert(inventoryItems)
        .values({
          code,
          name: input.name?.trim() || code,
          description: input.description?.trim() || null,
          category: input.category?.trim() || null,
          createdByClerkId: profile.clerkUserId,
        })
        .returning({ id: inventoryItems.id, code: inventoryItems.code });
      return { id: created.id, code: created.code, isNew: true };
    } catch (e) {
      // Unique-violation? Try the next sequence number.
      const msg = e instanceof Error ? e.message : "";
      if (!/duplicate|unique/i.test(msg)) throw e;
    }
  }
  throw new Error("Failed to mint a unique Lightbase Ref. after 5 attempts");
}

// ─────────────────────────────────────────────────────────────────────────────
// READS — for the Inventory tab + the per-part detail page
// ─────────────────────────────────────────────────────────────────────────────

export type InventoryItemWithStats = InventoryItem & {
  rfqCount: number;
  poCount: number;
  lastActivityAt: Date | null;
};

export async function listInventoryItems(): Promise<InventoryItemWithStats[]> {
  // Read access: anyone who can view suppliers (= internal team).
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile)) {
    throw new Error("Unauthorized: cannot view inventory");
  }
  await ensureOrdersSchema();

  const items = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.archived, false))
    .orderBy(desc(inventoryItems.createdAt));
  if (items.length === 0) return [];

  const ids = items.map((i) => i.id);
  // Per-item counts of RFQ lines + PO lines.
  const rfqCounts = await db
    .select({
      id: rfqItems.inventoryItemId,
      n: sql<number>`COUNT(*)::int`,
      lastAt: sql<Date | null>`MAX(${rfqs.createdAt})`,
    })
    .from(rfqItems)
    .innerJoin(rfqs, eq(rfqs.id, rfqItems.rfqId))
    .where(inArray(rfqItems.inventoryItemId, ids))
    .groupBy(rfqItems.inventoryItemId);
  const poCounts = await db
    .select({
      id: purchaseOrderLines.inventoryItemId,
      n: sql<number>`COUNT(*)::int`,
      lastAt: sql<Date | null>`MAX(${purchaseOrders.createdAt})`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(inArray(purchaseOrderLines.inventoryItemId, ids))
    .groupBy(purchaseOrderLines.inventoryItemId);

  const rfqMap = new Map(rfqCounts.map((r) => [r.id ?? -1, r]));
  const poMap = new Map(poCounts.map((r) => [r.id ?? -1, r]));

  return items.map((it) => {
    const r = rfqMap.get(it.id);
    const p = poMap.get(it.id);
    const lastR = r?.lastAt ? new Date(r.lastAt) : null;
    const lastP = p?.lastAt ? new Date(p.lastAt) : null;
    const lastActivityAt = lastP && lastR ? (lastP > lastR ? lastP : lastR) : (lastP ?? lastR ?? null);
    return {
      ...it,
      rfqCount: Number(r?.n ?? 0),
      poCount: Number(p?.n ?? 0),
      lastActivityAt,
    };
  });
}

export type InventoryItemHistory = {
  item: InventoryItem;
  // RFQs that included this part, with the line + every quote line received.
  rfqs: Array<{
    rfq: Rfq;
    line: RfqItem;
    quoteLines: Array<{
      quote: SupplierQuote;
      line: SupplierQuoteLine;
      supplierName: string;
    }>;
  }>;
  pos: Array<{ po: PurchaseOrder; line: PurchaseOrderLine }>;
};

export async function getInventoryItemHistory(itemId: number): Promise<InventoryItemHistory | null> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile)) {
    throw new Error("Unauthorized: cannot view inventory");
  }
  await ensureOrdersSchema();

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.id, itemId))
    .limit(1);
  if (!item) return null;

  // RFQs touching this item.
  const rfqHits = await db
    .select({ line: rfqItems, rfq: rfqs })
    .from(rfqItems)
    .innerJoin(rfqs, eq(rfqs.id, rfqItems.rfqId))
    .where(eq(rfqItems.inventoryItemId, itemId))
    .orderBy(desc(rfqs.createdAt));

  // Pull every quote line that targets any of those RFQ items.
  const rfqLineIds = rfqHits.map((r) => r.line.id);
  const quoteRows = rfqLineIds.length > 0
    ? await db
        .select({
          line: supplierQuoteLines,
          quote: supplierQuotes,
          supplierName: suppliers.name,
        })
        .from(supplierQuoteLines)
        .innerJoin(supplierQuotes, eq(supplierQuotes.id, supplierQuoteLines.quoteId))
        .leftJoin(suppliers, eq(suppliers.id, supplierQuotes.supplierId))
        .where(inArray(supplierQuoteLines.rfqItemId, rfqLineIds))
    : [];
  // Bucket quote rows by rfq_item_id.
  const quotesByItem = new Map<number, Array<{ quote: SupplierQuote; line: SupplierQuoteLine; supplierName: string }>>();
  for (const q of quoteRows) {
    if (q.line.rfqItemId == null) continue;
    const arr = quotesByItem.get(q.line.rfqItemId) ?? [];
    arr.push({ quote: q.quote, line: q.line, supplierName: q.supplierName ?? q.quote.companyName });
    quotesByItem.set(q.line.rfqItemId, arr);
  }

  // POs touching this item (post-award, so the supplier is known).
  const poHits = await db
    .select({ line: purchaseOrderLines, po: purchaseOrders })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(eq(purchaseOrderLines.inventoryItemId, itemId))
    .orderBy(desc(purchaseOrders.createdAt));

  return {
    item,
    rfqs: rfqHits.map((r) => ({
      rfq: r.rfq,
      line: r.line,
      quoteLines: quotesByItem.get(r.line.id) ?? [],
    })),
    pos: poHits.map((p) => ({ po: p.po, line: p.line })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE UPDATES — rename / archive / set defaults
// ─────────────────────────────────────────────────────────────────────────────

export async function updateInventoryItem(input: {
  itemId: number;
  name?: string;
  description?: string;
  category?: string;
  unit?: string;
  notes?: string;
  defaultSupplierId?: number | null;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const set: Partial<typeof inventoryItems.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = input.name.trim() || null;
  if (input.description !== undefined) set.description = input.description.trim() || null;
  if (input.category !== undefined) set.category = input.category.trim() || null;
  if (input.unit !== undefined && input.unit.trim()) set.unit = input.unit.trim();
  if (input.notes !== undefined) set.notes = input.notes.trim() || null;
  if (input.defaultSupplierId !== undefined) set.defaultSupplierId = input.defaultSupplierId;
  await db.update(inventoryItems).set(set).where(eq(inventoryItems.id, input.itemId));
  revalidatePath("/suppliers");
}

export async function archiveInventoryItem(input: {
  itemId: number;
  archived: boolean;
}): Promise<void> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  await db
    .update(inventoryItems)
    .set({ archived: input.archived, updatedAt: new Date() })
    .where(eq(inventoryItems.id, input.itemId));
  revalidatePath("/suppliers");
}

// Used by createRfq.ts to validate codes the buyer typed before insertion.
// Returns null when the code is unknown so the caller can decide whether
// to auto-create.
export async function findInventoryByCode(code: string): Promise<InventoryItem | null> {
  await ensureOrdersSchema();
  const trimmed = code.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(inventoryItems)
    .where(sql`LOWER(${inventoryItems.code}) = LOWER(${trimmed})`)
    .limit(1);
  return row ?? null;
}

// Suppress the unused-import lint — rfqRecipients is intentionally re-exported
// to keep the schema-import barrel narrow but isn't called from this module.
void rfqRecipients;
