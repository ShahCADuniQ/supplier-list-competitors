import { redirect } from "next/navigation";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewEngineering,
  isAdmin,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The /tools tree previously hosted Municipal Contacts (lead generator +
// list); both moved under /crm as of the CRM-integration refactor. The
// remaining /tools routes are now just redirect stubs for backwards
// compatibility — they don't need an in-page pill nav, since the top-of-page
// SubNav already shows Tools tabs (Competitors / Process / Engineering).
export default async function ToolsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  return <>{children}</>;
}
