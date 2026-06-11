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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assemblyBom,
  configurationOptions,
  inventoryAttachments,
  inventoryItems,
  nomenclatureParts,
  nomenclatureStandards,
  supplierProducts,
  suppliers,
} from "@/db/schema";
import { getOrCreateProfile } from "@/lib/permissions";
import { ensureNomenclatureSchema } from "@/lib/nomenclature/_ensure-schema";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";
import {
  buildAssemblyTree,
  maxProducible,
  removeAssemblyEdge,
  upsertAssemblyEdge,
  type TreeNode,
} from "@/lib/nomenclature/assembly-tree";
import {
  scanHardwaresFolder,
  writeNewStandardFile,
} from "@/lib/nomenclature/folder-scanner";
import { allocateUniqueId } from "@/lib/nomenclature/unique-id";
import {
  extractHardwareFromUrl,
  suggestTemplateFromUrl,
} from "@/lib/nomenclature/ai-extract";

// The three fixed class codes that prefix every generated code. FAB =
// fabricated in-house, PHS = purchased, TLG = tooling. The previous
// per-family code (SCR, NUT, …) is no longer used as a prefix — it
// lives inside the nomenclature itself as part of the TYPE field.
export type Classification = "FAB" | "PHS" | "TLG";
const CLASSIFICATIONS = new Set<Classification>(["FAB", "PHS", "TLG"]);
function assertClassification(v: string): Classification {
  const up = v.toUpperCase() as Classification;
  if (!CLASSIFICATIONS.has(up)) {
    throw new Error("Class code must be FAB, PHS, or TLG");
  }
  return up;
}

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

export type Configuration = {
  name: string;
  description: string | null;
};

export type PartRow = {
  id: number;
  uniqueId: string;
  kind: "hardware" | "part";
  classCode: string; // FAB | PHS | TLG
  partOrAssembly: "P" | "A" | null;
  fullCode: string;
  standardName: string | null;
  name: string | null;
  description: string | null;
  // Legacy single-product field. Always equal to products[0] when
  // products is non-empty; null otherwise. Kept for UI components
  // that haven't been migrated to the array yet.
  product: string | null;
  products: string[];
  configurations: Configuration[];
  inventoryItemId: number | null;
  createdAt: string;
};

// Normalise an input value (string[] or null) into a clean string[].
// Strips empty entries and de-duplicates while preserving order.
function normalizeProductArray(
  raw: string[] | null | undefined,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// Merge a single legacy `product` value with the canonical `products`
// array so reads can rely on the array even on pre-V92 rows.
function readProducts(
  legacy: string | null | undefined,
  arr: unknown,
): string[] {
  const cleaned = normalizeProductArray(
    Array.isArray(arr) ? (arr as string[]) : null,
  );
  if (cleaned.length > 0) return cleaned;
  if (legacy && legacy.trim()) return [legacy.trim()];
  return [];
}

// Public type for the catalogue picker. id is server-assigned.
export type ConfigurationOption = {
  id: number;
  name: string;
  description: string | null;
};

// Upsert every {name, description} pair from a Configuration[] into
// the global configuration_options catalogue. Idempotent: existing
// rows have their description updated only when the incoming entry
// has a non-empty description and the existing row's description is
// null/empty (so we don't overwrite a richer description with a
// shorter one). Called from every save path so the catalogue grows
// automatically as new names appear.
async function upsertConfigurationOptions(
  configs: Configuration[],
  createdByClerkId: string | null,
): Promise<void> {
  for (const c of configs) {
    const name = c.name.trim().toUpperCase();
    if (!name) continue;
    const description = c.description?.trim() || null;
    const existing = await db
      .select({
        id: configurationOptions.id,
        description: configurationOptions.description,
      })
      .from(configurationOptions)
      .where(eq(configurationOptions.name, name))
      .limit(1);
    if (existing.length) {
      // Only update description when we have one AND the stored one
      // is missing — keeps user-curated descriptions stable.
      const current = existing[0].description?.trim() ?? null;
      if (description && !current) {
        await db
          .update(configurationOptions)
          .set({ description, updatedAt: new Date() })
          .where(eq(configurationOptions.id, existing[0].id));
      }
      continue;
    }
    try {
      await db.insert(configurationOptions).values({
        name,
        description,
        createdByClerkId,
      });
    } catch {
      // Concurrent insert from another tab won the unique race — fine.
    }
  }
}

export async function listConfigurationOptionsAction(): Promise<
  ConfigurationOption[]
> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({
      id: configurationOptions.id,
      name: configurationOptions.name,
      description: configurationOptions.description,
    })
    .from(configurationOptions)
    .orderBy(asc(configurationOptions.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
  }));
}

