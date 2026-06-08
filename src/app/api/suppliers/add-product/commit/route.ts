// Commit endpoint for the Supplier Catalogue add-product flow. POSTed by the
// AddProductDialog after the user confirms supplier resolution + existing-
// product link choice (from /api/suppliers/add-product/extract for URL flow,
// or directly with the manual form data).

import {
  commitSupplierProduct,
  type CommitSupplierProductInput,
} from "@/app/suppliers/add-product-actions";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body: CommitSupplierProductInput;
  try {
    body = (await request.json()) as CommitSupplierProductInput;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body?.product?.name?.trim()) {
    return new Response(JSON.stringify({ error: "product.name is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await commitSupplierProduct(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
