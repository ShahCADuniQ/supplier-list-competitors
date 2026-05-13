import { redirect } from "next/navigation";
import { getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listVaultFiles } from "../actions";
import VaultBrowser from "./VaultBrowser";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Enterprise PDM (Stage 5i) — ${CLIENT_CONFIG.name}`,
};

// Cross-project CAD file vault. Lists every uploaded CAD file across every
// project in one searchable / filterable view. This is the functional MVP
// of module 5i — multi-site replication, ECO workflows, cross-CAD vault
// (SolidWorks + Inventor + Catia + NX + Creo in one repo) come next.

export default async function EnterprisePdmPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const files = await listVaultFiles();
  return <VaultBrowser files={files} />;
}
