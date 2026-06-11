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
  product: string | null;
  configurations: Configuration[];
  inventoryItemId: number | null;
  createdAt: string;
};

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

  const inventoryId = await upsertInventoryItem({
    code: fullCode,
    name: input.name ?? std.name,
    description: input.description ?? null,
    kind: partOrAssembly === "A" ? "assembly" : "part",
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
      product: input.product?.trim() || null,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

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
    ...dimensionSegments,
    lSeg,
    nameSeg,
  ].filter(Boolean);
  // Rectangular: CLS-UNIQUE-WXXXX-HXXXX-LXXXX-DISPLAY_NAME
  // Circular:    CLS-UNIQUE-DXXXX-LXXXX-DISPLAY_NAME
  const fullCode = segments.join("-").toUpperCase();

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
      classCode: classification,
      fullCode,
      name: input.name ?? null,
      description: input.description ?? null,
      widthMm: isCircular ? null : input.widthMm ?? null,
      heightMm: isCircular ? null : input.heightMm ?? null,
      diameterMm: isCircular ? input.diameterMm ?? null : null,
      lengthMm: input.lengthMm ?? null,
      partOrAssembly: inventoryKind === "assembly" ? "A" : "P",
      product: input.product?.trim() || null,
      configurations: input.configurations ?? [],
      inventoryItemId: inventoryId,
      parentPartId: input.parentPartId ?? null,
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: nomenclatureParts.id });

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
  configurations?: Configuration[];
}): Promise<void> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in required");
  await ensureNomenclatureSchema();
  await db
    .update(nomenclatureParts)
    .set({
      name: input.name ?? null,
      description: input.description ?? null,
      product: input.product?.trim() || null,
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

// Distinct product names from nomenclature_parts. Used by the
// Database tab's product-view dropdown.
export async function listProducts(): Promise<string[]> {
  await ensureNomenclatureSchema();
  const rows = await db
    .select({ product: nomenclatureParts.product })
    .from(nomenclatureParts);
  const set = new Set<string>();
  for (const r of rows) {
    const p = (r.product ?? "").trim();
    if (p) set.add(p);
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

// Suppress unused-import warning if drizzle-orm helpers shift later.
void and;
void isNull;
void inArray;
void sql;