// Normalize either the new {name, description}[] shape OR the legacy
// bare-string[] shape into a consistent Configuration[]. Old pre-V78
// rows might still have string chips in the DB.
function normalizeConfigurations(raw: unknown): Configuration[] {
  if (!Array.isArray(raw)) return [];
  const out: Configuration[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push({ name: trimmed, description: null });
      continue;
    }
    if (item && typeof item === "object") {
      const rec = item as { name?: unknown; description?: unknown };
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const description =
        typeof rec.description === "string" && rec.description.trim()
          ? rec.description.trim()
          : null;
      if (name) out.push({ name, description });
    }
  }
  return out;
}

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
      partOrAssembly: nomenclatureParts.partOrAssembly,
      name: nomenclatureParts.name,
      description: nomenclatureParts.description,
      product: nomenclatureParts.product,
      products: nomenclatureParts.products,
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
      partOrAssembly:
        r.partOrAssembly === "A" || r.partOrAssembly === "P"
          ? r.partOrAssembly
          : null,
      name: r.name ?? null,
      description: r.description ?? null,
      product: r.product ?? null,
      products: readProducts(r.product, r.products),
      configurations: normalizeConfigurations(r.configurations),
      inventoryItemId: r.inventoryItemId ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
}

// ── Folder import ────────────────────────────────────────────────────────

export async function importStandardsFromFolder() {
  await ensureNomenclatureSchema();
  // No revalidatePath here — the page reads listStandards() right after
  // calling this, and Next 16 forbids cache mutations inside a render.
  // For UI-triggered re-scans the page reloads via ?rescan=1.
  return await scanHardwaresFolder();
}

// ── Inventory upsert helper (shared by both save paths) ─────────────────

async function upsertInventoryItem(args: {
  code: string;
  name: string | null;
  description: string | null;
  kind: "part" | "assembly";
  product?: string | null;
  products?: string[];
  createdByClerkId: string | null;
}): Promise<number> {
  // The inventory_items table + its columns live behind the suppliers
  // module's self-heal helper. Calling it here makes the nomenclature
  // page work on a fresh DB even when the user hasn't opened
  // /suppliers yet (the inventory upsert would otherwise hit a missing
  // table or missing column).
  await ensureOrdersSchema();
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
        product: args.product ?? null,
        products: args.products ?? [],
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
      product: args.product ?? null,
      products: args.products ?? [],
      // Every nomenclature-generated row is a top-level "parent" entry
      // — never a child of an assembly.
      parentAssemblyId: null,
      createdByClerkId: args.createdByClerkId,
    })
    .returning({ id: inventoryItems.id });
  return inserted.id;
}

// ── Hardware save ────────────────────────────────────────────────────────

