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
// Vercel Pro caps at 800; Hobby caps at 60 (so generations >25 contacts may
// still time out on Hobby — that's a plan limit, not a code one).
export const maxDuration = 800;

export default async function MunicipalContactsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  // Tolerate missing tables / partial migrations — each query is isolated so
  // a missing column on one table can't tank the whole page render. The
  // view tolerates empty lists and just shows "No searches yet".
  let searches: Array<typeof municipalitySearches.$inferSelect> = [];
  let contacts: Array<typeof municipalityContacts.$inferSelect> = [];
  let myExportMap = new Map<number, Date>();

  try {
    searches = await db
      .select()
      .from(municipalitySearches)
      .orderBy(desc(municipalitySearches.createdAt));
  } catch (e) {
    console.error(
      "[municipal-contacts] municipality_searches query failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
  }

  try {
    contacts = await db
      .select()
      .from(municipalityContacts)
      .orderBy(desc(municipalityContacts.createdAt));
  } catch (e) {
    console.error(
      "[municipal-contacts] municipality_contacts query failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
  }

  // Per-user export state. The view's existing UI logic looks at each
  // contact's `exportedAt` field — we override it with the current user's
  // per-user export timestamp so each user sees their own counters
  // independently. If migration 0015 hasn't reached this environment yet,
  // we silently fall back to an empty map and every contact shows as "new"
  // (which is the correct behaviour for a brand-new user anyway).
  try {
    const myExports = await db
      .select({
        contactId: municipalityContactExports.contactId,
        exportedAt: municipalityContactExports.exportedAt,
      })
      .from(municipalityContactExports)
      .where(eq(municipalityContactExports.clerkUserId, profile.clerkUserId));
    myExportMap = new Map(myExports.map((e) => [e.contactId, e.exportedAt]));
  } catch (e) {
    console.error(
      "[municipal-contacts] municipality_contact_exports query failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
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
