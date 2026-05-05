"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  competitors,
  competitorProducts,
} from "@/db/schema";
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
import { attachProductDocument } from "./_attachments";

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
 * Bulk-insert AI-extracted products under a competitor. Returns the inserted
 * rows so callers can attach specsheets after the fact. Empty input is a no-op.
 */
async function insertProducts(
  competitorId: number,
  products: CompetitorProductExtraction[],
): Promise<Array<{ id: number; specsheetUrl: string }>> {
  if (!products.length) return [];
  const rows = await db
    .insert(competitorProducts)
    .values(
      products.map((p) => ({
        competitorId,
        name: p.name,
        productCode: p.productCode || null,
        productCategory: p.productCategory || null,
        description: p.description || null,
        imageUrls: Array.isArray(p.imageUrls)
          ? p.imageUrls.filter((u) => /^https?:\/\//i.test(u))
          : [],
        sourceUrl: p.sourceUrl || null,
        specs: (p.specs ?? {}) as unknown as Record<string, string | string[]>,
      })),
    )
    .returning({ id: competitorProducts.id });
  return rows.map((r, i) => ({
    id: r.id,
    specsheetUrl: products[i].specsheetUrl ?? "",
  }));
}

/**
 * Fire-and-forget specsheet attachments for the given product rows. Bounded
 * concurrency (3 in flight) so a website with 25 PDFs doesn't bury the event
 * loop. Returns the count of successful attachments.
 */
async function attachSpecsheets(
  rows: Array<{ id: number; specsheetUrl: string }>,
): Promise<number> {
  const targets = rows.filter((r) => r.specsheetUrl);
  if (!targets.length) return 0;
  let attached = 0;
  const queue = [...targets];
  const POOL = 3;
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      if (!r) return;
      const ok = await attachProductDocument(r.id, r.specsheetUrl);
      if (ok) attached++;
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));
  return attached;
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
 * `upsertCompetitor` returns the new id. Also fetches and attaches the
 * specsheet PDF for every product where the extractor surfaced one.
 */
export async function aiPersistProducts(input: {
  competitorId: number;
  products: CompetitorProductExtraction[];
}): Promise<{ inserted: number; specsheetsAttached: number }> {
  await ensureEditor();
  const rows = await insertProducts(input.competitorId, input.products);
  const specsheetsAttached = await attachSpecsheets(rows);
  return { inserted: rows.length, specsheetsAttached };
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
  const insertedRows = await insertProducts(input.competitorId, fresh);
  await attachSpecsheets(insertedRows);
  const productsInserted = insertedRows.length;

  return { extraction, uploads: input.uploads, productsInserted };
}
