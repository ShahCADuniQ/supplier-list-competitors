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
  // Optional IFC-extracted properties — populated on first creation only.
  // For an existing part we leave these untouched so a re-parse doesn't
  // clobber manually-edited values.
  kind?: "part" | "assembly";
  parentAssemblyId?: number | null;
  weightG?: number | null;
  surfaceAreaMm2?: number | null;
  volumeMm3?: number | null;
  material?: string | null;
  densityGCm3?: number | null;
  thumbnailUrl?: string;
  thumbnailPathname?: string;
  ifcSourceUrl?: string;
  ifcSourceName?: string;
  // When true (set by the IFC AutoFill flow) and `code` is blank, look
  // for an existing inventory row that matches the part/assembly's
  // signature (name + material + volume) before minting a new code. This
  // is how re-importing a project that shares parts with prior projects
  // keeps the inventory de-duplicated — the new RFQ gets linked to the
  // EXISTING part instead of spawning a fresh LB-NNNNNN.
  matchExistingBySignature?: boolean;
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
        kind: input.kind ?? "part",
        parentAssemblyId: input.parentAssemblyId ?? null,
        weightG: input.weightG != null ? String(input.weightG) : null,
        surfaceAreaMm2: input.surfaceAreaMm2 != null ? String(input.surfaceAreaMm2) : null,
        volumeMm3: input.volumeMm3 != null ? String(input.volumeMm3) : null,
        material: input.material?.trim() || null,
        densityGCm3: input.densityGCm3 != null ? String(input.densityGCm3) : null,
        thumbnailUrl: input.thumbnailUrl ?? null,
        thumbnailPathname: input.thumbnailPathname ?? null,
        ifcSourceUrl: input.ifcSourceUrl ?? null,
        ifcSourceName: input.ifcSourceName ?? null,
        createdByClerkId: profile.clerkUserId,
      })
      .returning({ id: inventoryItems.id, code: inventoryItems.code });
    return { id: created.id, code: created.code, isNew: true };
  }

  // SIGNATURE MATCH — when the caller flagged matchExistingBySignature
  // (IFC AutoFill path), try to find an existing inventory row that
  // already represents this exact part/assembly. We never want to spawn
  // a duplicate LB-NNNNNN for the same screw / bracket / beam just
  // because the user re-uploaded a new project that uses it.
  //
  // Match rules:
  //   • Same kind (part-vs-assembly).
  //   • Same name (case-insensitive).
  //   • Same material (case-insensitive; treats null = null as a match).
  //   • For parts only: volume within ±1% — guards against two distinct
  //     parts that happen to share a name (e.g. "Bracket" of different sizes).
  if (input.matchExistingBySignature && input.name?.trim()) {
    const wantName = input.name.trim().toLowerCase();
    const wantMat = (input.material ?? "").trim().toLowerCase();
    const wantKind = input.kind ?? "part";
    const candidates = await db
      .select()
      .from(inventoryItems)
      .where(
        sql`LOWER(${inventoryItems.name}) = ${wantName}
          AND ${inventoryItems.kind} = ${wantKind}
          AND ${inventoryItems.archived} = false`,
      )
      .limit(20);
    // Some SolidWorks IFC exports ship the geometry + part name but ZERO
    // psets / material associations (CFG-template files with placeholder
    // dimensions). When the incoming line has no material AND no volume,
    // trust the name alone — otherwise the part-number match would fail
    // and we'd spawn a duplicate inventory row for the same screw / lens
    // already populated from a prior, pset-rich upload.
    const newHasMetadata = !!wantMat || input.volumeMm3 != null;
    for (const c of candidates) {
      if (newHasMetadata) {
        const cMat = (c.material ?? "").trim().toLowerCase();
        if (cMat !== wantMat) continue;
        // Volume sanity check for parts. Assemblies don't have meaningful
        // volume so we skip the check there.
        if (wantKind === "part" && input.volumeMm3 != null && c.volumeMm3 != null) {
          const cV = Number(c.volumeMm3);
          const dV = input.volumeMm3;
          if (cV > 0 && Math.abs(cV - dV) / cV > 0.01) continue;
        }
      }
      // Match! Reuse the existing inventory row — return isNew=false so
      // the caller knows it linked rather than created.
      //
      // Backfill any field that's null on the existing row but populated
      // on the new input. This is how a second upload (the one that
      // actually managed to render its isometric PNG) fills in the
      // thumbnail / IFC source URL that a previous upload left empty.
      // We DO NOT overwrite already-populated values — a human may have
      // typed a description or material in the inventory editor.
      const backfill: Partial<typeof inventoryItems.$inferInsert> = {};
      if (!c.thumbnailUrl && input.thumbnailUrl) {
        backfill.thumbnailUrl = input.thumbnailUrl;
        backfill.thumbnailPathname = input.thumbnailPathname ?? null;
      }
      if (!c.ifcSourceUrl && input.ifcSourceUrl) {
        backfill.ifcSourceUrl = input.ifcSourceUrl;
        backfill.ifcSourceName = input.ifcSourceName ?? null;
      }
      if (!c.description && input.description?.trim()) {
        backfill.description = input.description.trim();
      }
      if (!c.material && input.material?.trim()) {
        backfill.material = input.material.trim();
      }
      if (c.weightG == null && input.weightG != null) backfill.weightG = String(input.weightG);
      if (c.surfaceAreaMm2 == null && input.surfaceAreaMm2 != null) backfill.surfaceAreaMm2 = String(input.surfaceAreaMm2);
      if (c.volumeMm3 == null && input.volumeMm3 != null) backfill.volumeMm3 = String(input.volumeMm3);
      if (c.densityGCm3 == null && input.densityGCm3 != null) backfill.densityGCm3 = String(input.densityGCm3);
      if (Object.keys(backfill).length > 0) {
        await db.update(inventoryItems).set(backfill).where(eq(inventoryItems.id, c.id));
      }
      return { id: c.id, code: c.code, isNew: false };
    }
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
          kind: input.kind ?? "part",
          parentAssemblyId: input.parentAssemblyId ?? null,
          weightG: input.weightG != null ? String(input.weightG) : null,
          surfaceAreaMm2: input.surfaceAreaMm2 != null ? String(input.surfaceAreaMm2) : null,
          volumeMm3: input.volumeMm3 != null ? String(input.volumeMm3) : null,
          material: input.material?.trim() || null,
          densityGCm3: input.densityGCm3 != null ? String(input.densityGCm3) : null,
          thumbnailUrl: input.thumbnailUrl ?? null,
          thumbnailPathname: input.thumbnailPathname ?? null,
          ifcSourceUrl: input.ifcSourceUrl ?? null,
          ifcSourceName: input.ifcSourceName ?? null,
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
  // For an assembly: every child part with its own thumbnail + qty counts.
  // For a part: empty array.
  children: InventoryItemWithStats[];
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

  // For assemblies: pull every child part with its own rfq/po counts so
  // the detail view can render them as cards.
  let children: InventoryItemWithStats[] = [];
  if (item.kind === "assembly") {
    const childRows = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.parentAssemblyId, itemId))
      .orderBy(desc(inventoryItems.createdAt));
    if (childRows.length > 0) {
      const childIds = childRows.map((c) => c.id);
      const cRfqCounts = await db
        .select({
          id: rfqItems.inventoryItemId,
          n: sql<number>`COUNT(*)::int`,
          lastAt: sql<Date | null>`MAX(${rfqs.createdAt})`,
        })
        .from(rfqItems)
        .innerJoin(rfqs, eq(rfqs.id, rfqItems.rfqId))
        .where(inArray(rfqItems.inventoryItemId, childIds))
        .groupBy(rfqItems.inventoryItemId);
      const cPoCounts = await db
        .select({
          id: purchaseOrderLines.inventoryItemId,
          n: sql<number>`COUNT(*)::int`,
          lastAt: sql<Date | null>`MAX(${purchaseOrders.createdAt})`,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
        .where(inArray(purchaseOrderLines.inventoryItemId, childIds))
        .groupBy(purchaseOrderLines.inventoryItemId);
      const cRfqMap = new Map(cRfqCounts.map((r) => [r.id ?? -1, r]));
      const cPoMap = new Map(cPoCounts.map((r) => [r.id ?? -1, r]));
      children = childRows.map((c) => {
        const r = cRfqMap.get(c.id);
        const p = cPoMap.get(c.id);
        const lastR = r?.lastAt ? new Date(r.lastAt) : null;
        const lastP = p?.lastAt ? new Date(p.lastAt) : null;
        const lastActivityAt = lastP && lastR ? (lastP > lastR ? lastP : lastR) : (lastP ?? lastR ?? null);
        return {
          ...c,
          rfqCount: Number(r?.n ?? 0),
          poCount: Number(p?.n ?? 0),
          lastActivityAt,
        };
      });
    }
  }

  return {
    item,
    children,
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

// Hard delete an inventory item (part or assembly). Use with care — this
// is irreversible. To soft-remove a row from the list while keeping
// historical RFQ / PO references intact, use archiveInventoryItem.
//
// References on rfq_items and purchase_order_lines are not enforced by
// FK constraints (the columns intentionally have no .references in the
// schema), so the delete succeeds even when historical orders point at
// this id. Those rows are left pointing at a defunct id — same trade-off
// the existing archive flow accepts. Children of an assembly are not
// cascade-deleted by Postgres either; this action explicitly orphans
// them (NULLs parent_assembly_id) unless deleteChildren is requested.
export async function deleteInventoryItem(input: {
  itemId: number;
  // When the item is an assembly: should every child part be hard-
  // deleted too? Default false (orphan them so their files / histories
  // survive). True for assemblies that were created in error and have
  // no other purpose.
  deleteChildren?: boolean;
}): Promise<{ deletedChildren: number }> {
  await requireSupplierEditor();
  await ensureOrdersSchema();

  const [target] = await db
    .select({ id: inventoryItems.id, kind: inventoryItems.kind })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.itemId))
    .limit(1);
  if (!target) throw new Error("Inventory item not found");

  let deletedChildren = 0;
  if (target.kind === "assembly") {
    if (input.deleteChildren) {
      const res = await db
        .delete(inventoryItems)
        .where(eq(inventoryItems.parentAssemblyId, target.id))
        .returning({ id: inventoryItems.id });
      deletedChildren = res.length;
    } else {
      // Orphan the children so they keep showing in the parts list
      // and stay attached to their RFQ / PO history.
      await db
        .update(inventoryItems)
        .set({ parentAssemblyId: null, updatedAt: new Date() })
        .where(eq(inventoryItems.parentAssemblyId, target.id));
    }
  }

  await db.delete(inventoryItems).where(eq(inventoryItems.id, target.id));
  revalidatePath("/suppliers");
  return { deletedChildren };
}

