"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "@/db";
import {
  competitorIdeationItems,
  ideationItemProducts,
} from "@/db/schema";
import { requireCompetitorEditor } from "@/lib/permissions";
import { fetchWithTimeout } from "@/lib/ai/parsers";
import { extractPinterestImagesViaBrowser } from "@/lib/ai/pinterest";

const KIND_KEYS = [
  // Architectural-lighting brainstorm categories. Keep the original
  // "reference" / "sketch" / "moodboard" / "mounting" / "ai-generated"
  // values for backwards compatibility with existing data.
  "reference",
  "sketch",
  "moodboard",
  "mounting",
  "lens",
  "decorative",
  "profile",
  "finish",
  "optic",
  "endcap",
  "effect",
  "control",
  "ai-generated",
] as const;
type KindKey = (typeof KIND_KEYS)[number];
function asKindKey(v: unknown): KindKey {
  return KIND_KEYS.includes(v as KindKey) ? (v as KindKey) : "reference";
}

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function cleanStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);
}

export type IdeationItemInput = {
  collectionId: number;
  title?: string | null;
  notes?: string | null;
  imageUrl: string;
  blobPathname?: string | null;
  mimeType?: string | null;
  size?: number;
  kind?: string;
  competitorId?: number | null;
  productId?: number | null;
  tags?: string[];
};

export async function addIdeationItem(input: IdeationItemInput) {
  const profile = await requireCompetitorEditor();
  const imageUrl = cleanString(input.imageUrl);
  if (!imageUrl) throw new Error("Image URL is required");

  const [row] = await db
    .insert(competitorIdeationItems)
    .values({
      collectionId: input.collectionId,
      title: cleanString(input.title),
      notes: cleanString(input.notes),
      imageUrl,
      blobPathname: cleanString(input.blobPathname),
      mimeType: cleanString(input.mimeType),
      size: typeof input.size === "number" ? input.size : 0,
      kind: asKindKey(input.kind),
      competitorId: input.competitorId ?? null,
      productId: input.productId ?? null,
      tags: cleanStringArray(input.tags),
      addedByClerkId: profile.clerkUserId,
    })
    .returning();
  revalidatePath("/competitors");
  return row;
}

export type IdeationItemUpdate = {
  id: number;
  title?: string | null;
  notes?: string | null;
  kind?: string;
  competitorId?: number | null;
  productId?: number | null;
  tags?: string[];
  // Sketch-stroke payload — see schema for shape.
  annotations?: Record<string, unknown>;
};

export async function updateIdeationItem(input: IdeationItemUpdate) {
  await requireCompetitorEditor();
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if ("title" in input) values.title = cleanString(input.title);
  if ("notes" in input) values.notes = cleanString(input.notes);
  if ("kind" in input) values.kind = asKindKey(input.kind);
  if ("competitorId" in input) values.competitorId = input.competitorId ?? null;
  if ("productId" in input) values.productId = input.productId ?? null;
  if ("tags" in input) values.tags = cleanStringArray(input.tags);
  if ("annotations" in input && input.annotations && typeof input.annotations === "object") {
    values.annotations = input.annotations;
  }
  await db
    .update(competitorIdeationItems)
    .set(values)
    .where(eq(competitorIdeationItems.id, input.id));
  revalidatePath("/competitors");
}

/**
 * Append a new image URL (and optional blob pathname) to an ideation
 * item's extra-images array. The primary `imageUrl` stays untouched —
 * extras are additional images shown alongside the cover in the drawer
 * carousel.
 */
export async function addIdeationItemExtraImage(input: {
  itemId: number;
  url: string;
  blobPathname?: string | null;
}) {
  await requireCompetitorEditor();
  const url = cleanString(input.url);
  if (!url) throw new Error("Image URL is required");
  const blobPathname = cleanString(input.blobPathname);
  // Read current arrays, append, write back. SQL array-append would be
  // marginally cheaper but Drizzle's typed update keeps the column
  // shape obvious.
  const [row] = await db
    .select({
      extraImageUrls: competitorIdeationItems.extraImageUrls,
      extraBlobPathnames: competitorIdeationItems.extraBlobPathnames,
    })
    .from(competitorIdeationItems)
    .where(eq(competitorIdeationItems.id, input.itemId))
    .limit(1);
  if (!row) throw new Error("Ideation item not found");
  const nextUrls = [...(row.extraImageUrls ?? []), url];
  const nextPathnames = [...(row.extraBlobPathnames ?? []), blobPathname ?? ""];
  await db
    .update(competitorIdeationItems)
    .set({
      extraImageUrls: nextUrls,
      extraBlobPathnames: nextPathnames,
      updatedAt: new Date(),
    })
    .where(eq(competitorIdeationItems.id, input.itemId));
  revalidatePath("/competitors");
}

