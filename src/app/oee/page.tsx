import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewSuppliers } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import ComingSoonModule from "@/components/ComingSoonModule";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `OEE & Floor Ops (Stage 6) — ${CLIENT_CONFIG.name}`,
};

export default async function OeeModulePage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewSuppliers(profile)) redirect("/");
  return (
    <ComingSoonModule
      stage="stage-6"
      intro="Real-time OEE / TRS monitoring (TEEPTRAK-class) + facility digital twin (Prevu3D-class) + field service & maintenance (Genius-class). Ten modules over months 60-90 that take CADuniQ beyond the delivered product onto the customer's own shop floor and into the field service of the products they sold. Every OEE alert auto-creates a CRM ticket; every PDM ECO triggers a maintenance review."
    />
  );
}
