"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "@/db";
import { ideationProductFiles } from "@/db/schema";
import { requireCompetitorEditor } from "@/lib/permissions";

// Slots used by the IdeationProductDrawer are defined inline in that
// component (the DB column is plain text so we can add new kinds without
// touching this file). Server action files can only export async
// functions per Next.js — exporting the const array / type union here
// produced a build-time "use server" error.

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isMissingFilesTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /relation\s+"?(?:public\.)?ideation_product_files"?\s+does\s+not\s+exist/i.test(
      msg,
    ) ||
    /ideation_product_files.*does not exist/i.test(msg) ||
    (/Failed query/i.test(msg) && /\bideation_product_files\b/i.test(msg))
  );
}

const MIGRATION_HINT =
  'Database migration 0008 hasn\'t been applied. Run "npm run db:apply" against your database, then try again.';

export async function addProductFile(input: {
  collectionId: number;
  /** Null = collection-level file (e.g. brochure). Otherwise the product id. */
  productId: number | null;
  fileKind: string;
  name: string;
  size: number;
  mimeType: string | null;
  url: string;
  blobPathname: string | null;
}) {
  const profile = await requireCompetitorEditor();
  const url = cleanString(input.url);
  const name = cleanString(input.name);
  const fileKind = cleanString(input.fileKind);
  if (!url) throw new Error("File URL is required");
  if (!name) throw new Error("File name is required");
  if (!fileKind) throw new Error("File kind is required");

  try {
    const [row] = await db
      .insert(ideationProductFiles)
      .values({
        collectionId: input.collectionId,
        productId: input.productId,
        fileKind,
        name,
        size: input.size ?? 0,
        mimeType: cleanString(input.mimeType),
        url,
        blobPathname: cleanString(input.blobPathname),
        uploaderClerkId: profile.clerkUserId,
      })
      .returning();
    revalidatePath("/competitors");
    return row;
  } catch (e) {
    if (isMissingFilesTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

export async function deleteProductFile(id: number) {
  await requireCompetitorEditor();
  try {
    const [row] = await db
      .select()
      .from(ideationProductFiles)
      .where(eq(ideationProductFiles.id, id))
      .limit(1);
    // Drop the underlying blob (only ours — external URLs we ignore).
    if (row?.blobPathname) {
      try {
        await del(row.url);
      } catch (e) {
        console.warn("[deleteProductFile] blob removal failed:", e);
      }
    }
    await db.delete(ideationProductFiles).where(eq(ideationProductFiles.id, id));
    revalidatePath("/competitors");
  } catch (e) {
    if (isMissingFilesTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

/**
 * Replace the collection-level brochure (single-file slot). Wipes any
 * existing collection_brochure row for this collection then inserts the
 * new one in a single round-trip-ish flow. The old blob is removed too.
 */
export async function replaceCollectionBrochure(input: {
  collectionId: number;
  name: string;
  size: number;
  mimeType: string | null;
  url: string;
  blobPathname: string | null;
}) {
  const profile = await requireCompetitorEditor();
  try {
    // Find existing brochure row(s) for this collection so we can drop
    // the underlying blob.
    const existing = await db
      .select()
      .from(ideationProductFiles)
      .where(
        and(
          eq(ideationProductFiles.collectionId, input.collectionId),
          isNull(ideationProductFiles.productId),
          eq(ideationProductFiles.fileKind, "collection_brochure"),
        ),
      );
    for (const row of existing) {
      if (row.blobPathname) {
        try {
          await del(row.url);
        } catch (e) {
          console.warn("[replaceCollectionBrochure] blob removal failed:", e);
        }
      }
    }
    if (existing.length > 0) {
      await db
        .delete(ideationProductFiles)
        .where(
          and(
            eq(ideationProductFiles.collectionId, input.collectionId),
            isNull(ideationProductFiles.productId),
            eq(ideationProductFiles.fileKind, "collection_brochure"),
          ),
        );
    }
    const [row] = await db
      .insert(ideationProductFiles)
      .values({
        collectionId: input.collectionId,
        productId: null,
        fileKind: "collection_brochure",
        name: input.name,
        size: input.size ?? 0,
        mimeType: cleanString(input.mimeType),
        url: input.url,
        blobPathname: cleanString(input.blobPathname),
        uploaderClerkId: profile.clerkUserId,
      })
      .returning();
    revalidatePath("/competitors");
    return row;
  } catch (e) {
    if (isMissingFilesTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}

export async function deleteCollectionBrochure(collectionId: number) {
  await requireCompetitorEditor();
  try {
    const existing = await db
      .select()
      .from(ideationProductFiles)
      .where(
        and(
          eq(ideationProductFiles.collectionId, collectionId),
          isNull(ideationProductFiles.productId),
          eq(ideationProductFiles.fileKind, "collection_brochure"),
        ),
      );
    for (const row of existing) {
      if (row.blobPathname) {
        try {
          await del(row.url);
        } catch (e) {
          console.warn("[deleteCollectionBrochure] blob removal failed:", e);
        }
      }
    }
    await db
      .delete(ideationProductFiles)
      .where(
        and(
          eq(ideationProductFiles.collectionId, collectionId),
          isNull(ideationProductFiles.productId),
          eq(ideationProductFiles.fileKind, "collection_brochure"),
        ),
      );
    revalidatePath("/competitors");
  } catch (e) {
    if (isMissingFilesTable(e)) throw new Error(MIGRATION_HINT);
    throw e;
  }
}