export async function saveHardwarePart(input: {
  standardId: number;
  classification: string; // FAB | PHS | TLG
  partOrAssembly: "P" | "A";
  nomenclature: string;
  name?: string | null;
  description?: string | null;
  product?: string | null;
  products?: string[];
  configurations?: Configuration[];
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

  const classification = assertClassification(input.classification);
  const partOrAssembly: "P" | "A" =
    input.partOrAssembly === "A" ? "A" : "P";
  const trimmedNom = input.nomenclature.trim().toUpperCase();
  if (!trimmedNom) throw new Error("Nomenclature is required");

  const uniqueId = await allocateUniqueId();
  // CLS-UNIQUE-P|A-NOMENCLATURE   (all uppercase)
  const fullCode =
    `${classification}-${uniqueId}-${partOrAssembly}-${trimmedNom}`.toUpperCase();

  const productsArr = normalizeProductArray(
    input.products ?? (input.product ? [input.product] : []),
  );
  const inventoryId = await upsertInventoryItem({
    code: fullCode,
    name: input.name ?? std.name,
    description: input.description ?? null,
    kind: partOrAssembly === "A" ? "assembly" : "part",
    product: productsArr[0] ?? null,
    products: productsArr,
    createdByClerkId: profile.clerkUserId,
  });

  const [inserted] = await db
    .insert(nomenclatureParts)
    .values({
      uniqueId,
      kind: "hardware",
      classCode: classification,
      fullCode,
      standardId: std.id,
      partOrAssembly,
      name: input.name ?? null,
      description: input.description ?? null,
      product: productsArr[0] ?? null,
      products: productsArr,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

  await upsertConfigurationOptions(
    input.configurations ?? [],
    profile.clerkUserId,
  );

  return { id: inserted.id, uniqueId, fullCode };
}

// ── Part / Assembly ID save ─────────────────────────────────────────────
//
// Format: <classCode>-<uniqueId>-WXXXX-HXXXX-LXXXX-<description-slug>
// Any of W/H/L can be left blank (we drop the dash segment entirely if
// the user omits it).

function dimensionSegment(prefix: string, value: number | null): string {
  // When the user leaves the field blank we preserve the slot in the
  // code with literal X placeholders (e.g. WXXXX) so the segment layout
  // stays the same length and is greppable later. Numeric values are
  // rounded to an integer, clamped to 0..9999, and zero-padded so the
  // segment is ALWAYS exactly 5 chars (prefix + 4 digits). 235 -> W0235,
  // 5 -> W0005, 9999 -> W9999, 12345 -> W9999.
  if (value == null || Number.isNaN(value)) return `${prefix}XXXX`;
  const clamped = Math.max(0, Math.min(9999, Math.round(value)));
  return `${prefix}${clamped.toString().padStart(4, "0")}`;
}

function slugify(desc: string | null | undefined): string {
  if (!desc) return "";
  return desc
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function savePartCode(input: {
  classification: string; // FAB | PHS | TLG
  name?: string | null;
  description?: string | null;
  shape?: "rect" | "circ";
  widthMm?: number | null;
  heightMm?: number | null;
  diameterMm?: number | null;
  lengthMm?: number | null;
  kind?: "part" | "assembly";
  configurations?: Configuration[];
  parentPartId?: number | null;
  product?: string | null;
  products?: string[];
  // PHS only — optional. When provided we also create a row in
  // supplier_products linking this part to the supplier's catalogue.
  supplierId?: number | null;
  supplierProductUrl?: string | null;
}): Promise<{
  id: number;
  uniqueId: string;
  fullCode: string;
  supplierProductId: number | null;
}> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();

  const classification = assertClassification(input.classification);
  const isCircular = input.shape === "circ";

  const uniqueId = await allocateUniqueId();
  // P for part / configuration, A for assembly. Follows the unique ID
  // in EVERY code (hardware AND part/assembly) per the convention.
  const inventoryKindFinal: "part" | "assembly" = input.kind ?? "part";
  const partOrAssembly: "P" | "A" =
    inventoryKindFinal === "assembly" ? "A" : "P";
  // Circular parts use a single DXXXX segment in place of WXXXX-HXXXX.
  // Length still applies in either shape.
  const dimensionSegments = isCircular
    ? [dimensionSegment("D", input.diameterMm ?? null)]
    : [
        dimensionSegment("W", input.widthMm ?? null),
        dimensionSegment("H", input.heightMm ?? null),
      ];
  const lSeg = dimensionSegment("L", input.lengthMm ?? null);
  // The trailing segment is the Display Name; description stays on
  // the row for the listing UI but not the code.
  const nameSeg = slugify(input.name);
  const segments = [
    classification,
    uniqueId,
    partOrAssembly,
    ...dimensionSegments,
    lSeg,
    nameSeg,
  ].filter(Boolean);
  // Rectangular: CLS-UNIQUE-P|A-WXXXX-HXXXX-LXXXX-DISPLAY_NAME
  // Circular:    CLS-UNIQUE-P|A-DXXXX-LXXXX-DISPLAY_NAME
  const fullCode = segments.join("-").toUpperCase();

  const productsArr = normalizeProductArray(
    input.products ?? (input.product ? [input.product] : []),
  );
  const inventoryId = await upsertInventoryItem({
    code: fullCode,
    name: input.name ?? null,
    description: input.description ?? null,
    kind: inventoryKindFinal,
    product: productsArr[0] ?? null,
    products: productsArr,
    createdByClerkId: profile.clerkUserId,
  });

  const [inserted] = await db
    .insert(nomenclatureParts)
    .values({
      uniqueId,
      kind: "part",
      classCode: classification,
      fullCode,
      name: input.name ?? null,
      description: input.description ?? null,
      widthMm: isCircular ? null : input.widthMm ?? null,
      heightMm: isCircular ? null : input.heightMm ?? null,
      diameterMm: isCircular ? input.diameterMm ?? null : null,
      lengthMm: input.lengthMm ?? null,
      partOrAssembly,
      product: productsArr[0] ?? null,
      products: productsArr,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      parentPartId: input.parentPartId ?? null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

  await upsertConfigurationOptions(
    input.configurations ?? [],
    profile.clerkUserId,
  );

  // PHS-only side effect: also create a row in the supplier catalogue
  // so this code shows up under /suppliers → catalogue. We only do
  // this when the caller passes a supplierId; without one we leave the
  // user to attach the supplier later from the catalogue page.
  let supplierProductId: number | null = null;
  if (classification === "PHS" && input.supplierId) {
    try {
      const [sp] = await db
        .insert(supplierProducts)
        .values({
          supplierId: input.supplierId,
          name: input.name ?? fullCode,
          productCode: fullCode,
          description: input.description ?? null,
          productUrl: input.supplierProductUrl ?? null,
          createdByClerkId: profile.clerkUserId,
        })
        .returning({ id: supplierProducts.id });
      supplierProductId = sp?.id ?? null;
    } catch (e) {
      console.warn(
        "[nomenclature] failed to create supplier_products row:",
        e,
      );
    }
  }

  return { id: inserted.id, uniqueId, fullCode, supplierProductId };
}

// ── Edit (name + description + configurations) ──────────────────────────

export async function updatePart(input: {
  id: number;
  name?: string | null;
  description?: string | null;
  product?: string | null;
  products?: string[];
  configurations?: Configuration[];
}): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  const productsArr = normalizeProductArray(
    input.products ?? (input.product ? [input.product] : []),
  );
  await db
    .update(nomenclatureParts)
    .set({
      name: input.name ?? null,
      description: input.description ?? null,
      product: productsArr[0] ?? null,
      products: productsArr,
      configurations: input.configurations ?? [],
      updatedAt: new Date(),
    })
    .where(eq(nomenclatureParts.id, input.id));
  // Mirror to inventory row name + description + product.
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
        product: productsArr[0] ?? null,
        products: productsArr,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, row.inv));
    // Mirror configurations onto inventory too.
    await db
      .update(inventoryItems)
      .set({
        configurations: input.configurations ?? [],
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, row.inv));
  }
  await upsertConfigurationOptions(
    input.configurations ?? [],
    profile.clerkUserId,
  );
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

// ── AI template suggester (for the "New family" wizard) ────────────────
//
// Given a product URL, ask Claude to propose a preliminary nomenclature
// template + spec body for a brand-new hardware family. The user
// reviews + edits in the New Family modal before saving.

export async function suggestTemplateAction(input: { url: string }): Promise<{
  name: string;
  template: string;
  specText: string;
}> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Paste a full http(s) URL");
  }
  const result = await suggestTemplateFromUrl({ url });
  return {
    name: result.name,
    template: result.template,
    specText: result.specText,
  };
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

// ── Supplier picker (used by the PHS form on the Part/Assembly tab) ────

export type SupplierOption = {
  id: number;
  name: string;
  origin: string | null;
};

// All inventory_item ids that appear as a CHILD in any assembly_bom
// row. Used by the Database tab to identify "master parents" — items
// that aren't children of anything. The set is small (one int per
// edge) so a single fetch is fine.
export async function listChildInventoryItemIds(): Promise<number[]> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({ id: assemblyBom.childItemId })
    .from(assemblyBom);
  return Array.from(new Set(rows.map((r) => r.id)));
}

