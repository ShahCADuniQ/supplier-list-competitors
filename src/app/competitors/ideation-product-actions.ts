"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  ideationProducts,
  ideationItemProducts,
  competitorIdeationItems,
} from "@/db/schema";
import { requireCompetitorEditor } from "@/lib/permissions";

// Default palette for new products — pulls from the SaaS dashboard chart
// colors so each product gets a distinct, dark-mode-friendly hue.
const DEFAULT_COLORS = [
  "#2563ff", // cobalt
  "#4ade80", // lime
  "#ff4d2e", // orange
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#34d399", // teal
];

function pickDefaultColor(usedColors: string[]): string {
  for (const c of DEFAULT_COLORS) {
    if (!usedColors.includes(c)) return c;
  }
  return DEFAULT_COLORS[0];
}

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Detect Postgres "relation does not exist" wrapped in any Drizzle layer.
// Drizzle stringifies failed queries as "Failed query: select ... from
// 'ideation_products' ..." — we look for the table name in either the
// outer message OR any nested cause chain so the user gets a clear
// "apply migration 0007" hint instead of raw SQL.
function isMissingProductsTable(err: unknown): boolean {
  const collected: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      collected.push(cur.message);
      cur = (cur as Error & { cause?: unknown }).cause;
    } else if (typeof cur === "string") {
      collected.push(cur);
      cur = null;
    } else {
      cur = null;
    }
  }
  const blob = collected.join(" | ");
  return (
    /relation\s+"?(?:public\.)?(?:ideation_products|ideation_item_products)"?\s+does\s+not\s+exist/i.test(
      blob,
    ) ||
    /ideation_products.*does not exist/i.test(blob) ||
    /ideation_item_products.*does not exist/i.test(blob) ||
    // Drizzle's wrapper just prints the SQL; if our action only ever
    // touches these tables, a generic "Failed query" with the table name
    // present is also a strong signal.
    (/Failed query/i.test(blob) &&
      /\bideation_products\b|\bideation_item_products\b/i.test(blob))
  );
}

const MIGRATION_HINT =
  'Database migration 0007 hasn\'t been applied. Run "npm run db:apply" against your database, then try again.';

export async function addIdeationProduct(input: {
  collectionId: number;
  name: string;
  color?: string;
  description?: string | null;
}) {
  await requireCompetitorEditor();
  const name = cleanString(input.name);
  if (!name) throw new Error("Product name is required");
  try {
    const existing = await db
      .select({ color: ideationProducts.color })
      .from(ideationProducts)
      .where(eq(ideationProducts.collectionId, input.collectionId));
    const color =
      cleanString(input.color) ?? pickDefaultColor(existing.map((e) => e.color));
    const [row] = await db
      .insert(ideationProducts)
      .values({
        collectionId: input.collectionId,
        name,
        color,
        description: cleanString(input.description),
      })
      .returning();
    revalidatePath("/competitors");
    return row;
  } catch (e) {
    if (isMissingProductsTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

export async function updateIdeationProduct(input: {
  id: number;
  name?: string;
  description?: string | null;
  color?: string;
  sortOrder?: number;
}) {
  await requireCompetitorEditor();
  const values: Record<string, unknown> = { updatedAt: new Date() };
  const cleanedName = cleanString(input.name);
  if (cleanedName !== null) values.name = cleanedName;
  if ("description" in input) values.description = cleanString(input.description);
  const cleanedColor = cleanString(input.color);
  if (cleanedColor !== null) values.color = cleanedColor;
  if ("sortOrder" in input && typeof input.sortOrder === "number") {
    values.sortOrder = input.sortOrder;
  }
  try {
    await db
      .update(ideationProducts)
      .set(values)
      .where(eq(ideationProducts.id, input.id));
    revalidatePath("/competitors");
  } catch (e) {
    if (isMissingProductsTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

export async function deleteIdeationProduct(id: number) {
  await requireCompetitorEditor();
  try {
    // Junction rows cascade-delete via FK ON DELETE CASCADE.
    // Items themselves are untouched — they just lose this specific linkage.
    await db.delete(ideationProducts).where(eq(ideationProducts.id, id));
    revalidatePath("/competitors");
  } catch (e) {
    if (isMissingProductsTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

/**
 * Replace the set of products an ideation item is linked to.
 * - If `isGlobal` is true, the item applies to every product in the
 *   collection. Junction rows are cleared.
 * - If `isGlobal` is false, junction rows are rewritten to match
 *   `productIds` exactly.
 */
export async function setIdeationItemProducts(input: {
  itemId: number;
  isGlobal: boolean;
  productIds: number[];
}) {
  await requireCompetitorEditor();
  try {
    await db
      .update(competitorIdeationItems)
      .set({ isGlobal: input.isGlobal, updatedAt: new Date() })
      .where(eq(competitorIdeationItems.id, input.itemId));

    // Wipe existing linkages, then rewrite if not global.
    await db
      .delete(ideationItemProducts)
      .where(eq(ideationItemProducts.ideationItemId, input.itemId));

    if (!input.isGlobal && input.productIds.length > 0) {
      const dedupedIds = Array.from(new Set(input.productIds));
      const rows = dedupedIds.map((pid) => ({
        ideationItemId: input.itemId,
        productId: pid,
      }));
      await db.insert(ideationItemProducts).values(rows);
    }

    revalidatePath("/competitors");
  } catch (e) {
    if (isMissingProductsTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}
