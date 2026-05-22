import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  erpNotifications,
  suppliers,
  supplierContacts,
  userProfiles,
} from "@/db/schema";
import {
  getOrCreateProfile,
  isCaduniqUser,
  isRetailerUser,
} from "@/lib/permissions";
import OnboardingWizard from "./OnboardingWizard";

// Email domains that are too generic to use as an auto-link signal —
// multiple unrelated tenants can have admins on @gmail.com, so an
// engineering signup with a generic domain still has to fill out the
// wizard (or a CADuniQ admin links them manually). caduniq.com is
// excluded because @caduniq.com is reserved for cross-tenant staff.
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "fastmail.com",
  "me.com",
  "msn.com",
  "caduniq.com",
]);

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

  // Auto-link engineering signups to an existing tenant. The matching
  // is robust to a few realities:
  //   1. Email-domain match against ANY existing user on the tenant
  //      (not only admins — a tenant may not have an @-domain admin yet
  //      but a non-admin team member already attached counts).
  //   2. Fuzzy match the domain root against the client name as a last
  //      resort (e.g. "lightbase.ca" → "Lightbase"), which catches
  //      tenants whose admins haven't signed in yet.
  // We also run this even when profile.clientId is already populated
  // (older backfills used to auto-attach every non-pending user to the
  // default tenant) so a stale attachment doesn't strand the signup
  // on the "Tell us about your company" form.
  //
  // Generic email domains (gmail/outlook/etc.) bypass this entirely.
  if (role === "engineering" && profile.email && !profile.isSupplier) {
    const domain = profile.email.split("@").pop()?.toLowerCase() ?? "";
    if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
      // (1) Domain match against any tenant user.
      let match: { clientId: number; clientName: string } | undefined;
      const userMatches = await db
        .select({ clientId: clients.id, clientName: clients.name })
        .from(userProfiles)
        .innerJoin(clients, eq(clients.id, userProfiles.clientId))
        .where(
          sql`LOWER(SPLIT_PART(${userProfiles.email}, '@', 2)) = ${domain}
              AND LOWER(${userProfiles.email}) <> ${profile.email.toLowerCase()}`,
        )
        .limit(1);
      if (userMatches.length > 0) {
        match = userMatches[0];
      }

      // (2) Fuzzy match: take the part of the domain before the first
      // dot ("lightbase.ca" → "lightbase") and compare it as a prefix
      // of the normalised client name. Catches "Lightbase",
      // "Lightbase Operations", "Lightbase Inc." — anything that
      // starts with the same brand root.
      if (!match) {
        const root = domain
          .split(".")[0]
          .replace(/[^a-z0-9]/g, "");
        if (root.length >= 3) {
          const nameMatches = await db
            .select({ clientId: clients.id, clientName: clients.name })
            .from(clients)
            .where(
              sql`LOWER(REGEXP_REPLACE(${clients.name}, '[^a-zA-Z0-9]', '', 'g')) LIKE ${root + "%"}`,
            )
            .limit(1);
          if (nameMatches.length > 0) match = nameMatches[0];
        }
      }

      if (match) {
        const alreadyOnRightTenant = profile.clientId === match.clientId;
        const needsWrite =
          !alreadyOnRightTenant || profile.pendingSignupRole != null;
        if (needsWrite) {
          await db
            .update(userProfiles)
            .set({
              clientId: match.clientId,
              pendingSignupRole: null,
              // Keep them awaiting approval — admin grants modules.
              role: "pending",
              updatedAt: new Date(),
            })
            .where(eq(userProfiles.clerkUserId, profile.clerkUserId));
        }

        // Notify the tenant's admins so they know somebody's waiting.
        // Best-effort — never block the redirect on a notify failure.
        // We notify on every fresh attachment (not when we're just
        // clearing pendingSignupRole on someone already attached).
        if (!alreadyOnRightTenant) {
          try {
            const team = await db
              .select({ id: userProfiles.clerkUserId })
              .from(userProfiles)
              .where(
                and(
                  eq(userProfiles.clientId, match.clientId),
                  eq(userProfiles.role, "admin"),
                ),
              );
            if (team.length > 0) {
              await db.insert(erpNotifications).values(
                team.map((u) => ({
                  targetClerkId: u.id,
                  kind: "supplier.signed-up" as const,
                  title: `New team member signed up: ${profile.email}`,
                  body: `${profile.displayName ?? profile.email} signed up under your domain (${domain}). Grant module access from the admin panel.`,
                  linkUrl: "/admin",
                })),
              );
            }
          } catch (e) {
            console.warn("[onboarding] notify-admins failed:", e);
          }
        }

        // Send them home — AwaitingAccess will render because they
        // have a clientId but no module flags, no admin role.
        redirect("/");
      }
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