// Distinct product names from nomenclature_parts. Used by the
// Database tab's product-view dropdown.
export async function listProducts(): Promise<string[]> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({
      product: nomenclatureParts.product,
      products: nomenclatureParts.products,
    })
    .from(nomenclatureParts);
  const set = new Set<string>();
  for (const r of rows) {
    for (const p of readProducts(r.product, r.products)) {
      set.add(p);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Link an existing inventory row to a supplier — creates a row in
// supplier_products that points at the existing code. Idempotent: a
// row with the same supplier+code already linked just returns it.
export async function linkInventoryToSupplierAction(input: {
  inventoryItemId: number;
  supplierId: number;
  productUrl?: string | null;
}): Promise<{ supplierProductId: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureOrdersSchema();
  const [item] = await db
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      description: inventoryItems.description,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.inventoryItemId))
    .limit(1);
  if (!item) throw new Error("Inventory row not found");
  const existing = await db
    .select({ id: supplierProducts.id })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, input.supplierId),
        eq(supplierProducts.productCode, item.code),
      ),
    )
    .limit(1);
  if (existing.length) {
    return { supplierProductId: existing[0].id };
  }
  const [sp] = await db
    .insert(supplierProducts)
    .values({
      supplierId: input.supplierId,
      name: item.name ?? item.code,
      productCode: item.code,
      description: item.description ?? null,
      productUrl: input.productUrl ?? null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: supplierProducts.id });
  return { supplierProductId: sp.id };
}

