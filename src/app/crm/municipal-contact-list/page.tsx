import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  municipalityListEntries,
  municipalityListExports,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canEdit,
  canViewSuppliers,
  canViewCompetitors,
  canViewEngineering,
  isAdmin,
} from "@/lib/permissions";
import MunicipalContactListView from "./MunicipalContactListView";

export const dynamic = "force-dynamic";

export default async function MunicipalContactListPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  // Tolerate the table not existing yet — the migration may not have
  // been run on this environment. The view shows a setup hint when
  // the list is empty.
  let entries: Array<typeof municipalityListEntries.$inferSelect> = [];
  let myExportedIds: number[] = [];
  try {
    entries = await db
      .select()
      .from(municipalityListEntries)
      .orderBy(asc(municipalityListEntries.name));
  } catch (e) {
    console.error(
      "[municipal-contact-list] entries query failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
  }

  // Per-user export tracking. Wrapped in its own try/catch because the
  // exports table is a separate migration (0017) and a half-applied
  // environment shouldn't blank the whole page.
  try {
    const rows = await db
      .select({ entryId: municipalityListExports.entryId })
      .from(municipalityListExports)
      .where(eq(municipalityListExports.clerkUserId, profile.clerkUserId));
    myExportedIds = rows.map((r) => r.entryId);
  } catch (e) {
    console.error(
      "[municipal-contact-list] exports query failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
  }

  return (
    <MunicipalContactListView
      entries={entries}
      canEdit={canEdit(profile)}
      myExportedIds={myExportedIds}
    />
  );
}
