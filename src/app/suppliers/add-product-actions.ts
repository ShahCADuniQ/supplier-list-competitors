"use server";

// Orchestration for the Supplier Catalogue "Add product" flow.
// Two stages, each backed by its own Route Handler:
//   1) extract — fetch URL → Perplexity → Claude → match candidates.
//   2) commit  — write supplier_products row(s), download images, attach files.
//
// The two stages live in separate endpoints so the user can confirm the
// supplier resolution and the existing-product link choice between them.
// Extract streams progress via SSE; commit is a single JSON request.

import { put } from "@vercel/blob";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { supplierProducts, supplierProductAttachments } from "@/db/schema";
import {
  extractSupplierProductFromUrl,
  type SupplierProductExtraction,
} from "@/lib/ai/extract";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";
import {
  findSuppliersForResolution,
  findExistingProductsByCode,
  createSupplierForExtraction,
  type SupplierResolutionCandidate,
  type ExistingProductMatchCandidate,
} from "./supplier-inventory-actions";

export type AddSupplierProductProgress = {
  step:
    | "starting"
    | "perplexity"
    | "claude"
    | "matching-supplier"
    | "matching-product"
    | "done";
  percent: number;
  detail: string | null;
};

export type AddSupplierProductExtractResult = {
  extraction: SupplierProductExtraction;
  supplierCandidates: SupplierResolutionCandidate[];
  productMatchCandidates: ExistingProductMatchCandidate[];
};

export async function extractSupplierProductStreaming(input: {
  url: string;
  supplierHint?: string;
  categoryHint?: string;
  onProgress: (e: AddSupplierProductProgress) => void;
}): Promise<AddSupplierProductExtractResult> {
  const { url, supplierHint, categoryHint, onProgress } = input;

  onProgress({ step: "perplexity", percent: 10, detail: "Reading the product page" });
  // extractSupplierProductFromUrl runs Perplexity + Claude internally; we
  // narrate the boundary by bracketing the call. If finer progress is needed
  // later, split extractSupplierProductFromUrl into two calls.
  const extraction = await extractSupplierProductFromUrl({
    url,
    supplierHint,
    categoryHint,
  });
  onProgress({ step: "claude", percent: 55, detail: "Structured product card" });

  onProgress({ step: "matching-supplier", percent: 70, detail: "Looking up suppliers" });
  const supplierCandidates = await findSuppliersForResolution({
    supplierName: extraction.supplierName,
    supplierWebsite: extraction.supplierWebsite,
    supplierHint: supplierHint ?? null,
  });

  onProgress({ step: "matching-product", percent: 85, detail: "Looking up existing products" });
  const productMatchCandidates = extraction.productCode
    ? await findExistingProductsByCode({ productCode: extraction.productCode })
    : [];

  onProgress({ step: "done", percent: 100, detail: null });
  return { extraction, supplierCandidates, productMatchCandidates };
}

export type CommitSupplierProductInput = {
  // Supplier selection: either an existing supplier id, or the create payload.
  supplier:
    | { kind: "existing"; supplierId: number }
    | {
        kind: "new";
        name: string;
        website: string | null;
        email: string | null;
      };
  // When set, the new product joins this cluster instead of getting its own
  // fresh globalProductId.
  linkToGlobalProductId: string | null;
  // The product card itself. May come from extraction (auto-fill) or from the
  // manual form. The commit endpoint doesn't care which.
  product: {
    name: string;
    productCode: string | null;
    category: string | null;
    description: string | null;
    thumbnailUrl: string | null; // remote URL — downloaded into blob here
    imageUrls: string[]; // additional images — attached as "other_file" rows
  };
  configurations: Array<{
    name: string;
    productCode: string | null;
    description: string | null;
  }>;
};

export type CommitSupplierProductResult = {
  partId: number;
  supplierId: number;
  configurationIds: number[];
};

