import { redirect } from "next/navigation";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  competitorCollections,
  competitors,
  competitorAttachments,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewCompetitors,
  canEdit,
} from "@/lib/permissions";
import CompetitorsView from "./CompetitorsView";
import { createCollection } from "./actions";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCompetitors(profile)) redirect("/");

  let collections = await db
    .select()
    .from(competitorCollections)
    .orderBy(asc(competitorCollections.name));

  // First-run: create a default collection so the user has somewhere to start.
  if (!collections.length && canEdit(profile)) {
    await createCollection("Linear Lighting");
    collections = await db
      .select()
      .from(competitorCollections)
      .orderBy(asc(competitorCollections.name));
  }

  const [comps, atts] = await Promise.all([
    db.select().from(competitors).orderBy(asc(competitors.name)),
    db.select().from(competitorAttachments).orderBy(desc(competitorAttachments.addedAt)),
  ]);

  const attsByComp = new Map<number, typeof atts>();
  atts.forEach((a) => {
    const list = attsByComp.get(a.competitorId) ?? [];
    list.push(a);
    attsByComp.set(a.competitorId, list);
  });

  const compsWithAtts = comps.map((c) => ({
    ...c,
    attachments: attsByComp.get(c.id) ?? [],
  }));

  return (
    <CompetitorsView
      collections={collections}
      brands={compsWithAtts}
      canEdit={canEdit(profile)}
    />
  );
}
