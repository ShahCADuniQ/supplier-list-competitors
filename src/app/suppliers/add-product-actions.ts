"use server";

// Orchestration for the Supplier Catalogue "Add product" flow.
// Two stages, each backed by its own Route Handler:
//   1) extract — fetch URL → Perplexity → Claude → match candidates.
//   2) commit  — write supplier_products row(s), download images, attach files.
//
// The two stages live in separate endpoints so the user can confirm the
// supplier resolution and the existing-product link choice between them.
// Extract streams progress via SSE; commit is a single JSON request.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

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
// Reuse the competitors module's battle-tested image fetcher — it sends a
// browser User-Agent + Referer + Accept headers so CDN WAFs (Cloudflare,
// Akamai) don't 403 the request, validates that the response is an actual
// image (and not an HTML login wall), and enforces a max size + timeout.
import { downloadProductImageToBlob } from "@/app/competitors/_attachments";

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
  // Original product page URL — only set when adding from URL flow. Used as
  // the Referer when downloading images so hotlink-protected CDNs (Shopify,
  // BigCommerce, etc.) let the image through.
  sourcePageUrl?: string | null;
  // The product card itself. May come from extraction (auto-fill) or from the
  // manual form. The commit endpoint doesn't care which.
  product: {
    name: string;
    productCode: string | null;
    category: string | null;
    description: string | null;
    productUrl: string | null;
    thumbnailUrl: string | null; // remote URL — downloaded into blob here
    imageUrls: string[]; // additional images — attached as "other_file" rows
  };
  configurations: Array<{
    name: string;
    productCode: string | null;
    description: string | null;
    productUrl: string | null;
  }>;
};

export type CommitSupplierProductResult = {
  partId: number;
  supplierId: number;
  configurationIds: number[];
  // Image-download accounting — surfaced so the client can show a toast
  // explaining why a card might be missing its picture (almost always: the
  // brand site blocked the fetch even with browser headers).
  thumbnailLanded: boolean;
  thumbnailAttempted: boolean;
  imagesAttempted: number;
  imagesLanded: number;
  failedImageUrls: string[];
};

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
  //    Use a fresh per-product prefix so it groups under the supplier
  //    naturally on Vercel Blob.
  const imagePrefix = `supplier-products/${supplierId}/${crypto.randomUUID()}`;
  let thumbnailUrl: string | null = null;
  let thumbnailPathname: string | null = null;
  let thumbnailLanded = false;
  const thumbnailAttempted = !!input.product.thumbnailUrl;
  if (input.product.thumbnailUrl) {
    const downloaded = await downloadProductImageToBlob({
      pathPrefix: imagePrefix,
      sourceUrl: input.product.thumbnailUrl,
      refererOverride: input.sourcePageUrl ?? undefined,
    });
    if (downloaded) {
      thumbnailUrl = downloaded.blobUrl;
      thumbnailPathname = downloaded.blobPathname;
      thumbnailLanded = true;
    } else {
      console.warn(
        `[add-product] thumbnail download failed: ${input.product.thumbnailUrl}`,
      );
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
      productUrl: input.product.productUrl?.trim() || null,
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
        productUrl: cfg.productUrl?.trim() || null,
        category: null,
        createdByRole: "lightbase",
        createdByClerkId: profile.clerkUserId,
      })
      .returning({ id: supplierProducts.id });
    configurationIds.push(cfgRow.id);
  }

  // 6) Download additional images, attach as "other_file" rows under the part.
  //    If thumbnailUrl was also in the imageUrls list, skip it — we already
  //    downloaded it above as the thumbnail.
  const imageQueue = input.product.imageUrls
    .slice(0, 6)
    .filter((u) => u && u !== input.product.thumbnailUrl);
  const imagesAttempted = imageQueue.length;
  let imagesLanded = 0;
  const failedImageUrls: string[] = [];
  if (!thumbnailLanded && thumbnailAttempted) {
    failedImageUrls.push(input.product.thumbnailUrl!);
  }
  for (const remote of imageQueue) {
    const downloaded = await downloadProductImageToBlob({
      pathPrefix: imagePrefix,
      sourceUrl: remote,
      refererOverride: input.sourcePageUrl ?? undefined,
    });
    if (!downloaded) {
      failedImageUrls.push(remote);
      continue;
    }
    imagesLanded += 1;
    await db.insert(supplierProductAttachments).values({
      productId: partRow.id,
      category: "other_file",
      name: downloaded.blobPathname.split("/").pop() ?? "image",
      url: downloaded.blobUrl,
      blobPathname: downloaded.blobPathname,
      contentType: downloaded.mime,
      size: downloaded.size,
      uploadedByRole: "lightbase",
      uploadedByClerkId: profile.clerkUserId,
    });

    // Backfill the thumbnail from the first successfully-downloaded extra
    // image if the original thumbnail attempt failed. Better than no picture
    // at all — the user can swap it later in the drawer.
    if (!thumbnailLanded) {
      thumbnailUrl = downloaded.blobUrl;
      thumbnailPathname = downloaded.blobPathname;
      thumbnailLanded = true;
      await db
        .update(supplierProducts)
        .set({
          thumbnailUrl,
          thumbnailPathname,
          updatedAt: new Date(),
        })
        .where(eq(supplierProducts.id, partRow.id));
    }
  }

  revalidatePath("/suppliers");
  revalidatePath("/portal");

  return {
    partId: partRow.id,
    supplierId,
    configurationIds,
    thumbnailLanded,
    thumbnailAttempted,
    imagesAttempted,
    imagesLanded,
    failedImageUrls,
  };
}