// Downloads a single remote image into Vercel Blob and returns the public URL
// plus pathname. Returns null on failure (logged) — the row still saves, just
// without a thumbnail.
async function downloadToBlob(
  remoteUrl: string,
  prefix: string,
): Promise<{ url: string; pathname: string } | null> {
  try {
    const res = await fetch(remoteUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const cleanName =
      (remoteUrl.split("/").pop() || "image").split("?")[0] || "image";
    const safe =
      cleanName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "image";
    const blob = await put(`${prefix}/${Date.now()}-${safe}`, buf, {
      access: "public",
      addRandomSuffix: true,
    });
    return { url: blob.url, pathname: blob.pathname };
  } catch (e) {
    console.warn("[add-product] image download failed:", remoteUrl, e);
    return null;
  }
}

export async function commitSupplierProduct(
  input: CommitSupplierProductInput,
): Promise<CommitSupplierProductResult> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }

  // 1) Resolve supplier id (existing or freshly created).
  let supplierId: number;
  if (input.supplier.kind === "existing") {
    supplierId = input.supplier.supplierId;
  } else {
    const created = await createSupplierForExtraction({
      name: input.supplier.name,
      website: input.supplier.website,
      email: input.supplier.email,
    });
    supplierId = created.id;
  }

  // 2) Download thumbnail if extraction gave us a remote URL.
  let thumbnailUrl: string | null = null;
  let thumbnailPathname: string | null = null;
  if (input.product.thumbnailUrl) {
    const downloaded = await downloadToBlob(
      input.product.thumbnailUrl,
      `supplier-products/${supplierId}`,
    );
    if (downloaded) {
      thumbnailUrl = downloaded.url;
      thumbnailPathname = downloaded.pathname;
    }
  }

  // 3) Pick / generate the globalProductId.
  //    - If linkToGlobalProductId is set, join that cluster.
  //    - Else mint a fresh one.
  const globalProductId =
    input.linkToGlobalProductId ?? `gp-${crypto.randomUUID()}`;

  // 4) Insert the top-level part row.
  const [partRow] = await db
    .insert(supplierProducts)
    .values({
      supplierId,
      parentProductId: null,
      globalProductId,
      isPrimarySupplier: false,
      name: input.product.name.trim(),
      productCode: input.product.productCode?.trim() || null,
      category: input.product.category?.trim() || null,
      description: input.product.description?.trim() || null,
      thumbnailUrl,
      thumbnailPathname,
      createdByRole: "lightbase",
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: supplierProducts.id });

  // 5) Insert configuration rows.
  const configurationIds: number[] = [];
  for (const cfg of input.configurations) {
    const cfgName = cfg.name.trim();
    if (!cfgName) continue;
    const [cfgRow] = await db
      .insert(supplierProducts)
      .values({
        supplierId,
        parentProductId: partRow.id,
        globalProductId: `gp-${crypto.randomUUID()}`,
        isPrimarySupplier: false,
        name: cfgName,
        productCode: cfg.productCode?.trim() || null,
        description: cfg.description?.trim() || null,
        category: null,
        createdByRole: "lightbase",
        createdByClerkId: profile.clerkUserId,
      })
      .returning({ id: supplierProducts.id });
    configurationIds.push(cfgRow.id);
  }

  // 6) Download additional images, attach as "other_file" rows under the part.
  for (const remote of input.product.imageUrls.slice(0, 6)) {
    const downloaded = await downloadToBlob(
      remote,
      `supplier-products/${supplierId}/${partRow.id}`,
    );
    if (!downloaded) continue;
    await db.insert(supplierProductAttachments).values({
      productId: partRow.id,
      category: "other_file",
      name: downloaded.pathname.split("/").pop() ?? "image",
      url: downloaded.url,
      blobPathname: downloaded.pathname,
      uploadedByRole: "lightbase",
      uploadedByClerkId: profile.clerkUserId,
    });
  }

  revalidatePath("/suppliers");
  revalidatePath("/portal");

  return {
    partId: partRow.id,
    supplierId,
    configurationIds,
  };
}