export async function listSupplierOptions(): Promise<SupplierOption[]> {
  const profile = await getOrCreateProfile();
  if (!profile) return [];
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      origin: suppliers.origin,
    })
    .from(suppliers)
    .orderBy(asc(suppliers.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    origin: r.origin ?? null,
  }));
}

// ── Assembly tree (used by the Database tab + new Assembly editor) ─────

export type AssemblyTreeNode = TreeNode;

export type InventoryPickerRow = {
  itemId: number;
  code: string;
  name: string | null;
  kind: "part" | "assembly";
  stock: number;
};

// Lists every non-archived inventory item except the assembly itself,
// so the "Add child" picker on /design-engineering/nomenclature has
// something to render. Filters to the same assembly's subtree-safe
// candidates is left to the server upsert (cycle guard).
export async function listInventoryPickerOptions(args: {
  excludeItemId?: number;
}): Promise<InventoryPickerRow[]> {
  const profile = await getOrCreateProfile();
  if (!profile) return [];
  await ensureOrdersSchema();
  const rows = await db
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      kind: inventoryItems.kind,
      confirmedQty: inventoryItems.confirmedQty,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.archived, false))
    .orderBy(desc(inventoryItems.createdAt));
  return rows
    .filter((r) => r.id !== args.excludeItemId)
    .map((r) => ({
      itemId: r.id,
      code: r.code,
      name: r.name ?? null,
      kind: r.kind === "assembly" ? "assembly" : "part",
      stock: r.confirmedQty ?? 0,
    }));
}

export async function getAssemblyTree(input: {
  inventoryItemId: number;
}): Promise<AssemblyTreeNode | null> {
  const profile = await getOrCreateProfile();
  if (!profile) return null;
  await ensureOrdersSchema();
  return await buildAssemblyTree(input.inventoryItemId);
}

export async function addAssemblyChildAction(input: {
  parentInventoryItemId: number;
  childInventoryItemId: number;
  quantity: number;
  notes?: string | null;
}): Promise<{ ok: true }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureOrdersSchema();
  // Flip the parent to kind='assembly' so the tree calculation treats
  // it as one. This is a no-op if it already was.
  await db
    .update(inventoryItems)
    .set({ kind: "assembly", updatedAt: new Date() })
    .where(eq(inventoryItems.id, input.parentInventoryItemId));
  await upsertAssemblyEdge({
    parentAssemblyId: input.parentInventoryItemId,
    childItemId: input.childInventoryItemId,
    quantity: input.quantity,
    notes: input.notes ?? null,
    createdByClerkId: profile.clerkUserId,
  });
  return { ok: true };
}