/**
 * Remove the image at the given index from an ideation item's
 * extra-images array. The primary cover image (imageUrl) is never
 * touched by this action — drop the whole card if you need to remove
 * the cover.
 */
export async function removeIdeationItemExtraImage(input: {
  itemId: number;
  index: number;
}) {
  await requireCompetitorEditor();
  const [row] = await db
    .select({
      extraImageUrls: competitorIdeationItems.extraImageUrls,
      extraBlobPathnames: competitorIdeationItems.extraBlobPathnames,
    })
    .from(competitorIdeationItems)
    .where(eq(competitorIdeationItems.id, input.itemId))
    .limit(1);
  if (!row) throw new Error("Ideation item not found");
  const urls = row.extraImageUrls ?? [];
  const pathnames = row.extraBlobPathnames ?? [];
  if (input.index < 0 || input.index >= urls.length) {
    throw new Error("Image index out of range");
  }
  // If we own the blob, drop it from storage so we don't leak.
  const droppedPathname = pathnames[input.index];
  const droppedUrl = urls[input.index];
  if (droppedPathname) {
    try {
      await del(droppedUrl);
    } catch (e) {
      console.warn("[removeIdeationItemExtraImage] blob removal failed:", e);
    }
  }
  const nextUrls = [
    ...urls.slice(0, input.index),
    ...urls.slice(input.index + 1),
  ];
  const nextPathnames = [
    ...pathnames.slice(0, input.index),
    ...pathnames.slice(input.index + 1),
  ];
  await db
    .update(competitorIdeationItems)
    .set({
      extraImageUrls: nextUrls,
      extraBlobPathnames: nextPathnames,
      updatedAt: new Date(),
    })
    .where(eq(competitorIdeationItems.id, input.itemId));
  revalidatePath("/competitors");
}

export async function deleteIdeationItem(id: number) {
  await requireCompetitorEditor();
  const [row] = await db
    .select()
    .from(competitorIdeationItems)
    .where(eq(competitorIdeationItems.id, id))
    .limit(1);
  if (row?.blobPathname) {
    try {
      await del(row.imageUrl);
    } catch (e) {
      console.error("Failed to remove ideation blob", row.blobPathname, e);
    }
  }
  // Drop any extra images we own (Pinterest URLs lack a blob pathname,
  // we just leave those — Pinterest hosts them).
  const extraUrls = row?.extraImageUrls ?? [];
  const extraPathnames = row?.extraBlobPathnames ?? [];
  for (let i = 0; i < extraUrls.length; i++) {
    if (!extraPathnames[i]) continue;
    try {
      await del(extraUrls[i]);
    } catch (e) {
      console.warn("Failed to remove extra ideation blob", extraPathnames[i], e);
    }
  }
  await db.delete(competitorIdeationItems).where(eq(competitorIdeationItems.id, id));
  revalidatePath("/competitors");
}

/**
 * Wipe every ideation item in the given collection. Each item with a stored
 * Vercel Blob is removed from blob storage too — Pinterest URLs aren't ours
 * to delete (they're on i.pinimg.com), so for those we just drop the row.
 */
export async function deleteAllIdeationItems(input: {
  collectionId: number;
}): Promise<{ deletedCount: number; blobsRemoved: number }> {
  await requireCompetitorEditor();
  const rows = await db
    .select({
      id: competitorIdeationItems.id,
      imageUrl: competitorIdeationItems.imageUrl,
      blobPathname: competitorIdeationItems.blobPathname,
    })
    .from(competitorIdeationItems)
    .where(eq(competitorIdeationItems.collectionId, input.collectionId));

  let blobsRemoved = 0;
  for (const r of rows) {
    if (!r.blobPathname) continue;
    try {
      await del(r.imageUrl);
      blobsRemoved++;
    } catch (e) {
      console.warn("[deleteAllIdeationItems] blob removal failed", r.blobPathname, e);
    }
  }
  await db
    .delete(competitorIdeationItems)
    .where(eq(competitorIdeationItems.collectionId, input.collectionId));
  revalidatePath("/competitors");
  return { deletedCount: rows.length, blobsRemoved };
}

// ─────────────────────────────────────────────────────────────────────────────
// PINTEREST EXTRACTOR — turns a board / pin / profile URL into ideation cards
// ─────────────────────────────────────────────────────────────────────────────
//
// Static HTML only contains 3-4 of the visible images. The carousel of
// multi-image pins and the full "more like this" feed below load via API
// calls after JS hydration. To capture everything visible, we render the
// page through Chromium and listen on the network for every i.pinimg.com
// response (extractor in @/lib/ai/pinterest).

export type PinterestExtractResult = {
  imageCount: number;
  duplicateCount: number;
  sourceUrl: string;
};

