import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { municipalitySearches, municipalityContacts } from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewEngineering,
  canEdit,
  isAdmin,
} from "@/lib/permissions";
import MunicipalContactsView from "./MunicipalContactsView";

export const dynamic = "force-dynamic";
// Perplexity + Claude pipelines can take ~60-90s for a 100-row generation.
export const maxDuration = 300;

export default async function MunicipalContactsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  // Tolerate missing tables — migration 0011 may not be applied yet on
  // some environments. The page renders empty in that case so the user
  // can still see the form and trigger a generation (which will surface
  // a clearer error).
  let searches: Array<typeof municipalitySearches.$inferSelect> = [];
  let contacts: Array<typeof municipalityContacts.$inferSelect> = [];
  try {
    searches = await db
      .select()
      .from(municipalitySearches)
      .orderBy(desc(municipalitySearches.createdAt));
    contacts = await db
      .select()
      .from(municipalityContacts)
      .orderBy(desc(municipalityContacts.createdAt));
  } catch (e) {
    console.warn(
      "[municipal-contacts] tables not available (run migration 0011):",
      e,
    );
  }

  return (
    <MunicipalContactsView
      searches={searches}
      contacts={contacts}
      canEdit={canEdit(profile)}
    />
  );
}
