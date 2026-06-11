// Nomenclature Generator landing — the new index tab of
// /design-engineering, sitting BEFORE Projects in the sub-nav.
//
// Two generators in one page:
//   • Hardware Generator — pick a family (screw, nut, washer, rivet,
//     anchor, spacer, …), fill template fields OR paste a product
//     URL → AI extracts → save. Auto-creates the family if missing.
//   • Part ID Generator — allocate a 4-char alphanumeric and pin a
//     code of the form CLS-XXXX-WXXXX-HXXXX-LXXXX-<DESC>, with
//     configuration bubbles and description.
//
// Both write to nomenclature_parts AND inventory_items so the rest of
// the ERP can immediately reference the new code.

import { redirect } from "next/navigation";
import {
  canViewDesignEngineering,
  getOrCreateProfile,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import {
  importStandardsFromFolder,
  listParts,
  listProducts,
  listStandards,
  listSupplierOptions,
} from "./actions";
import NomenclatureGenerator from "./NomenclatureGenerator";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Nomenclature Generator — ${CLIENT_CONFIG.name}`,
};

export default async function NomenclaturePage({
  searchParams,
}: {
  searchParams: Promise<{ rescan?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewDesignEngineering(profile)) redirect("/");

  // On first load (or when the user clicks "Re-scan folder"), suck
  // the latest NOMENCLATURE_*.txt files out of OneDrive into the DB.
  // Cheap (~6 files, ~1KB each); we run it lazily so empty DB doesn't
  // surprise a fresh dev.
  const params = await searchParams;
  let scanResult: Awaited<
    ReturnType<typeof importStandardsFromFolder>
  > | null = null;
  const existing = await listStandards();
  if (params.rescan === "1" || existing.length === 0) {
    scanResult = await importStandardsFromFolder();
  }
  const standards = await listStandards();
  const parts = await listParts();
  const supplierOptions = await listSupplierOptions();
  const productOptions = await listProducts();

  return (
    <NomenclatureGenerator
      standards={standards}
      parts={parts}
      scanResult={scanResult}
      supplierOptions={supplierOptions}
      productOptions={productOptions}
    />
  );
}