export async function aiAddPinterestLink(input: {
  collectionId: number;
  url: string;
  comment?: string | null;
  /** Category to assign to every imported card. Defaults to "moodboard". */
  kind?: string;
  /**
   * How the imported cards link to ideation products in this collection.
   *   - omitted / { kind: "all" }: each card is global (applies to every product).
   *   - { kind: "product", productId }: each card is non-global and gets a
   *     single junction row pointing at that product.
   * Cards can always be re-linked from their detail drawer afterwards.
   */
  productLinkage?:
    | { kind: "all" }
    | { kind: "product"; productId: number };
}): Promise<PinterestExtractResult> {
  await requireCompetitorEditor();
  const url = (input.url ?? "").trim();
  const comment = (input.comment ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Pinterest URL must start with http(s)://");
  }

  // Verify the URL is reachable before paying for a Chromium spin-up.
  // 404 / 410 fail-fast; other HEAD errors are tolerated since Pinterest
  // sometimes blocks HEAD on certain endpoints.
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        },
      },
      8_000,
    );
    if (res.status === 404 || res.status === 410) {
      throw new Error(`Pinterest returned ${res.status} for that URL.`);
    }
  } catch (e) {
    if (e instanceof Error && /^Pinterest returned/.test(e.message)) throw e;
    // Other errors are fine — let the browser extractor try.
  }

  // Browser-driven extraction — captures every image that loads while the
  // page hydrates, including the multi-image carousel and the lazy-loaded
  // related-pins grid below.
  const t0 = Date.now();
  const { images } = await extractPinterestImagesViaBrowser(url);
  const imageUrls = new Set(images);
  console.log(
    `[pinterest] extracted ${imageUrls.size} unique images from ${url} in ${Date.now() - t0}ms`,
  );

  if (imageUrls.size === 0) {
    throw new Error(
      "Couldn't pull any images. Make sure the URL is a public Pinterest board, pin, or profile (and not a private board or login-only page).",
    );
  }

  // Dedupe against existing items in this collection — same image URL
  // already on the board shouldn't be duplicated. If the table doesn't
  // exist yet (fresh DB without migrations applied), fall through with no
  // duplicates — the insert below will throw the same friendly message.
  let existingSet = new Set<string>();
  try {
    const existingItems = await db
      .select({ imageUrl: competitorIdeationItems.imageUrl })
      .from(competitorIdeationItems)
      .where(eq(competitorIdeationItems.collectionId, input.collectionId));
    existingSet = new Set(existingItems.map((i) => i.imageUrl));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/competitor_ideation_items.*does not exist|relation .* does not exist/i.test(msg)) {
      throw new Error(
        "Ideation table missing. Run `npm run db:apply` to create it, then retry.",
      );
    }
    throw e;
  }
  const newImages = [...imageUrls].filter((u) => !existingSet.has(u));
  const duplicateCount = imageUrls.size - newImages.length;

  if (newImages.length === 0) {
    return {
      imageCount: 0,
      duplicateCount,
      sourceUrl: url,
    };
  }

  // Insert one row per unique image. Title = "Pinterest · {host slug}",
  // notes = the user's comment. Cap at 60 inserts per call so a giant
  // board doesn't blow the request budget — user can paste again to grab
  // more.
  const titlePrefix = (() => {
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      return segs.slice(0, 2).join(" / ") || "Pinterest";
    } catch {
      return "Pinterest";
    }
  })();
  const kind = asKindKey(input.kind ?? "moodboard");
  // Decide the linkage shape for this batch. Defaults to "all" — cards land
  // global (applies to every product), matching the pre-products behaviour
  // and giving users freedom to re-link individual cards later.
  const linkage = input.productLinkage ?? { kind: "all" as const };
  const isGlobal = linkage.kind === "all";
  const rows = newImages.slice(0, 60).map((imageUrl) => ({
    collectionId: input.collectionId,
    imageUrl,
    title: titlePrefix,
    notes: comment || null,
    kind,
    isGlobal,
    // Stash the originating Pinterest URL in tags so the user can trace
    // which paste produced this card.
    tags: [`pinterest:${url}`],
  }));
  const inserted = await db
    .insert(competitorIdeationItems)
    .values(rows)
    .returning({ id: competitorIdeationItems.id });

  // Junction rows when locked to a single product.
  if (linkage.kind === "product" && inserted.length > 0) {
    const junctionRows = inserted.map((r) => ({
      ideationItemId: r.id,
      productId: linkage.productId,
    }));
    try {
      await db.insert(ideationItemProducts).values(junctionRows);
    } catch (e) {
      // If migration 0007 hasn't been applied, the junction table doesn't
      // exist yet. Insert silently fails and we leave the cards as global —
      // user can link them from the drawer once products are migrated.
      console.warn(
        "[pinterest] ideation_item_products insert failed (migration not applied?):",
        e,
      );
    }
  }
  revalidatePath("/competitors");

  return {
    imageCount: rows.length,
    duplicateCount,
    sourceUrl: url,
  };
}
