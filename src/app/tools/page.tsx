import { redirect } from "next/navigation";
import {
  getOrCreateProfile,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Tools landing redirects to the first sub-page the user can actually see.
// Municipal Contacts moved under /crm as of the CRM-integration refactor, so
// the only routes that still live under Tools are Competitors, Process, and
// Engineering.
export default async function ToolsLanding() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (canViewCompetitors(profile)) redirect("/competitors");
  if (canViewHandbook(profile)) redirect("/handbook");
  if (canViewEngineering(profile)) redirect("/engineering");
  redirect("/crm/municipal-contacts");
}
