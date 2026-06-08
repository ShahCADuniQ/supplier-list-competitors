// Used by AddProductDialog's manual tab to warn before saving a product whose
// code already exists in the catalogue (so we can offer to link as an
// alternative supplier on the existing cluster).

import { findExistingProductsByCode } from "@/app/suppliers/supplier-inventory-actions";
import { getOrCreateProfile, canViewSuppliers } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code) {
    return new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const candidates = await findExistingProductsByCode({ productCode: code });
    return new Response(JSON.stringify({ candidates }), {
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
