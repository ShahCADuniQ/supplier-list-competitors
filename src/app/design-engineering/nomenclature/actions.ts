"use server";

// Server actions for the Nomenclature Generator page.
//
// Surfaces five capabilities:
//
//   1. listStandards / listParts            — page hydration
//   2. importStandardsFromFolder            — manual re-scan trigger
//   3. saveHardwarePart / savePartCode      — record creation, both
//                                              of which also upsert a
//                                              matching inventory_items
//                                              row so the rest of the
//                                              ERP can reference the
//                                              new code immediately
//   4. extractHardwareFromUrlAction         — AI-from-URL extractor
//   5. addUserStandard                      — define a brand-new hardware
//                                              family (e.g. cable glands)
//                                              and write a matching
//                                              NOMENCLATURE_*.txt to the
//                                              OneDrive folder
//   6. deletePart                           — frees the unique ID and
//                                              detaches the inventory row.

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  inventoryItems,
  nomenclatureParts,
  nomenclatureStandards,
} from "@/db/schema";
import { getOrCreateProfile } from "@/lib/permissions";
import { ensureNomenclatureSchema } from "@/lib/nomenclature/_ensure-schema";
import {
  scanHardwaresFolder,
  writeNewStandardFile,
} from "@/lib/nomenclature/folder-scanner";
import { allocateUniqueId } from "@/lib/nomenclature/unique-id";
import { extractHardwareFromUrl } from "@/lib/nomenclature/ai-extract";

// ── Reads ────────────────────────────────────────────────────────────────

export type StandardRow = {
  id: number;
  slug: string;
  name: string;
  classCode: string;
  template: string;
  specText: string;
  userCreated: boolean;
};

export async function listStandards(): Promise<StandardRow[]> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({
      id: nomenclatureStandards.id,
      slug: nomenclatureStandards.slug,
      name: nomenclatureStandards.name,
      classCode: nomenclatureStandards.classCode,
      template: nomenclatureStandards.template,
      specText: nomenclatureStandards.specText,
      userCreated: nomenclatureStandards.userCreated,
    })
    .from(nomenclatureStandards);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export type PartRow = {
  id: number;
  uniqueId: string;
  kind: "hardware" | "part";
  classCode: string;
  fullCode: string;
  standardName: string | null;
  name: string | null;
  description: string | null;
  configurations: string[];
  inventoryItemId: number | null;
  createdAt: string;
};

