import { redirect } from "next/navigation";
import { asc, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, crmAccounts, supplierContacts, suppliers, userProfiles } from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  isCaduniqUser,
  ADMIN_EMAILS,
  ADMIN_EMAIL_DOMAINS,
} from "@/lib/permissions";
import { CLIENT_CONFIG, CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";
import { ensureSupplierColumns } from "@/app/suppliers/_ensure-schema";
import AdminPanel from "./AdminPanel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!isAdmin(profile)) redirect("/");

  // Suppliers tab needs portal_token; self-heal the column first so the
  // SELECT below doesn't blow up on environments that haven't run migration
  // 0025 yet.
  await ensureSupplierColumns();

  const caduniq = isCaduniqUser(profile);

  const [users, supplierRows, clientRows] = await Promise.all([
    db.select().from(userProfiles).orderBy(asc(userProfiles.createdAt)),
    // Pull just what the Suppliers tab needs — keep the payload light.
    // FILTER: only suppliers who have actually signed up to the vendor
    // portal (a Clerk-authed user_profiles row with is_supplier=true) OR
    // who have engaged with a magic-link invite (viewed / drafted /
    // submitted a quote). Excludes the long tail of legacy directory rows
    // that never engaged so the admin sees real portal accounts only.
    db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        email: suppliers.email,
        contactName: suppliers.contactName,
        category: suppliers.category,
        origin: suppliers.origin,
        isStarred: suppliers.isStarred,
        portalToken: suppliers.portalToken,
        clientId: suppliers.clientId,
        invitedCount: sql<number>`(
          SELECT COUNT(*)::int FROM rfq_recipients r
          WHERE r.supplier_id = ${suppliers.id}
             OR (r.supplier_id IS NULL AND LOWER(r.invite_email) = LOWER(${suppliers.email}))
        )`,
      })
      .from(suppliers)
      .where(
        sql`
          EXISTS (
            SELECT 1 FROM user_profiles up
            WHERE up.is_supplier = true
              AND (
                LOWER(up.email) = LOWER(${suppliers.email})
                OR EXISTS (
                  SELECT 1 FROM supplier_contacts sc
                  WHERE sc.supplier_id = ${suppliers.id}
                    AND LOWER(sc.email) = LOWER(up.email)
                )
              )
          )
          OR EXISTS (
            SELECT 1 FROM rfq_recipients r
            WHERE r.status IN ('viewed','draft','submitted')
              AND (
                r.supplier_id = ${suppliers.id}
                OR (r.supplier_id IS NULL AND LOWER(r.invite_email) = LOWER(${suppliers.email}))
              )
          )
        `,
      )
      .orderBy(asc(suppliers.name)),
    db.select().from(clients).orderBy(asc(clients.name)),
  ]);

  // For non-CADuniQ admins (e.g. hshah@lightbase.ca), scope the data to
  // just their client tenant. They can't see other clients' users /
  // suppliers — that's the tenant boundary.
  const ownClientId = profile.clientId ?? null;
  const scopedUsers = caduniq
    ? users
    : users.filter((u) => u.clientId === ownClientId);
  const scopedSuppliers = caduniq
    ? supplierRows
    : supplierRows.filter((s) => s.clientId === ownClientId);

  // Fetch every contact email for the visible suppliers so the admin can
  // edit/add/remove them inline without a per-row round-trip.
  const supplierIds = scopedSuppliers.map((s) => s.id);
  const contactRows = supplierIds.length > 0
    ? await db
        .select()
        .from(supplierContacts)
        .where(inArray(supplierContacts.supplierId, supplierIds))
        .orderBy(asc(supplierContacts.isPrimary), asc(supplierContacts.createdAt))
    : [];
  const contactsBySupplier: Record<number, typeof contactRows> = {};
  for (const c of contactRows) {
    (contactsBySupplier[c.supplierId] ?? (contactsBySupplier[c.supplierId] = [])).push(c);
  }
  const scopedSuppliersWithContacts = scopedSuppliers.map((s) => ({
    ...s,
    contacts: contactsBySupplier[s.id] ?? [],
  }));

  // CRM accounts surfaced as the "Clients" tab inside a client tenant's
  // admin view (Lightbase's own customers, NOT the CADuniQ tenant table).
  // Top 50 by most-recently updated — for the full list the admin clicks
  // through to /crm/accounts. CADuniQ admins don't see this pill since
  // their Clients tab is the multi-tenant directory.
  const crmAccountRows = !caduniq
    ? await db
        .select({
          id: crmAccounts.id,
          name: crmAccounts.name,
          website: crmAccounts.website,
          industry: crmAccounts.industry,
          tier: crmAccounts.tier,
          country: crmAccounts.country,
          healthScore: crmAccounts.healthScore,
          updatedAt: crmAccounts.updatedAt,
        })
        .from(crmAccounts)
        .orderBy(desc(crmAccounts.updatedAt))
        .limit(50)
    : [];
  const crmAccountTotal = !caduniq
    ? (await db.select({ n: sql<number>`COUNT(*)::int` }).from(crmAccounts))[0]?.n ?? 0
    : 0;

  return (
    <AdminPanel
      users={scopedUsers}
      suppliers={scopedSuppliersWithContacts}
      clients={clientRows}
      crmAccounts={crmAccountRows}
      crmAccountTotal={Number(crmAccountTotal)}
      isCaduniq={caduniq}
      ownClientId={ownClientId}
      adminEmails={[...ADMIN_EMAILS]}
      adminDomains={[...ADMIN_EMAIL_DOMAINS]}
      currentClerkId={profile.clerkUserId}
      clientName={CLIENT_CONFIG.name}
      clientIndustry={CLIENT_CONFIG.industry}
      caduniqProductLabel={CADUNIQ_PRODUCT_LABEL}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? ""}
    />
  );
}
