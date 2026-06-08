// Used by AddProductDialog's "+ Create new supplier" sub-dialog (manual tab).
// Creates a fresh supplier row in the active tenant.

import { createSupplierForExtraction } from "@/app/suppliers/supplier-inventory-actions";
import { getOrCreateProfile, canViewSuppliers, canEdit } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  website?: string | null;
  email?: string | null;
};

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body.name?.trim()) {
    return new Response(JSON.stringify({ error: "name is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await createSupplierForExtraction({
      name: body.name,
      website: body.website ?? null,
      email: body.email ?? null,
    });
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
