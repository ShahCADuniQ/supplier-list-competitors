import { redirect } from "next/navigation";
import { desc, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  suppliers,
  supplierContacts,
  supplierProjectEntries,
  supplierComments,
  supplierAttachments,
  userProfiles,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
  isCaduniqUser,
} from "@/lib/permissions";
import InventoryAndManufacturing from "./InventoryAndManufacturing";
import { ensureSupplierColumns } from "./_ensure-schema";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewSuppliers(profile)) redirect("/");

  // Self-heal migration 0023 (suppliers.is_starred) before the SELECT goes
  // out — Drizzle generates a column-by-column SELECT from the schema, so
  // a missing column on the live DB blows up the whole page otherwise.
  await ensureSupplierColumns();

  const [supRows, peRows, comRows, attRows, contactRows] = await Promise.all([
    db.select().from(suppliers).orderBy(asc(suppliers.name)),
    db.select().from(supplierProjectEntries),
    db.select().from(supplierComments).orderBy(desc(supplierComments.createdAt)),
    db.select().from(supplierAttachments).orderBy(desc(supplierAttachments.createdAt)),
    db.select().from(supplierContacts).orderBy(desc(supplierContacts.isPrimary), asc(supplierContacts.createdAt)),
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
  const contactsBySupplier = new Map<number, typeof contactRows>();
  contactRows.forEach((c) => {
    const list = contactsBySupplier.get(c.supplierId) ?? [];
    list.push(c);
    contactsBySupplier.set(c.supplierId, list);
  });

  const initialData = supRows.map((s) => ({
    ...s,
    projectEntries: peBySupplier.get(s.id) ?? [],
    comments: comBySupplier.get(s.id) ?? [],
    attachments: attBySupplier.get(s.id) ?? [],
    contacts: contactsBySupplier.get(s.id) ?? [],
  }));

  // "Registered to portal" = a supplier whose email (primary or any
  // contact email) belongs to a user_profiles row flagged isSupplier.
  // We compute the set once on the server and pass ids down so the
  // suppliers tab can show the count + flag rows in the table.
  const portalEmails = await db
    .select({ email: userProfiles.email })
    .from(userProfiles)
    .where(eq(userProfiles.isSupplier, true));
  const portalEmailSet = new Set(
    portalEmails.map((r) => r.email.toLowerCase()),
  );
  const registeredSupplierIds: number[] = [];
  if (portalEmailSet.size > 0) {
    for (const s of supRows) {
      if (s.email && portalEmailSet.has(s.email.toLowerCase())) {
        registeredSupplierIds.push(s.id);
        continue;
      }
      const contacts = contactsBySupplier.get(s.id) ?? [];
      if (contacts.some((c) => c.email && portalEmailSet.has(c.email.toLowerCase()))) {
        registeredSupplierIds.push(s.id);
      }
    }
  }
  return (
    <InventoryAndManufacturing
      initialData={initialData}
      canEdit={canEdit(profile)}
      registeredSupplierIds={registeredSupplierIds}
      isCaduniqStaff={isCaduniqUser(profile)}
    />
  );
}
