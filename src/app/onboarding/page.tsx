import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { suppliers, supplierContacts, userProfiles } from "@/db/schema";
import {
  getOrCreateProfile,
  isCaduniqUser,
  isRetailerUser,
} from "@/lib/permissions";
import OnboardingWizard from "./OnboardingWizard";

// Post-signup onboarding wizard. Reads `?role=` from the URL (set by the
// /get-started chooser when it linked to Clerk's sign-up) and shows the
// matching collection form:
//   • role=engineering → company name + industry → creates a clients row
//   • role=supplier    → full onboarding form + engineering company email
//                        → creates a suppliers row scoped to that client
// CADuniQ staff bypass this entirely.

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Welcome to CADuniQ",
  description: "Finish setting up your CADuniQ account.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  // CADuniQ staff don't need onboarding — they have cross-tenant access.
  if (isCaduniqUser(profile)) redirect("/admin");

  // If they already finished a claim, skip the wizard. We DELIBERATELY
  // do not use `profile.clientId` here: ensureUserProfileColumns
  // auto-backfills clientId=1 onto every non-CADuniQ user, so it isn't
  // a reliable "finished engineering signup" signal. The actual signal
  // is role === "admin" (set by claimEngineeringCompany). Same redirect
  // bug that bit page.tsx earlier — if we trust the backfilled clientId
  // here, signed-in mid-signup users get bounced /onboarding → /admin
  // → / → /onboarding (infinite loop, "render takes forever" in the
  // browser).
  if (profile.role === "admin") redirect("/admin");
  // A supplier-flagged user normally lives at /portal. BUT if their
  // supplier row has been deleted (admin removed them, or their email
  // got rotated off the contact list), bouncing them to /portal here
  // would just send them back to a dead-end. Detect "isSupplier=true
  // AND no matching supplier row" and let the wizard re-render so they
  // can submit a fresh sign-up. The /portal page already pre-stamps
  // pendingSignupRole='supplier' before sending them here.
  if (profile.isSupplier) {
    const emailLc = (profile.email ?? "").toLowerCase();
    let hasSupplierRow = false;
    if (emailLc) {
      const [bySupplierEmail] = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(sql`LOWER(${suppliers.email}) = ${emailLc}`)
        .limit(1);
      if (bySupplierEmail) hasSupplierRow = true;
      if (!hasSupplierRow) {
        const [byContactEmail] = await db
          .select({ id: supplierContacts.id })
          .from(supplierContacts)
          .where(sql`LOWER(${supplierContacts.email}) = ${emailLc}`)
          .limit(1);
        if (byContactEmail) hasSupplierRow = true;
      }
    }
    if (hasSupplierRow) redirect("/portal");
    // No supplier row → fall through to the wizard so they can re-register.
  }
  if (isRetailerUser(profile)) redirect("/retailer");

  const params = await searchParams;
  // URL param wins; fall back to the previously-persisted role hint so a
  // user who signed out mid-wizard lands back on the SAME flow they started
  // (engineering / supplier / retailer), not a default-engineering form.
  const urlRole =
    params.role === "supplier" ? "supplier"
    : params.role === "retailer" ? "retailer"
    : params.role === "engineering" ? "engineering"
    : null;
  const role = urlRole ?? profile.pendingSignupRole ?? "engineering";

  // Persist the role on the user profile so it survives a sign-out / sign-in
  // bounce. Only write when it'd change, to keep the page render cheap.
  if (urlRole && profile.pendingSignupRole !== urlRole) {
    try {
      await db
        .update(userProfiles)
        .set({ pendingSignupRole: urlRole, updatedAt: new Date() })
        .where(eq(userProfiles.clerkUserId, profile.clerkUserId));
    } catch (e) {
      // Non-fatal: if the column ALTER hasn't applied yet, just log and
      // proceed. The wizard still renders with the URL-derived role.
      console.warn("[onboarding] failed to persist pendingSignupRole:", e);
    }
  }

  return (
    <OnboardingWizard
      role={role as "engineering" | "supplier" | "retailer"}
      defaultEmail={profile.email ?? ""}
      defaultName={profile.displayName ?? ""}
    />
  );
}
