"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { competitors, competitorProducts } from "@/db/schema";
import {
  extractCompetitor,
  refineCompetitor,
  type SourceFile,
  type CompetitorExtraction,
  type CompetitorProductExtraction,
} from "@/lib/ai/extract";
import {
  canViewCompetitors,
  canEdit,
  getOrCreateProfile,
} from "@/lib/permissions";

export type AiSourceUpload = {
  url: string;
  name: string;
  mime: string;
  size: number;
  blobPathname: string;
};

async function fetchAsBuffer(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch uploaded file (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFiles(uploads: AiSourceUpload[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const u of uploads) {
    const buf = await fetchAsBuffer(u.url);
    out.push({ buffer: buf, mime: u.mime, name: u.name });
  }
  return out;
}

export type AiCompetitorResult = {
  extraction: CompetitorExtraction;
  uploads: AiSourceUpload[];
};

async function ensureEditor() {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewCompetitors(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot edit competitors");
  }
}

/**
 * Filter the AI's product list down to entries that look real and aren't
 * already in the existing product set (case-insensitive name+code match).
 */
function pickNewProducts(
  incoming: CompetitorProductExtraction[],
  existing: { name: string; productCode: string | null }[],
): CompetitorProductExtraction[] {
  const seen = new Set(
    existing.map((e) => `${e.name.toLowerCase().trim()}|${(e.productCode ?? "").toLowerCase().trim()}`),
  );
  const out: CompetitorProductExtraction[] = [];
  for (const p of incoming) {
    const name = (p.name ?? "").trim();
    if (!name) continue;
    const key = `${name.toLowerCase()}|${(p.productCode ?? "").toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Bulk-insert AI-extracted products under a competitor. Returns the count of
 * rows created. Empty input is a no-op.
 */
async function insertProducts(
  competitorId: number,
  products: CompetitorProductExtraction[],
): Promise<number> {
  if (!products.length) return 0;
  await db.insert(competitorProducts).values(
    products.map((p) => ({
      competitorId,
      name: p.name,
      productCode: p.productCode || null,
      productCategory: p.productCategory || null,
      description: p.description || null,
      imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls.filter((u) => /^https?:\/\//i.test(u)) : [],
      sourceUrl: p.sourceUrl || null,
      specs: (p.specs ?? {}) as unknown as Record<string, string | string[]>,
    })),
  );
  return products.length;
}

export async function aiGenerateCompetitor(input: {
  uploads: AiSourceUpload[];
  url?: string;
}): Promise<AiCompetitorResult> {
  await ensureEditor();
  if (!input.uploads.length && !input.url?.trim()) {
    throw new Error("Provide at least one file or a website URL");
  }

  const files = await loadFiles(input.uploads);
  const extraction = await extractCompetitor({
    files,
    url: input.url?.trim() || undefined,
  });
  return { extraction, uploads: input.uploads };
}

/**
 * Persist AI-extracted products under a brand-new competitor created by the
 * client. Called from the save handler in CompetitorsView right after
 * `upsertCompetitor` returns the new id.
 */
export async function aiPersistProducts(input: {
  competitorId: number;
  products: CompetitorProductExtraction[];
}): Promise<{ inserted: number }> {
  await ensureEditor();
  const inserted = await insertProducts(input.competitorId, input.products);
  return { inserted };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFINE — update an existing competitor record from new files/URL
// ─────────────────────────────────────────────────────────────────────────────

export type AiCompetitorRefineInput = {
  competitorId: number;
  uploads: AiSourceUpload[];
  url?: string;
};
export type AiCompetitorRefineResult = {
  extraction: CompetitorExtraction;
  uploads: AiSourceUpload[];
};

export async function aiRefineCompetitor(
  input: AiCompetitorRefineInput,
): Promise<AiCompetitorRefineResult & { productsInserted: number }> {
  await ensureEditor();
  if (!input.uploads.length && !input.url?.trim()) {
    throw new Error("Provide at least one file or a website URL");
  }
  const [row] = await db
    .select()
    .from(competitors)
    .where(eq(competitors.id, input.competitorId))
    .limit(1);
  if (!row) throw new Error("Competitor not found");

  const files = await loadFiles(input.uploads);
  const extraction = await refineCompetitor(
    {
      name: row.name,
      website: row.website ?? "",
      parent: row.parent ?? "",
      tierKey: row.tierKey,
      tier: row.tier ?? "",
      segment: row.segment ?? "",
      country: row.country ?? "",
      productLines: row.productLines ?? "",
      channel: row.channel ?? "",
      notes: row.notes ?? "",
      capabilities: row.capabilities,
    },
    { files, url: input.url?.trim() || undefined },
  );

  // Auto-insert any newly-evidenced products that don't already exist for
  // this competitor (matched by name+productCode).
  const existing = await db
    .select({ name: competitorProducts.name, productCode: competitorProducts.productCode })
    .from(competitorProducts)
    .where(eq(competitorProducts.competitorId, input.competitorId));
  const fresh = pickNewProducts(extraction.products ?? [], existing);
  const productsInserted = await insertProducts(input.competitorId, fresh);

  return { extraction, uploads: input.uploads, productsInserted };
}
