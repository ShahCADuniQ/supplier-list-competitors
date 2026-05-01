import { redirect } from "next/navigation";
import { desc, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  suppliers,
  supplierProjectEntries,
  supplierComments,
  supplierAttachments,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";
import SuppliersView from "./SuppliersView";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewSuppliers(profile)) redirect("/");

  const [supRows, peRows, comRows, attRows] = await Promise.all([
    db.select().from(suppliers).orderBy(asc(suppliers.name)),
    db.select().from(supplierProjectEntries),
    db.select().from(supplierComments).orderBy(desc(supplierComments.createdAt)),
    db.select().from(supplierAttachments).orderBy(desc(supplierAttachments.createdAt)),
  ]);

  // Hydrate suppliers with their child collections so the client can render
  // everything from one tree without extra round-trips.
  const peBySupplier = new Map<number, typeof peRows>();
  peRows.forEach((p) => {
    const list = peBySupplier.get(p.supplierId) ?? [];
    list.push(p);
    peBySupplier.set(p.supplierId, list);
  });
  const comBySupplier = new Map<number, typeof comRows>();
  comRows.forEach((c) => {
    const list = comBySupplier.get(c.supplierId) ?? [];
    list.push(c);
    comBySupplier.set(c.supplierId, list);
  });
  const attBySupplier = new Map<number, typeof attRows>();
  attRows.forEach((a) => {
    const list = attBySupplier.get(a.supplierId) ?? [];
    list.push(a);
    attBySupplier.set(a.supplierId, list);
  });

  const initialData = supRows.map((s) => ({
    ...s,
    projectEntries: peBySupplier.get(s.id) ?? [],
    comments: comBySupplier.get(s.id) ?? [],
    attachments: attBySupplier.get(s.id) ?? [],
  }));

  return <SuppliersView initialData={initialData} canEdit={canEdit(profile)} />;
}
