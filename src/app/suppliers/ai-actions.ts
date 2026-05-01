"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import {
  extractSupplier,
  extractProjectEntry,
  refineSupplier,
  webResearchSupplier,
  type SourceFile,
  type SupplierExtraction,
  type ProjectEntryExtraction,
  type SupplierWebResearch,
} from "@/lib/ai/extract";
import {
  requireSupplierEditor,
  canViewSuppliers,
  canEdit,
  getOrCreateProfile,
} from "@/lib/permissions";

/**
 * Each entry is a Blob URL that has already been uploaded by the client. We
 * fetch the bytes server-side, run extraction, and return the structured data.
 * The Blob URLs persist — the client decides whether to keep them as
 * attachments (on save) or revoke them (on cancel).
 */
export type AiSourceUpload = {
  url: string;          // public Blob URL
  name: string;         // original filename for prompt context
  mime: string;
  size: number;         // bytes — needed for the attachment record
  blobPathname: string; // for later attachment-record creation
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

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER — generate the whole record from files + URL
// ─────────────────────────────────────────────────────────────────────────────

export type AiSupplierResult = {
  extraction: SupplierExtraction;
  /** Same uploads handed in, returned for the client to attach on save. */
  uploads: AiSourceUpload[];
};

export async function aiGenerateSupplier(input: {
  uploads: AiSourceUpload[];
  url?: string;
}): Promise<AiSupplierResult> {
  // Read access alone is enough to *preview* — saving requires editor.
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot generate suppliers");
  }
  if (!input.uploads.length && !input.url?.trim()) {
    throw new Error("Provide at least one file or a website URL");
  }

  const files = await loadFiles(input.uploads);
  const extraction = await extractSupplier({
    files,
    url: input.url?.trim() || undefined,
  });
  return { extraction, uploads: input.uploads };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT ENTRY — generate from a single PO/invoice file
// ─────────────────────────────────────────────────────────────────────────────

export type AiProjectEntryResult = {
  extraction: ProjectEntryExtraction;
  upload: AiSourceUpload;
};

export async function aiGenerateProjectEntry(input: {
  upload: AiSourceUpload;
}): Promise<AiProjectEntryResult> {
  await requireSupplierEditor();
  const buf = await fetchAsBuffer(input.upload.url);
  const extraction = await extractProjectEntry({
    buffer: buf,
    mime: input.upload.mime,
    name: input.upload.name,
  });
  return { extraction, upload: input.upload };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFINE — feed new files/URL into an existing supplier and return refined
// fields. The client decides whether to apply or revert.
// ─────────────────────────────────────────────────────────────────────────────

export type AiSupplierRefineInput = {
  supplierId: number;
  uploads: AiSourceUpload[];
  url?: string;
};
export type AiSupplierRefineResult = {
  extraction: SupplierExtraction;
  uploads: AiSourceUpload[];
};

export async function aiRefineSupplier(
  input: AiSupplierRefineInput,
): Promise<AiSupplierRefineResult> {
  await requireSupplierEditor();
  if (!input.uploads.length && !input.url?.trim()) {
    throw new Error("Provide at least one file or a website URL");
  }
  const [row] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!row) throw new Error("Supplier not found");

  const files = await loadFiles(input.uploads);
  const extraction = await refineSupplier(
    {
      name: row.name,
      category: row.category ?? "",
      subCategory: row.subCategory ?? "",
      origin: row.origin ?? "",
      status: row.status,
      website: row.website ?? "",
      email: row.email ?? "",
      phone: row.phone ?? "",
      contactName: row.contactName ?? "",
      products: row.products ?? "",
      notes: row.notes ?? "",
    },
    { files, url: input.url?.trim() || undefined },
  );
  return { extraction, uploads: input.uploads };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB RESEARCH — uses GPT's web_search tool to look up website + manufacturing
// info for a supplier. Read-only: returns suggestions; client decides to apply.
// ─────────────────────────────────────────────────────────────────────────────

export async function aiResearchSupplier(supplierId: number): Promise<SupplierWebResearch> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot research suppliers");
  }
  const [row] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!row) throw new Error("Supplier not found");

  return webResearchSupplier({
    name: row.name,
    category: row.category,
    origin: row.origin,
    products: row.products,
    website: row.website,
  });
}
