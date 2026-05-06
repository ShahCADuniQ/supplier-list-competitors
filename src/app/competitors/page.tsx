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
  ideationProducts,
  ideationItemProducts,
  ideationProductFiles,
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

  // Ideation items live in a table added by migration 0005. The is_global
  // column was added in 0007. If 0007 hasn't been applied yet, the full
  // SELECT fails on the missing column — we fall back to selecting only the
  // pre-V10 columns and stamp isGlobal=true onto each row so existing
  // Pinterest cards keep rendering. The Ideation board treats them as
  // applying to every product (the V10 default), and the user can re-link
  // individual cards once they've migrated.
  let ideationItems: Array<typeof competitorIdeationItems.$inferSelect> = [];
  try {
    ideationItems = await db
      .select()
      .from(competitorIdeationItems)
      .orderBy(asc(competitorIdeationItems.sortOrder), asc(competitorIdeationItems.id));
  } catch (e) {
    console.warn("Full ideation_items select failed; trying pre-V10 columns only:", e);
    try {
      const rows = await db
        .select({
          id: competitorIdeationItems.id,
          collectionId: competitorIdeationItems.collectionId,
          title: competitorIdeationItems.title,
          notes: competitorIdeationItems.notes,
          imageUrl: competitorIdeationItems.imageUrl,
          blobPathname: competitorIdeationItems.blobPathname,
          mimeType: competitorIdeationItems.mimeType,
          size: competitorIdeationItems.size,
          kind: competitorIdeationItems.kind,
          competitorId: competitorIdeationItems.competitorId,
          productId: competitorIdeationItems.productId,
          annotations: competitorIdeationItems.annotations,
          tags: competitorIdeationItems.tags,
          sortOrder: competitorIdeationItems.sortOrder,
          addedByClerkId: competitorIdeationItems.addedByClerkId,
          createdAt: competitorIdeationItems.createdAt,
          updatedAt: competitorIdeationItems.updatedAt,
        })
        .from(competitorIdeationItems)
        .orderBy(
          asc(competitorIdeationItems.sortOrder),
          asc(competitorIdeationItems.id),
        );
      ideationItems = rows.map((r) => ({ ...r, isGlobal: true }));
    } catch (e2) {
      console.warn("competitor_ideation_items not available yet:", e2);
    }
  }

  // Ideation products + linkages live in tables added by migration 0007.
  // Same pattern: tolerate missing tables so an unmigrated DB still loads
  // the page (board renders without product filtering).
  let ideationProductRows: Array<typeof ideationProducts.$inferSelect> = [];
  let ideationItemProductRows: Array<typeof ideationItemProducts.$inferSelect> = [];
  try {
    ideationProductRows = await db
      .select()
      .from(ideationProducts)
      .orderBy(asc(ideationProducts.sortOrder), asc(ideationProducts.id));
    ideationItemProductRows = await db.select().from(ideationItemProducts);
  } catch (e) {
    console.warn("ideation_products / ideation_item_products not available yet:", e);
  }

  // Files for the product drawer + collection brochure (migration 0008).
  let ideationProductFileRows: Array<typeof ideationProductFiles.$inferSelect> = [];
  try {
    ideationProductFileRows = await db
      .select()
      .from(ideationProductFiles)
      .orderBy(desc(ideationProductFiles.addedAt));
  } catch (e) {
    console.warn("ideation_product_files not available yet:", e);
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
      ideationProducts={ideationProductRows}
      ideationItemProducts={ideationItemProductRows}
      ideationProductFiles={ideationProductFileRows}
      canEdit={canEdit(profile)}
    />
  );
}
