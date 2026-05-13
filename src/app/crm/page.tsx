import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewSuppliers } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import ComingSoonModule from "@/components/ComingSoonModule";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `CRM (Stage 4) — ${CLIENT_CONFIG.name}`,
};

export default async function CrmModulePage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewSuppliers(profile)) redirect("/");
  return (
    <ComingSoonModule
      stage="stage-4"
      intro="A product-led CRM that listens to the event bus. Every CAD upload, every quote, every hub QC pass, every OEE alert becomes a customer-record signal — no manual data entry, no broken handoffs between sales / success / support. Eleven modules over months 28-48. Replaces Salesforce + HubSpot + Zendesk + Intercom + Marketo, or syncs two-way with whichever CRM the customer already runs."
    />
  );
}
