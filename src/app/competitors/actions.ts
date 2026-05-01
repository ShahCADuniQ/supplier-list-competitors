"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "@/db";
import {
  competitorCollections,
  competitors,
  competitorAttachments,
} from "@/db/schema";
import { requireCompetitorEditor } from "@/lib/permissions";

const TIER_KEYS = ["mass", "mid", "spec", "premium"] as const;
type TierKey = (typeof TIER_KEYS)[number];
function asTierKey(v: unknown): TierKey {
  return TIER_KEYS.includes(v as TierKey) ? (v as TierKey) : "mid";
}

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────────────────────────────────────

export async function createCollection(name: string, description?: string) {
  const profile = await requireCompetitorEditor();
  const cleanName = cleanString(name);
  if (!cleanName) throw new Error("Collection name is required");
  const [row] = await db
    .insert(competitorCollections)
    .values({
      name: cleanName,
      description: cleanString(description),
      createdByClerkId: profile.clerkUserId,
    })
    .returning();
  revalidatePath("/competitors");
  return row;
}

export async function renameCollection(id: number, name: string) {
  await requireCompetitorEditor();
  const cleanName = cleanString(name);
  if (!cleanName) throw new Error("Collection name is required");
  await db
    .update(competitorCollections)
    .set({ name: cleanName, updatedAt: new Date() })
    .where(eq(competitorCollections.id, id));
  revalidatePath("/competitors");
}

export async function deleteCollection(id: number) {
  await requireCompetitorEditor();
  const remaining = await db.select({ id: competitorCollections.id }).from(competitorCollections);
  if (remaining.length <= 1) {
    throw new Error("Can't delete your only collection");
  }
  await db.delete(competitorCollections).where(eq(competitorCollections.id, id));
  revalidatePath("/competitors");
}

export async function duplicateCollection(id: number) {
  const profile = await requireCompetitorEditor();
  const [src] = await db
    .select()
    .from(competitorCollections)
    .where(eq(competitorCollections.id, id))
    .limit(1);
  if (!src) throw new Error("Collection not found");

  const [created] = await db
    .insert(competitorCollections)
    .values({
      name: `${src.name} (copy)`,
      description: src.description,
      createdByClerkId: profile.clerkUserId,
    })
    .returning();

  const srcRows = await db.select().from(competitors).where(eq(competitors.collectionId, id));
  if (srcRows.length) {
    await db.insert(competitors).values(
      srcRows.map((b) => ({
        collectionId: created.id,
        name: b.name,
        website: b.website,
        parent: b.parent,
        tierKey: b.tierKey,
        tier: b.tier,
        segment: b.segment,
        country: b.country,
        productLines: b.productLines,
        channel: b.channel,
        notes: b.notes,
        capabilities: b.capabilities,
      })),
    );
  }
  revalidatePath("/competitors");
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// Competitors (brands)
// ─────────────────────────────────────────────────────────────────────────────

export type CompetitorInput = {
  id?: number;
  collectionId: number;
  name: string;
  website?: string | null;
  parent?: string | null;
  tierKey?: string;
  tier?: string | null;
  segment?: string | null;
  country?: string | null;
  productLines?: string | null;
  channel?: string | null;
  notes?: string | null;
  capabilities?: string[];
};

export async function upsertCompetitor(input: CompetitorInput) {
  await requireCompetitorEditor();
  const name = cleanString(input.name);
  if (!name) throw new Error("Competitor name is required");

  const values = {
    collectionId: input.collectionId,
    name,
    website: cleanString(input.website),
    parent: cleanString(input.parent),
    tierKey: asTierKey(input.tierKey),
    tier: cleanString(input.tier),
    segment: cleanString(input.segment),
    country: cleanString(input.country),
    productLines: cleanString(input.productLines),
    channel: cleanString(input.channel),
    notes: cleanString(input.notes),
    capabilities: Array.isArray(input.capabilities)
      ? input.capabilities.filter((c) => typeof c === "string" && c.trim())
      : [],
    updatedAt: new Date(),
  };

  if (input.id) {
    await db.update(competitors).set(values).where(eq(competitors.id, input.id));
  } else {
    const [row] = await db.insert(competitors).values(values).returning();
    revalidatePath("/competitors");
    return row;
  }
  revalidatePath("/competitors");
}

export async function duplicateCompetitor(id: number) {
  await requireCompetitorEditor();
  const [src] = await db.select().from(competitors).where(eq(competitors.id, id)).limit(1);
  if (!src) throw new Error("Competitor not found");
  const [row] = await db
    .insert(competitors)
    .values({
      collectionId: src.collectionId,
      name: `${src.name} (copy)`,
      website: src.website,
      parent: src.parent,
      tierKey: src.tierKey,
      tier: src.tier,
      segment: src.segment,
      country: src.country,
      productLines: src.productLines,
      channel: src.channel,
      notes: src.notes,
      capabilities: src.capabilities,
    })
    .returning();
  revalidatePath("/competitors");
  return row;
}

export async function deleteCompetitor(id: number) {
  await requireCompetitorEditor();
  await db.delete(competitors).where(eq(competitors.id, id));
  revalidatePath("/competitors");
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────────────────────────────────────────

export type CompetitorAttachmentInput = {
  competitorId: number;
  name: string;
  size: number;
  mimeType?: string | null;
  url: string;
  blobPathname: string;
};

export async function addCompetitorAttachment(input: CompetitorAttachmentInput) {
  const profile = await requireCompetitorEditor();
  const name = cleanString(input.name);
  const url = cleanString(input.url);
  const blobPathname = cleanString(input.blobPathname);
  if (!name || !url || !blobPathname) {
    throw new Error("Attachment name and uploaded URL are required");
  }

  await db.insert(competitorAttachments).values({
    competitorId: input.competitorId,
    name,
    size: input.size,
    mimeType: cleanString(input.mimeType),
    url,
    blobPathname,
    uploaderClerkId: profile.clerkUserId,
  });
  revalidatePath("/competitors");
}

export async function deleteCompetitorAttachment(id: number) {
  await requireCompetitorEditor();
  const [row] = await db
    .select()
    .from(competitorAttachments)
    .where(eq(competitorAttachments.id, id))
    .limit(1);
  if (row?.blobPathname) {
    try {
      await del(row.url);
    } catch (e) {
      console.error("Failed to remove blob", row.blobPathname, e);
    }
  }
  await db.delete(competitorAttachments).where(eq(competitorAttachments.id, id));
  revalidatePath("/competitors");
}