// ─────────────────────────────────────────────────────────────────────────────
// QTY LIFECYCLE
//
// Two counters: pending_qty (RFQ-stage demand) + confirmed_qty (PO-sent).
// Inventory view shows both so the buyer can see e.g. "12 on standby · 8
// confirmed" for a part across every open RFQ.
// ─────────────────────────────────────────────────────────────────────────────

export async function bumpInventoryPendingQty(input: {
  inventoryItemId: number;
  delta: number;
}): Promise<void> {
  // No requireSupplierEditor — called internally from createRfq, which has
  // already authed. Skip the round-trip.
  await ensureOrdersSchema();
  await db
    .update(inventoryItems)
    .set({
      pendingQty: sql`GREATEST(0, ${inventoryItems.pendingQty} + ${input.delta})`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, input.inventoryItemId));
}

// Flips qty from "pending" to "confirmed" when a PO is sent. Subtracts
// `qty` from pending_qty (clamped at 0) and adds it to confirmed_qty.
export async function confirmInventoryQty(input: {
  inventoryItemId: number;
  qty: number;
}): Promise<void> {
  await ensureOrdersSchema();
  await db
    .update(inventoryItems)
    .set({
      pendingQty: sql`GREATEST(0, ${inventoryItems.pendingQty} - ${input.qty})`,
      confirmedQty: sql`${inventoryItems.confirmedQty} + ${input.qty}`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, input.inventoryItemId));
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