export async function removeAssemblyChildAction(input: {
  parentInventoryItemId: number;
  childInventoryItemId: number;
}): Promise<{ ok: true }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureOrdersSchema();
  await removeAssemblyEdge({
    parentAssemblyId: input.parentInventoryItemId,
    childItemId: input.childInventoryItemId,
  });
  return { ok: true };
}

export async function getMaxProducible(input: {
  inventoryItemId: number;
}): Promise<number> {
  const profile = await getOrCreateProfile();
  if (!profile) return 0;
  await ensureOrdersSchema();
  return await maxProducible(input.inventoryItemId);
}

// ── Backfill: insert P/A after the unique ID in legacy part codes ──────
//
// Hardware codes already had P/A (V77+). Part/Assembly codes were
// missing it until V87. This action walks every nomenclature_parts
// row of kind='part', rewrites fullCode to insert "-P-" or "-A-"
// right after the unique ID segment, and mirrors the new code into
// inventory_items.code + any supplier_products.productCode that
// referenced the old code. Idempotent — rows whose code already
// matches the new shape are left alone.

export type BackfillSummary = {
  scanned: number;
  rewritten: number;
  skipped: number;
  errors: Array<{ id: number; code: string; message: string }>;
};

export async function backfillPartCodesAction(): Promise<BackfillSummary> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  await ensureOrdersSchema();

  const rows = await db
    .select({
      id: nomenclatureParts.id,
      uniqueId: nomenclatureParts.uniqueId,
      kind: nomenclatureParts.kind,
      fullCode: nomenclatureParts.fullCode,
      partOrAssembly: nomenclatureParts.partOrAssembly,
      inventoryItemId: nomenclatureParts.inventoryItemId,
    })
    .from(nomenclatureParts)
    .where(eq(nomenclatureParts.kind, "part"));

  const out: BackfillSummary = {
    scanned: rows.length,
    rewritten: 0,
    skipped: 0,
    errors: [],
  };

  for (const r of rows) {
    try {
      // Decide P or A. Use the partOrAssembly column when present;
      // fall back to inventory.kind. Default P.
      let pa: "P" | "A" =
        r.partOrAssembly === "A" ? "A" : r.partOrAssembly === "P" ? "P" : "P";
      if (!r.partOrAssembly && r.inventoryItemId != null) {
        const [inv] = await db
          .select({ kind: inventoryItems.kind })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, r.inventoryItemId))
          .limit(1);
        if (inv?.kind === "assembly") pa = "A";
      }

      const segments = r.fullCode.split("-");
      if (segments.length < 2) {
        out.skipped++;
        continue;
      }
      // Find the unique-id segment by position (1) and check whether
      // the next segment is already "P" or "A".
      const next = segments[2];
      if (next === "P" || next === "A") {
        out.skipped++;
        continue;
      }
      const rewritten = [
        segments[0],
        segments[1],
        pa,
        ...segments.slice(2),
      ]
        .join("-")
        .toUpperCase();

      // Update nomenclature_parts.
      await db
        .update(nomenclatureParts)
        .set({
          fullCode: rewritten,
          partOrAssembly: pa,
          updatedAt: new Date(),
        })
        .where(eq(nomenclatureParts.id, r.id));

      // Mirror to inventory_items.code if linked.
      if (r.inventoryItemId != null) {
        await db
          .update(inventoryItems)
          .set({ code: rewritten, updatedAt: new Date() })
          .where(eq(inventoryItems.id, r.inventoryItemId));
      }

      // Mirror to any supplier_products row that referenced the old
      // code as productCode (the V83 PHS link path stores it there).
      await db
        .update(supplierProducts)
        .set({ productCode: rewritten, updatedAt: new Date() })
        .where(eq(supplierProducts.productCode, r.fullCode));

      out.rewritten++;
    } catch (e) {
      out.errors.push({
        id: r.id,
        code: r.fullCode,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}

// ── Detail drawer: full picture of one inventory item ──────────────────

export type DrawerAttachment = {
  id: number;
  kind: "cad" | "drawing" | "image" | "doc" | "link";
  label: string;
  url: string;
  pathname: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
};

export type DrawerSupplierLink = {
  supplierProductId: number;
  supplierId: number;
  supplierName: string;
  productUrl: string | null;
};

export type DrawerChild = {
  inventoryItemId: number;
  code: string;
  name: string | null;
  kind: "part" | "assembly";
  quantity: number;
  stock: number;
};

export type DrawerParent = {
  inventoryItemId: number;
  code: string;
  name: string | null;
  quantity: number;
};

export type InventoryDetails = {
  inventoryItemId: number;
  code: string;
  kind: "part" | "assembly";
  name: string | null;
  description: string | null;
  product: string | null;
  products: string[];
  classCode: string | null;
  partOrAssembly: "P" | "A" | null;
  uniqueId: string | null;
  configurations: Configuration[];
  standardName: string | null;
  attachments: DrawerAttachment[];
  supplierLinks: DrawerSupplierLink[];
  children: DrawerChild[];
  parents: DrawerParent[];
  maxBuildable: number | null;
};

function normalizeKind(raw: string): DrawerAttachment["kind"] {
  switch (raw) {
    case "cad":
    case "drawing":
    case "image":
    case "doc":
    case "link":
      return raw;
    default:
      return "doc";
  }
}

export async function getInventoryDetails(input: {
  inventoryItemId: number;
}): Promise<InventoryDetails | null> {
  const profile = await getOrCreateProfile();
  if (!profile) return null;
  await ensureNomenclatureSchema();
  await ensureOrdersSchema();

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.inventoryItemId))
    .limit(1);
  if (!item) return null;

  const [nomRow] = await db
    .select({
      uniqueId: nomenclatureParts.uniqueId,
      classCode: nomenclatureParts.classCode,
      partOrAssembly: nomenclatureParts.partOrAssembly,
      configurations: nomenclatureParts.configurations,
      standardId: nomenclatureParts.standardId,
    })
    .from(nomenclatureParts)
    .where(eq(nomenclatureParts.inventoryItemId, input.inventoryItemId))
    .limit(1);

  let standardName: string | null = null;
  if (nomRow?.standardId != null) {
    const [std] = await db
      .select({ name: nomenclatureStandards.name })
      .from(nomenclatureStandards)
      .where(eq(nomenclatureStandards.id, nomRow.standardId))
      .limit(1);
    standardName = std?.name ?? null;
  }

  const attRows = await db
    .select()
    .from(inventoryAttachments)
    .where(eq(inventoryAttachments.inventoryItemId, input.inventoryItemId))
    .orderBy(desc(inventoryAttachments.createdAt));
  const attachments: DrawerAttachment[] = attRows.map((a) => ({
    id: a.id,
    kind: normalizeKind(a.kind),
    label: a.label,
    url: a.url,
    pathname: a.pathname,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    createdAt: a.createdAt.toISOString(),
  }));

  const supplierRows = await db
    .select({
      spId: supplierProducts.id,
      supplierId: supplierProducts.supplierId,
      supplierName: suppliers.name,
      productUrl: supplierProducts.productUrl,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(eq(supplierProducts.productCode, item.code));
  const supplierLinks: DrawerSupplierLink[] = supplierRows.map((r) => ({
    supplierProductId: r.spId,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    productUrl: r.productUrl ?? null,
  }));

  // Direct children of this assembly.
  const childEdges = await db
    .select({
      edgeQuantity: assemblyBom.quantity,
      child: inventoryItems,
    })
    .from(assemblyBom)
    .innerJoin(
      inventoryItems,
      eq(inventoryItems.id, assemblyBom.childItemId),
    )
    .where(eq(assemblyBom.parentAssemblyId, input.inventoryItemId));
  const children: DrawerChild[] = childEdges.map((r) => ({
    inventoryItemId: r.child.id,
    code: r.child.code,
    name: r.child.name ?? null,
    kind: r.child.kind === "assembly" ? "assembly" : "part",
    quantity: r.edgeQuantity,
    stock: r.child.confirmedQty ?? 0,
  }));

  // Parents — assemblies that contain THIS item.
  const parentEdges = await db
    .select({
      edgeQuantity: assemblyBom.quantity,
      parent: inventoryItems,
    })
    .from(assemblyBom)
    .innerJoin(
      inventoryItems,
      eq(inventoryItems.id, assemblyBom.parentAssemblyId),
    )
    .where(eq(assemblyBom.childItemId, input.inventoryItemId));
  const parents: DrawerParent[] = parentEdges.map((r) => ({
    inventoryItemId: r.parent.id,
    code: r.parent.code,
    name: r.parent.name ?? null,
    quantity: r.edgeQuantity,
  }));

  let maxBuildableNum: number | null = null;
  if (item.kind === "assembly") {
    maxBuildableNum = await maxProducible(item.id);
  }

  return {
    inventoryItemId: item.id,
    code: item.code,
    kind: item.kind === "assembly" ? "assembly" : "part",
    name: item.name ?? null,
    description: item.description ?? null,
    product: item.product ?? null,
    products: readProducts(item.product, (item as { products?: unknown }).products),
    classCode: nomRow?.classCode ?? null,
    // Configurations source priority:
    //   1. inventory_items.configurations (the V97 mirror — kept in
    //      sync on every write so it's always the freshest).
    //   2. nomenclature_parts.configurations (legacy rows that
    //      pre-date the mirror).
    // Both go through the same normaliser so callers get a clean
    // Configuration[] regardless of which source had it.
    partOrAssembly:
      nomRow?.partOrAssembly === "A" || nomRow?.partOrAssembly === "P"
        ? nomRow.partOrAssembly
        : null,
    uniqueId: nomRow?.uniqueId ?? null,
    configurations: (() => {
      const inv = (item as { configurations?: unknown }).configurations;
      const fromInv = normalizeConfigurations(inv);
      if (fromInv.length) return fromInv;
      return normalizeConfigurations(nomRow?.configurations);
    })(),
    standardName,
    attachments,
    supplierLinks,
    children,
    parents,
    maxBuildable: maxBuildableNum,
  };
}

export async function addInventoryAttachmentAction(input: {
  inventoryItemId: number;
  kind: "cad" | "drawing" | "image" | "doc" | "link";
  label: string;
  url: string;
  pathname?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
}): Promise<{ id: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  const [row] = await db
    .insert(inventoryAttachments)
    .values({
      inventoryItemId: input.inventoryItemId,
      kind: input.kind,
      label: input.label.trim() || input.kind,
      url: input.url,
      pathname: input.pathname ?? null,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: inventoryAttachments.id });
  return { id: row.id };
}

// Persist a fresh configurations array onto an inventory row from
// the InventoryDrawer's editor. Mirrors to nomenclature_parts when
// the row is linked, so the Database tab keeps showing the same
// chip set without needing a refresh.
export async function setInventoryConfigurationsAction(input: {
  inventoryItemId: number;
  configurations: Configuration[];
}): Promise<{ ok: true }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  await ensureOrdersSchema();
  const clean = normalizeConfigurations(input.configurations);
  await db
    .update(inventoryItems)
    .set({ configurations: clean, updatedAt: new Date() })
    .where(eq(inventoryItems.id, input.inventoryItemId));
  await db
    .update(nomenclatureParts)
    .set({ configurations: clean, updatedAt: new Date() })
    .where(eq(nomenclatureParts.inventoryItemId, input.inventoryItemId));
  await upsertConfigurationOptions(clean, profile.clerkUserId);
  return { ok: true };
}

export async function removeInventoryAttachmentAction(input: {
  attachmentId: number;
}): Promise<{ ok: true }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  await db
    .delete(inventoryAttachments)
    .where(eq(inventoryAttachments.id, input.attachmentId));
  return { ok: true };
}

// Suppress unused-import warning if drizzle-orm helpers shift later.
void and;
void isNull;
void inArray;
void sql;
