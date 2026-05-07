import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  municipalitySearches,
  municipalityContacts,
  municipalityContactExports,
} from "@/db/schema";
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

  // Tolerate missing tables — older environments may be a migration behind.
  // The page renders empty in that case so the user can still see the form.
  let searches: Array<typeof municipalitySearches.$inferSelect> = [];
  let contacts: Array<typeof municipalityContacts.$inferSelect> = [];
  let myExportMap = new Map<number, Date>();
  try {
    searches = await db
      .select()
      .from(municipalitySearches)
      .orderBy(desc(municipalitySearches.createdAt));
    contacts = await db
      .select()
      .from(municipalityContacts)
      .orderBy(desc(municipalityContacts.createdAt));

    // Per-user export state. The view's existing UI logic looks at each
    // contact's `exportedAt` field — we override it with the current
    // user's per-user export timestamp so each user sees their own
    // "exported / new" counters independently.
    const myExports = await db
      .select({
        contactId: municipalityContactExports.contactId,
        exportedAt: municipalityContactExports.exportedAt,
      })
      .from(municipalityContactExports)
      .where(eq(municipalityContactExports.clerkUserId, profile.clerkUserId));
    myExportMap = new Map(myExports.map((e) => [e.contactId, e.exportedAt]));
  } catch (e) {
    console.warn(
      "[municipal-contacts] tables not available (run migrations):",
      e,
    );
  }

  // Stamp each contact with the CURRENT user's exportedAt (or null), not the
  // global one. The view treats `exportedAt != null` as "I exported this".
  const contactsForUser = contacts.map((c) => ({
    ...c,
    exportedAt: myExportMap.get(c.id) ?? null,
  }));

  return (
    <MunicipalContactsView
      searches={searches}
      contacts={contactsForUser}
      canEdit={canEdit(profile)}
    />
  );
}
