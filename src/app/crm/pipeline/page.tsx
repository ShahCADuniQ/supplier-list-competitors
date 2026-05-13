import { redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listPipelineOpportunities } from "../actions";
import PipelineKanban from "./PipelineKanban";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Pipeline — CRM — ${CLIENT_CONFIG.name}`,
};

export default async function PipelinePage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");
  const opps = await listPipelineOpportunities();
  return <PipelineKanban opportunities={opps} />;
}
