"use server";

// Public sign-up onboarding actions — called by the post-Clerk-signup
// wizard at /onboarding. Two flows:
//   • claimEngineeringCompany — creates a new clients (tenant) row and
//     promotes the current user to admin of that tenant.
//   • claimSupplier — creates a suppliers row scoped to the engineering
//     company the supplier picked (by email), with onboarding_status=
//     'pending' so the buyer reviews and approves before access is granted.
//
// Anonymity invariant: neither flow exposes the other party's identity.
// The supplier picks the engineering company by EMAIL ONLY — we resolve
// internally and never disclose the matched client's full record.

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  crmAccounts,
  crmContacts,
  erpNotifications,
  suppliers,
  supplierContacts,
  userProfiles,
} from "@/db/schema";
import { ensureUserProfileColumns, getOrCreateProfile } from "@/lib/permissions";
import { ensureOnboardingSchema } from "@/app/suppliers/_ensure-onboarding-schema";
import { ensureSupplierColumns } from "@/app/suppliers/_ensure-schema";

// ─────────────────────────────────────────────────────────────────────────────
// ENGINEERING COMPANY — create the tenant and make the user its admin.
// ─────────────────────────────────────────────────────────────────────────────

export async function claimEngineeringCompany(input: {
  companyName: string;
  industry: string;
  contactName?: string;
  phone?: string;
  website?: string;
}): Promise<{ clientId: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in first");

  if (!input.companyName.trim()) throw new Error("Company name is required");
  await ensureSupplierColumns();

  // Check whether this user has already finished claiming an engineering
  // company. We check role === "admin" (the real signal a claim has
  // completed) rather than profile.clientId, because clientId is
  // auto-backfilled to the default client on every non-CADuniQ user by
  // ensureUserProfileColumns. Trusting clientId alone would block
  // legitimate first-time claims with "already linked to a company".
  if (profile.role === "admin") {
    throw new Error("Your account is already linked to a company. Sign in to continue.");
  }

  // New tenants are created with EVERY module gated off. The CADuniQ
  // admin enables modules manually from the HQ dashboard after vetting
  // the signup. The DB column defaults are `true` (existing tenants
  // keep working), so we override explicitly here.
  const [row] = await db
    .insert(clients)
    .values({
      name: input.companyName.trim(),
      industry: input.industry?.trim() || null,
      notes: [
        input.contactName ? `Contact: ${input.contactName.trim()}` : null,
        input.phone ? `Phone: ${input.phone.trim()}` : null,
        input.website ? `Website: ${input.website.trim()}` : null,
      ].filter(Boolean).join(" · ") || null,
      canUseSuppliers: false,
      canUseCompetitors: false,
      canUseHandbook: false,
      canUseEngineering: false,
      canUseDesignEngineering: false,
      canUseCrm: false,
      canUseOee: false,
    })
    .returning({ id: clients.id });

  // Promote the creator to admin of their new tenant. Other team members
  // can be invited later from /admin.
  await db
    .update(userProfiles)
    .set({
      clientId: row.id,
      role: "admin",
      canViewSuppliers: true,
      canEdit: true,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.clerkUserId, profile.clerkUserId));

  revalidatePath("/");
  revalidatePath("/admin");
  return { clientId: row.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER — create a suppliers row scoped to the engineering company
// they want to work with. Identified by the engineering company's email
// (matched against existing client admins). Status = 'pending' so the
// engineering company's admin must approve via the onboarding queue.
// ─────────────────────────────────────────────────────────────────────────────

export async function claimSupplier(input: {
  companyName: string;
  contactName: string;
  phone?: string;
  website?: string;
  category?: string;
  subCategory?: string;
  country?: string;
  products?: string;
  manufacturingTypes?: string[];
  materials?: string[];
  // True when the supplier identifies as a pure distributor / reseller.
  // The wizard hides the manufacturing/materials questions in this case
  // and sends empty arrays; we still write the explicit flag so the
  // reviewer sees the signal instead of inferring from empty arrays.
  isDistributor?: boolean;
  // The engineering company's email (one of their admin contacts) — we
  // look this up against existing client tenants. NO data is leaked back
  // about the matched client; we only confirm a match was found.
  engineeringCompanyEmail: string;
}): Promise<{ supplierId: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in first");

  if (!input.companyName.trim()) throw new Error("Your company name is required");
  if (!input.engineeringCompanyEmail.trim()) throw new Error("The engineering company's email is required");

  await ensureSupplierColumns();
  await ensureOnboardingSchema();

  // Resolve the engineering company by looking up a user_profiles row
  // whose email matches AND who belongs to a client tenant. We require a
  // match: the supplier MUST link to a real engineering company so the
  // submission has a tenant to route into. If they typed an unknown
  // email we throw a friendly error so the wizard can show "no user
  // under that email, please try a different one".
  const wantedEmail = input.engineeringCompanyEmail.trim().toLowerCase();
  const [profileMatch] = await db
    .select({ clientId: userProfiles.clientId })
    .from(userProfiles)
    .where(
      and(
        sql`LOWER(${userProfiles.email}) = ${wantedEmail}`,
        sql`${userProfiles.clientId} IS NOT NULL`,
      ),
    )
    .limit(1);

  if (!profileMatch?.clientId) {
    throw new Error(
      `We couldn't find an Engineering/Designer Company on CADuniQ with the email "${input.engineeringCompanyEmail.trim()}". Double-check the spelling, or ask them to sign up first and share their account email with you.`,
    );
  }
  const resolvedClientId: number = profileMatch.clientId;

  // Mark the user as a supplier role on user_profiles.
  await db
    .update(userProfiles)
    .set({
      isSupplier: true,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.clerkUserId, profile.clerkUserId));

  // Create the suppliers row. EVERY shop-side fact is captured here so
  // the step-2 compliance form doesn't need to re-ask any of it.
  const manufacturingTypes = (input.manufacturingTypes ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const materials = (input.materials ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const [row] = await db
    .insert(suppliers)
    .values({
      name: input.companyName.trim(),
      email: profile.email ?? null,
      contactName: input.contactName.trim() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      category: input.category?.trim() || null,
      subCategory: input.subCategory?.trim() || null,
      origin: input.country?.trim() || null,
      products: input.products?.trim() || null,
      manufacturingTypes: manufacturingTypes.length > 0 ? manufacturingTypes : undefined,
      materials: materials.length > 0 ? materials : undefined,
      isDistributor: Boolean(input.isDistributor),
      clientId: resolvedClientId,
      onboardingStatus: "pending",
    })
    .returning({ id: suppliers.id });

  // Drop a primary contact entry mirroring the supplier email so the
  // portal-auth (which matches by suppliers.email OR supplier_contacts.email)
  // recognises the signed-in user immediately.
  if (profile.email) {
    try {
      await db.insert(supplierContacts).values({
        supplierId: row.id,
        email: profile.email,
        name: input.contactName.trim() || null,
        isPrimary: true,
      });
    } catch { /* tolerate dup */ }
  }

  // Ping the engineering tenant's admin team so they know a new
  // supplier has signed up and started onboarding. The bell only
  // shows alerts to the targeted clerk_user_id, so we fan-out one
  // row per admin/editor on that tenant. Best-effort: a notification
  // failure must NOT roll back the supplier signup itself.
  try {
    const team = await db
      .select({ id: userProfiles.clerkUserId })
      .from(userProfiles)
      .where(sql`
        ${userProfiles.clientId} = ${resolvedClientId}
        AND ${userProfiles.isSupplier} = false
        AND ${userProfiles.isRetailer} = false
        AND (
          ${userProfiles.role} = 'admin'
          OR (${userProfiles.canEdit} = true AND ${userProfiles.canViewSuppliers} = true)
        )
      `);
    if (team.length > 0) {
      await db.insert(erpNotifications).values(
        team.map((u) => ({
          targetClerkId: u.id,
          kind: "supplier.signed-up" as const,
          title: `New supplier signup: ${input.companyName.trim()}`,
          body: `${input.contactName.trim()} just started onboarding. They'll appear in your suppliers admin once their compliance checklist is submitted.`,
          linkUrl: "/admin",
        })),
      );
    }
  } catch (e) {
    console.warn("[claimSupplier] notifyTeam failed:", e);
  }

  revalidatePath("/portal");
  revalidatePath("/admin");
  return { supplierId: row.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// RETAILER — third public sign-up role. Buyers / distributors of finished
// goods. They get scoped to the engineering company they buy from by
// looking up that company's email. We create a crm_accounts row inside
// the engineering company's tenant so the buyer's relationship shows up
// where the engineering company's sales team already works (CRM tab on
// the admin), and flip isRetailer on the user_profiles row so they
// land on /retailer instead of any internal module.
// ─────────────────────────────────────────────────────────────────────────────

export async function claimRetailer(input: {
  companyName: string;
  contactName: string;
  phone?: string;
  website?: string;
  industry?: string;
  country?: string;
  // The engineering company they buy from (same resolution as supplier).
  engineeringCompanyEmail: string;
}): Promise<{ accountId: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Sign in first");

  if (!input.companyName.trim()) throw new Error("Your company name is required");
  if (!input.engineeringCompanyEmail.trim()) throw new Error("The engineering company's email is required");

  await ensureUserProfileColumns();

  // Look up the engineering company by an existing admin's email. We
  // require a match for the same reason supplier sign-up does — the
  // retailer's CRM account has to land inside a real tenant.
  const wantedEmail = input.engineeringCompanyEmail.trim().toLowerCase();
  const [profileMatch] = await db
    .select({ clientId: userProfiles.clientId })
    .from(userProfiles)
    .where(
      and(
        sql`LOWER(${userProfiles.email}) = ${wantedEmail}`,
        sql`${userProfiles.clientId} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!profileMatch?.clientId) {
    throw new Error(
      `We couldn't find an engineering company on CADuniQ with the email "${input.engineeringCompanyEmail.trim()}". Double-check the spelling, or ask them to sign up first and share their account email with you.`,
    );
  }
  const resolvedClientId: number = profileMatch.clientId;

  // Flip the retailer flag on the user_profiles row. Same role bump
  // pattern as supplier sign-up.
  await db
    .update(userProfiles)
    .set({
      isRetailer: true,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.clerkUserId, profile.clerkUserId));

  // Drop a row into the engineering company's CRM so their sales team
  // sees the new retailer where they normally work. owner_user_id is
  // set to the retailer themselves for now — the engineering company's
  // admin re-assigns it on first review.
  const [acc] = await db
    .insert(crmAccounts)
    .values({
      ownerUserId: profile.clerkUserId,
      name: input.companyName.trim(),
      website: input.website?.trim() || null,
      industry: input.industry?.trim() || null,
      country: input.country?.trim() || null,
      tier: "lead",
      notes: [
        `Self-registered via /get-started?role=retailer`,
        input.contactName ? `Contact: ${input.contactName.trim()}` : null,
        input.phone ? `Phone: ${input.phone.trim()}` : null,
        `Linked to engineering company (clientId=${resolvedClientId})`,
      ].filter(Boolean).join("\n"),
    })
    .returning({ id: crmAccounts.id });

  // Add the retailer as a contact under their own account so the
  // engineering company's CRM has an email to reach them.
  if (profile.email) {
    try {
      await db.insert(crmContacts).values({
        accountId: acc.id,
        firstName: input.contactName.trim().split(/\s+/)[0] || "Retailer",
        lastName: input.contactName.trim().split(/\s+/).slice(1).join(" ") || "",
        email: profile.email,
        phone: input.phone?.trim() || null,
        isPrimary: true,
      });
    } catch { /* tolerate dup */ }
  }

  revalidatePath("/retailer");
  revalidatePath("/admin");
  return { accountId: acc.id };
}
