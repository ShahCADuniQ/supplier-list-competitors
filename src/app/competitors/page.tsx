import { redirect } from "next/navigation";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  competitorCollections,
  competitors,
  competitorAttachments,
  competitorProducts,
  competitorProductAttachments,
  competitorIdeationItems,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewCompetitors,
  canEdit,
} from "@/lib/permissions";
import CompetitorsView from "./CompetitorsView";
import { createCollection } from "./actions";

export const dynamic = "force-dynamic";
// Server actions on this page can take up to ~5 minutes (deep extracts +
// per-PDF Claude analysis). Hobby tier on Vercel caps lower; Pro accepts
// values up to 300. Local dev ignores this entirely.
export const maxDuration = 300;

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

  const [comps, atts, prods, prodAtts] = await Promise.all([
    db.select().from(competitors).orderBy(asc(competitors.name)),
    db.select().from(competitorAttachments).orderBy(desc(competitorAttachments.addedAt)),
    db.select().from(competitorProducts).orderBy(asc(competitorProducts.name)),
    db.select().from(competitorProductAttachments).orderBy(desc(competitorProductAttachments.addedAt)),
  ]);

  // Ideation items live in a table added by migration 0005. If that hasn't been
  // applied yet we render the page without them (Ideation tab shows empty).
  let ideationItems: Array<typeof competitorIdeationItems.$inferSelect> = [];
  try {
    ideationItems = await db
      .select()
      .from(competitorIdeationItems)
      .orderBy(asc(competitorIdeationItems.sortOrder), asc(competitorIdeationItems.id));
  } catch (e) {
    console.warn("competitor_ideation_items not available yet:", e);
  }

  const attsByComp = new Map<number, typeof atts>();
  atts.forEach((a) => {
    const list = attsByComp.get(a.competitorId) ?? [];
    list.push(a);
    attsByComp.set(a.competitorId, list);
  });
  const prodAttsByProd = new Map<number, typeof prodAtts>();
  prodAtts.forEach((a) => {
    const list = prodAttsByProd.get(a.productId) ?? [];
    list.push(a);
    prodAttsByProd.set(a.productId, list);
  });
  const productsByComp = new Map<number, Array<typeof prods[number] & { attachments: typeof prodAtts }>>();
  prods.forEach((p) => {
    const list = productsByComp.get(p.competitorId) ?? [];
    list.push({ ...p, attachments: prodAttsByProd.get(p.id) ?? [] });
    productsByComp.set(p.competitorId, list);
  });

  const compsWithAtts = comps.map((c) => ({
    ...c,
    attachments: attsByComp.get(c.id) ?? [],
    products: productsByComp.get(c.id) ?? [],
  }));

  return (
    <CompetitorsView
      collections={collections}
      brands={compsWithAtts}
      ideationItems={ideationItems}
      canEdit={canEdit(profile)}
    />
  );
}