export async function listParts(): Promise<PartRow[]> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({
      id: nomenclatureParts.id,
      uniqueId: nomenclatureParts.uniqueId,
      kind: nomenclatureParts.kind,
      classCode: nomenclatureParts.classCode,
      fullCode: nomenclatureParts.fullCode,
      standardId: nomenclatureParts.standardId,
      standardName: nomenclatureStandards.name,
      name: nomenclatureParts.name,
      description: nomenclatureParts.description,
      configurations: nomenclatureParts.configurations,
      inventoryItemId: nomenclatureParts.inventoryItemId,
      createdAt: nomenclatureParts.createdAt,
    })
    .from(nomenclatureParts)
    .leftJoin(
      nomenclatureStandards,
      eq(nomenclatureStandards.id, nomenclatureParts.standardId),
    );
  return rows
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .map((r) => ({
      id: r.id,
      uniqueId: r.uniqueId,
      kind: (r.kind === "hardware" ? "hardware" : "part") as
        | "hardware"
        | "part",
      classCode: r.classCode,
      fullCode: r.fullCode,
      standardName: r.standardName ?? null,
      name: r.name ?? null,
      description: r.description ?? null,
      configurations: Array.isArray(r.configurations)
        ? (r.configurations as string[])
        : [],
      inventoryItemId: r.inventoryItemId ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
}

// ── Folder import ────────────────────────────────────────────────────────

export async function importStandardsFromFolder() {
  await ensureNomenclatureSchema();
  const result = await scanHardwaresFolder();
  revalidatePath("/design-engineering/nomenclature");
  return result;
}

// ── Inventory upsert helper (shared by both save paths) ─────────────────

async function upsertInventoryItem(args: {
  code: string;
  name: string | null;
  description: string | null;
  kind: "part" | "assembly";
  createdByClerkId: string | null;
}): Promise<number> {
  const existing = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(eq(inventoryItems.code, args.code))
    .limit(1);
  if (existing.length) {
    await db
      .update(inventoryItems)
      .set({
        name: args.name,
        description: args.description,
        kind: args.kind,
        archived: false,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, existing[0].id));
    return existing[0].id;
  }
  const [inserted] = await db
    .insert(inventoryItems)
    .values({
      code: args.code,
      name: args.name,
      description: args.description,
      kind: args.kind,
      createdByClerkId: args.createdByClerkId,
    })
    .returning({ id: inventoryItems.id });
  return inserted.id;
}

// ── Hardware save ────────────────────────────────────────────────────────

export async function saveHardwarePart(input: {
  standardId: number;
  nomenclature: string;
  name?: string | null;
  description?: string | null;
  configurations?: string[];
}): Promise<{ id: number; uniqueId: string; fullCode: string }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();

  const [std] = await db
    .select()
    .from(nomenclatureStandards)
    .where(eq(nomenclatureStandards.id, input.standardId))
    .limit(1);
  if (!std) throw new Error("Standard not found");

  const trimmedNom = input.nomenclature.trim();
  if (!trimmedNom) throw new Error("Nomenclature is required");

  const uniqueId = await allocateUniqueId();
  const fullCode = `${std.classCode}-${uniqueId}-${trimmedNom}`;

  const inventoryId = await upsertInventoryItem({
    code: fullCode,
    name: input.name ?? std.name,
    description: input.description ?? null,
    kind: "part",
    createdByClerkId: profile.clerkUserId,
  });

  const [inserted] = await db
    .insert(nomenclatureParts)
    .values({
      uniqueId,
      kind: "hardware",
      classCode: std.classCode,
      fullCode,
      standardId: std.id,
      name: input.name ?? null,
      description: input.description ?? null,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

  revalidatePath("/design-engineering/nomenclature");
  return { id: inserted.id, uniqueId, fullCode };
}

// ── Part / Assembly ID save ─────────────────────────────────────────────
//
// Format: <classCode>-<uniqueId>-WXXXX-HXXXX-LXXXX-<description-slug>
// Any of W/H/L can be left blank (we drop the dash segment entirely if
// the user omits it).

function dimensionSegment(prefix: string, value: number | null): string {
  if (value == null || Number.isNaN(value)) return "";
  return `${prefix}${value.toString().padStart(4, "0")}`;
}

function slugify(desc: string | null | undefined): string {
  if (!desc) return "";
  return desc
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function savePartCode(input: {
  classCode: string;
  name?: string | null;
  description?: string | null;
  widthMm?: number | null;
  heightMm?: number | null;
  lengthMm?: number | null;
  kind?: "part" | "assembly";
  configurations?: string[];
  parentPartId?: number | null;
}): Promise<{ id: number; uniqueId: string; fullCode: string }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();

  const classCode = (input.classCode || "").toUpperCase().trim();
  if (!/^[A-Z0-9]{2,6}$/.test(classCode)) {
    throw new Error("Class code must be 2–6 uppercase letters / digits");
  }

  const uniqueId = await allocateUniqueId();
  const wSeg = dimensionSegment("W", input.widthMm ?? null);
  const hSeg = dimensionSegment("H", input.heightMm ?? null);
  const lSeg = dimensionSegment("L", input.lengthMm ?? null);
  const descSeg = slugify(input.description);
  const segments = [classCode, uniqueId, wSeg, hSeg, lSeg, descSeg].filter(
    Boolean,
  );
  const fullCode = segments.join("-");

  const inventoryKind: "part" | "assembly" = input.kind ?? "part";
  const inventoryId = await upsertInventoryItem({
    code: fullCode,
    name: input.name ?? null,
    description: input.description ?? null,
    kind: inventoryKind,
    createdByClerkId: profile.clerkUserId,
  });

  const [inserted] = await db
    .insert(nomenclatureParts)
    .values({
      uniqueId,
      kind: "part",
      classCode,
      fullCode,
      name: input.name ?? null,
      description: input.description ?? null,
      widthMm: input.widthMm ?? null,
      heightMm: input.heightMm ?? null,
      lengthMm: input.lengthMm ?? null,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      parentPartId: input.parentPartId ?? null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

  revalidatePath("/design-engineering/nomenclature");
  return { id: inserted.id, uniqueId, fullCode };
}

// ── Edit (name + description + configurations) ──────────────────────────

export async function updatePart(input: {
  id: number;
  name?: string | null;
  description?: string | null;
  configurations?: string[];
}): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  await db
    .update(nomenclatureParts)
    .set({
      name: input.name ?? null,
      description: input.description ?? null,
      configurations: input.configurations ?? [],
      updatedAt: new Date(),
    })
    .where(eq(nomenclatureParts.id, input.id));
  // Mirror to inventory row name+description.
  const [row] = await db
    .select({ inv: nomenclatureParts.inventoryItemId })
    .from(nomenclatureParts)
    .where(eq(nomenclatureParts.id, input.id))
    .limit(1);
  if (row?.inv) {
    await db
      .update(inventoryItems)
      .set({
        name: input.name ?? null,
        description: input.description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, row.inv));
  }
  revalidatePath("/design-engineering/nomenclature");
}

// ── Delete: frees the uniqueId and detaches the inventory row ──────────

export async function deletePart(input: { id: number }): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  const [row] = await db
    .select({ inv: nomenclatureParts.inventoryItemId })
    .from(nomenclatureParts)
    .where(eq(nomenclatureParts.id, input.id))
    .limit(1);
  await db
    .delete(nomenclatureParts)
    .where(eq(nomenclatureParts.id, input.id));
  if (row?.inv) {
    // Archive the inventory row rather than hard-delete — RFQs/POs may
    // already reference it. The uniqueId on nomenclatureParts is what
    // gets freed for reuse; the inventory code is preserved for audit.
    await db
      .update(inventoryItems)
      .set({ archived: true, updatedAt: new Date() })
      .where(eq(inventoryItems.id, row.inv));
  }
  revalidatePath("/design-engineering/nomenclature");
}

// ── Add a new hardware family (e.g. cable glands) ───────────────────────

export async function addUserStandard(input: {
  name: string;
  classCode: string;
  template: string;
  specText: string;
}): Promise<{ id: number; sourcePath: string | null }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Name is required");

  const classCode = input.classCode.toUpperCase().trim();
  if (!/^[A-Z]{2,4}$/.test(classCode)) {
    throw new Error("Class code must be 2–4 uppercase letters");
  }
  if (!input.template.trim()) throw new Error("Template is required");
  if (!input.specText.trim()) throw new Error("Standard body is required");

  // Best-effort write to the OneDrive folder. Failure doesn't block
  // saving to DB — the user can still use the standard inside the app.
  const sourcePath = await writeNewStandardFile({
    slug,
    name: input.name,
    classCode,
    template: input.template,
    specText: input.specText,
  });

  const existing = await db
    .select({ id: nomenclatureStandards.id })
    .from(nomenclatureStandards)
    .where(eq(nomenclatureStandards.slug, slug))
    .limit(1);
  if (existing.length) {
    await db
      .update(nomenclatureStandards)
      .set({
        name: input.name,
        classCode,
        template: input.template,
        specText: input.specText,
        sourcePath,
        userCreated: true,
        updatedAt: new Date(),
      })
      .where(eq(nomenclatureStandards.id, existing[0].id));
    revalidatePath("/design-engineering/nomenclature");
    return { id: existing[0].id, sourcePath };
  }

  const [inserted] = await db
    .insert(nomenclatureStandards)
    .values({
      slug,
      name: input.name,
      classCode,
      template: input.template,
      specText: input.specText,
      sourcePath,
      userCreated: true,
    })
    .returning({ id: nomenclatureStandards.id });
  revalidatePath("/design-engineering/nomenclature");
  return { id: inserted.id, sourcePath };
}

// ── AI URL extractor ────────────────────────────────────────────────────

export async function extractHardwareFromUrlAction(input: {
  standardId: number;
  url: string;
}): Promise<{
  nomenclature: string;
  name: string | null;
  notes: string | null;
}> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  const [std] = await db
    .select()
    .from(nomenclatureStandards)
    .where(eq(nomenclatureStandards.id, input.standardId))
    .limit(1);
  if (!std) throw new Error("Standard not found");
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Paste a full http(s) URL");
  }
  const result = await extractHardwareFromUrl({
    url,
    template: std.template,
    specText: std.specText,
    familyName: std.name,
  });
  return {
    nomenclature: result.nomenclature,
    name: result.name,
    notes: result.notes,
  };
}

// Suppress unused-import warning if drizzle-orm helpers shift later.
void and;
void isNull;
