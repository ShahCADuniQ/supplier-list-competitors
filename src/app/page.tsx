import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  suppliers,
  supplierProjectEntries,
  competitors,
  competitorIdeationItems,
  competitorCollections,
  userProfiles,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
  isCaduniqUser,
  isSupplierUser,
  isRetailerUser,
  ADMIN_EMAILS,
  ADMIN_EMAIL_DOMAINS,
} from "@/lib/permissions";
import { CLIENT_CONFIG, CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";
import CaduniqHQDashboard, {
  type HQClientRow,
  type HQPendingSignup,
  type HQSupplierRow,
  type HQUserRow,
  type HQRetailerRow,
} from "@/app/_caduniq/CaduniqHQDashboard";
import { crmAccounts } from "@/db/schema";

export const dynamic = "force-dynamic";

// Lightbase Operations — front page.
//
// Three render paths:
//   • Signed out: brand hero pointing at sign-in.
//   • Signed in but no permissions yet: awaiting-access card.
//   • Signed in with at least one permission: full operations dashboard
//     (hero band + vivid KPI cards + module launcher + recent activity).
//
// All data queries are gated by the same canView* helpers used elsewhere,
// so a user only sees aggregates from the modules they're allowed into.
export default async function Home() {
  const profile = await getOrCreateProfile();

  if (!profile) return <SignedOutHero />;

  // Mid-signup users who explicitly picked a role on /get-started come
  // first — if the cookie / pendingSignupRole says "engineering" or
  // "retailer" but a stale suppliers row also flagged them as a
  // supplier, the user's explicit choice still wins. Without this
  // pbosco@lightbase.ca (an engineering signup whose email happened to
  // appear in the suppliers table) would get hijacked to /portal.
  const isMidSignup =
    profile.role === "pending" &&
    profile.approvedAt === null &&
    profile.pendingSignupRole != null;
  if (isMidSignup && profile.pendingSignupRole === "engineering") {
    redirect("/onboarding?role=engineering");
  }
  if (isMidSignup && profile.pendingSignupRole === "retailer") {
    redirect("/onboarding?role=retailer");
  }

  // Supplier users skip the buyer dashboard entirely and land on their
  // vendor portal. They're not staff — the home page would just confuse
  // them with internal KPIs.
  if (isSupplierUser(profile)) redirect("/portal");

  // Retailer users (public-signup buyers) get routed to their buyer
  // portal. Without this redirect they'd hit AwaitingAccess because
  // they have no internal-module permissions.
  if (isRetailerUser(profile)) redirect("/retailer");

  // CADuniQ staff (@caduniq.com) get a cross-tenant HQ dashboard
  // instead of the Lightbase-specific home. They can see every client
  // tenant, toggle module access per client, and jump into any
  // individual client's admin panel. The default Lightbase BrandHero
  // would be misleading for them — they're not a Lightbase admin, they
  // operate the whole platform.
  if (isCaduniqUser(profile)) {
    // Pull every cross-tenant slice the HQ dashboard needs in one
    // parallel batch. Every query is wrapped in safeQuery so an
    // unmigrated DB (e.g. a missing column) degrades gracefully to an
    // empty list for that tab rather than 500-ing the whole page.
    const [
      clientRows,
      pendingSignupRows,
      supplierRows,
      userRows,
      retailerProfileRows,
      retailerAccountRows,
    ] = await Promise.all([
      safeQuery(() => db.select().from(clients).orderBy(asc(clients.name))),
      // Designer/engineering signups in flight: picked the role on
      // /get-started, never finished claimEngineeringCompany.
      safeQuery(() =>
        db
          .select({
            clerkUserId: userProfiles.clerkUserId,
            email: userProfiles.email,
            displayName: userProfiles.displayName,
            pendingSignupRole: userProfiles.pendingSignupRole,
            createdAt: userProfiles.createdAt,
          })
          .from(userProfiles)
          .where(
            sql`${userProfiles.role} = 'pending' AND ${userProfiles.pendingSignupRole} = 'engineering' AND ${userProfiles.approvedAt} IS NULL`,
          )
          .orderBy(desc(userProfiles.createdAt))
          .limit(50),
      ),
      // Every supplier across every tenant (the "Suppliers" tab).
      safeQuery(() =>
        db
          .select({
            id: suppliers.id,
            name: suppliers.name,
            email: suppliers.email,
            contactName: suppliers.contactName,
            category: suppliers.category,
            origin: suppliers.origin,
            onboardingStatus: suppliers.onboardingStatus,
            isDistributor: suppliers.isDistributor,
            clientId: suppliers.clientId,
            createdAt: suppliers.createdAt,
          })
          .from(suppliers)
          .orderBy(asc(suppliers.name)),
      ),
      // Every staff user across every tenant (the "Users" tab).
      // Excludes supplier-portal and retailer-portal accounts; those
      // get their own tabs so the breakdown reads cleanly.
      safeQuery(() =>
        db
          .select({
            clerkUserId: userProfiles.clerkUserId,
            email: userProfiles.email,
            displayName: userProfiles.displayName,
            role: userProfiles.role,
            jobRole: userProfiles.jobRole,
            clientId: userProfiles.clientId,
            createdAt: userProfiles.createdAt,
          })
          .from(userProfiles)
          .where(
            sql`${userProfiles.isSupplier} = false AND ${userProfiles.isRetailer} = false`,
          )
          .orderBy(asc(userProfiles.email)),
      ),
      // Retailer user profiles (the "Retailers" tab) — each signed up
      // via /get-started?role=retailer.
      safeQuery(() =>
        db
          .select({
            clerkUserId: userProfiles.clerkUserId,
            email: userProfiles.email,
            displayName: userProfiles.displayName,
            clientId: userProfiles.clientId,
            createdAt: userProfiles.createdAt,
          })
          .from(userProfiles)
          .where(sql`${userProfiles.isRetailer} = true`)
          .orderBy(asc(userProfiles.email)),
      ),
      // crm_accounts owned by a retailer user — gives us the company
      // name / industry / country the retailer typed at signup.
      safeQuery(() =>
        db
          .select({
            id: crmAccounts.id,
            ownerUserId: crmAccounts.ownerUserId,
            name: crmAccounts.name,
            website: crmAccounts.website,
            industry: crmAccounts.industry,
            country: crmAccounts.country,
            tier: crmAccounts.tier,
            updatedAt: crmAccounts.updatedAt,
          })
          .from(crmAccounts),
      ),
    ]);

    // Maps for client name + per-client counts so the dashboard can
    // tag each row with its tenant without an N+1.
    const clientNameById = new Map<number, string>(
      clientRows.map((c) => [c.id, c.name]),
    );
    const userCountByClient = new Map<number, number>();
    for (const u of userRows) {
      if (u.clientId == null) continue;
      userCountByClient.set(u.clientId, (userCountByClient.get(u.clientId) ?? 0) + 1);
    }
    const supplierCountByClient = new Map<number, number>();
    for (const s of supplierRows) {
      if (s.clientId == null) continue;
      supplierCountByClient.set(
        s.clientId,
        (supplierCountByClient.get(s.clientId) ?? 0) + 1,
      );
    }

    // Index crm_accounts by ownerUserId for fast retailer enrichment.
    const accountByOwner = new Map<string, (typeof retailerAccountRows)[number]>();
    for (const a of retailerAccountRows) {
      if (a.ownerUserId) accountByOwner.set(a.ownerUserId, a);
    }

    const hqClients: HQClientRow[] = clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      industry: c.industry,
      isActive: c.isActive,
      userCount: userCountByClient.get(c.id) ?? 0,
      supplierCount: supplierCountByClient.get(c.id) ?? 0,
      canUseSuppliers: c.canUseSuppliers,
      canUseCompetitors: c.canUseCompetitors,
      canUseHandbook: c.canUseHandbook,
      canUseEngineering: c.canUseEngineering,
      canUseDesignEngineering: c.canUseDesignEngineering,
      canUseCrm: c.canUseCrm,
      canUseOee: c.canUseOee,
    }));

    const hqSuppliers: HQSupplierRow[] = supplierRows.map((s) => ({
      id: s.id,
      name: s.name,
      contactName: s.contactName ?? null,
      email: s.email ?? null,
      category: s.category ?? null,
      origin: s.origin ?? null,
      onboardingStatus: s.onboardingStatus,
      isDistributor: Boolean(s.isDistributor),
      clientId: s.clientId ?? null,
      clientName: s.clientId ? (clientNameById.get(s.clientId) ?? null) : null,
      createdAt: s.createdAt,
    }));

    const hqUsers: HQUserRow[] = userRows.map((u) => ({
      clerkUserId: u.clerkUserId,
      email: u.email,
      displayName: u.displayName ?? null,
      role: u.role,
      jobRole: u.jobRole ?? null,
      clientId: u.clientId ?? null,
      clientName: u.clientId ? (clientNameById.get(u.clientId) ?? null) : null,
      createdAt: u.createdAt,
    }));

    const hqRetailers: HQRetailerRow[] = retailerProfileRows.map((r) => {
      const acc = accountByOwner.get(r.clerkUserId);
      return {
        clerkUserId: r.clerkUserId,
        email: r.email,
        displayName: r.displayName ?? null,
        companyName: acc?.name ?? r.displayName ?? r.email,
        website: acc?.website ?? null,
        industry: acc?.industry ?? null,
        country: acc?.country ?? null,
        tier: acc?.tier ?? null,
        clientId: r.clientId ?? null,
        clientName: r.clientId ? (clientNameById.get(r.clientId) ?? null) : null,
        createdAt: r.createdAt,
      };
    });

    const hqPending: HQPendingSignup[] = pendingSignupRows.map((r) => ({
      clerkUserId: r.clerkUserId,
      email: r.email,
      displayName: r.displayName,
      pendingSignupRole: r.pendingSignupRole,
      createdAt: r.createdAt,
    }));

    return (
      <CaduniqHQDashboard
        displayName={profile.displayName ?? profile.email}
        clients={hqClients}
        suppliersAcrossTenants={hqSuppliers}
        usersAcrossTenants={hqUsers}
        retailersAcrossTenants={hqRetailers}
        pendingSignups={hqPending}
      />
    );
  }

  // Effective access AND's the per-user gate with the tenant-level
  // canUse* gate set by CADuniQ HQ. New tenants land with every
  // canUse* = false, so even a fresh admin sees AwaitingAccess until
  // CADuniQ enables at least one module — this is what makes the
  // "no auto-access on signup" policy actually work.
  const [tenantRow] =
    profile.clientId != null
      ? await db
          .select({
            canUseSuppliers: clients.canUseSuppliers,
            canUseCompetitors: clients.canUseCompetitors,
            canUseHandbook: clients.canUseHandbook,
            canUseEngineering: clients.canUseEngineering,
            canUseDesignEngineering: clients.canUseDesignEngineering,
            canUseCrm: clients.canUseCrm,
            canUseOee: clients.canUseOee,
          })
          .from(clients)
          .where(eq(clients.id, profile.clientId))
          .limit(1)
      : [undefined];
  const tenantHasAnyModule =
    !tenantRow ||
    tenantRow.canUseSuppliers ||
    tenantRow.canUseCompetitors ||
    tenantRow.canUseHandbook ||
    tenantRow.canUseEngineering ||
    tenantRow.canUseDesignEngineering ||
    tenantRow.canUseCrm ||
    tenantRow.canUseOee;

  const sup = canViewSuppliers(profile) && (!tenantRow || tenantRow.canUseSuppliers);
  const comp = canViewCompetitors(profile) && (!tenantRow || tenantRow.canUseCompetitors);
  const handbook = canViewHandbook(profile) && (!tenantRow || tenantRow.canUseHandbook);
  const engineering = canViewEngineering(profile) && (!tenantRow || tenantRow.canUseEngineering);
  // Admins still see the /admin panel (the tenant page is how they
  // manage users while waiting for module access), but they don't
  // count as "has access" for the dashboard unless at least one
  // module is enabled for their tenant.
  const admin = isAdmin(profile) && tenantHasAnyModule;

  // Mid-signup detection. A user who hasn't completed any claim flow
  // (engineering / supplier / retailer) and has never been approved is
  // by definition still onboarding — they should never see the
  // "Awaiting access" screen, which is reserved for accounts a human
  // admin needs to act on. We treat profile.clientId as inert here
  // because ensureUserProfileColumns auto-backfills it onto every
  // non-CADuniQ user; the only honest signal of a finished claim is
  // an actual role/flag mutation done by the claim* server actions.
  const hasFinishedAnyClaim = admin || sup || comp || handbook || engineering;
  const wasEverApproved = profile.approvedAt !== null;
  // A user who has been ATTACHED to a tenant (clientId set) AND has no
  // pendingSignupRole is past the wizard — they're waiting for the
  // tenant admin to grant module access. The auto-link path in
  // /onboarding/page.tsx (engineering signup whose email domain
  // matched an existing tenant) lands users in exactly this state, as
  // does an admin manually attaching someone via Set client. Show
  // AwaitingAccess instead of bouncing them back to /get-started.
  const isAttachedAwaitingApproval =
    profile.clientId != null &&
    !hasFinishedAnyClaim &&
    profile.pendingSignupRole == null;
  if (
    !hasFinishedAnyClaim &&
    !isAttachedAwaitingApproval &&
    profile.role === "pending" &&
    !wasEverApproved
  ) {
    if (profile.pendingSignupRole) {
      // We know which wizard they started — drop them back into it.
      redirect(`/onboarding?role=${profile.pendingSignupRole}`);
    }
    // No role hint (legacy account, or they bailed before /onboarding
    // had a chance to record it). Route to /get-started so they pick
    // a role and resume. AwaitingAccess is NOT the right surface here:
    // there's no admin task pending, only an unfinished signup.
    redirect("/get-started");
  }

  const hasAnyAccess = sup || comp || handbook || engineering || admin;
  if (!hasAnyAccess) return <AwaitingAccess />;

  // Fetch only what the user is allowed to see; everything in parallel.
  // Each query is wrapped in safeQuery so that an unmigrated DB (missing
  // column / missing table) degrades the dashboard gracefully instead of
  // crashing the whole page. Common with the new is_global column on
  // competitor_ideation_items added in migration 0007.
  const [supRows, peRows, compRows, ideationRows, collectionRows] =
    await Promise.all([
      sup ? safeQuery(() => db.select().from(suppliers)) : Promise.resolve([]),
      sup
        ? safeQuery(() => db.select().from(supplierProjectEntries))
        : Promise.resolve([]),
      comp ? safeQuery(() => db.select().from(competitors)) : Promise.resolve([]),
      comp
        ? (async () => {
            // Same pre-V10 fallback as the competitors page: if the
            // is_global column is missing the full SELECT fails, so retry
            // with only the original columns.
            try {
              return await db
                .select()
                .from(competitorIdeationItems)
                .orderBy(desc(competitorIdeationItems.id))
                .limit(8);
            } catch {
              return safeQuery(() =>
                db
                  .select({
                    id: competitorIdeationItems.id,
                    title: competitorIdeationItems.title,
                  })
                  .from(competitorIdeationItems)
                  .orderBy(desc(competitorIdeationItems.id))
                  .limit(8),
              );
            }
          })()
        : Promise.resolve([]),
      comp
        ? safeQuery(() => db.select().from(competitorCollections).limit(50))
        : Promise.resolve([]),
    ]);

  // ── KPI rollups ────────────────────────────────────────────────────────
  const totalSuppliers = supRows.length;
  const activeSuppliers = supRows.filter((s) => s.status === "Active").length;
  const distinctOrigins = new Set(
    supRows.map((s) => s.origin).filter(Boolean),
  ).size;
  const inFlight = peRows.filter((p) =>
    ["PO Issued", "In Production", "Shipped"].includes(p.status),
  ).length;
  const closedThisYear = peRows.filter((p) => {
    if (!p.actualDelivery) return false;
    const yr = new Date(p.actualDelivery).getFullYear();
    return yr === new Date().getFullYear();
  }).length;
  const totalCompetitors = compRows.length;
  const totalCollections = collectionRows.length;
  const totalIdeas = ideationRows.length;
  const recentSuppliers = [...supRows]
    .sort(
      (a, b) =>
        new Date(b.createdAt as unknown as string).getTime() -
        new Date(a.createdAt as unknown as string).getTime(),
    )
    .slice(0, 5);

  return (
    <div
      className="min-h-full"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <div className="px-6 pt-6 pb-10" style={{ maxWidth: 1400, margin: "0 auto" }}>
        <BrandHero displayName={profile.displayName ?? profile.email} />

        <section
          className="mt-6 grid gap-5"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
          aria-label="Operations summary"
        >
          {sup && (
            <KpiCard
              variant="orange"
              label="Suppliers"
              value={totalSuppliers}
              sub={`${activeSuppliers} active · ${distinctOrigins} origins`}
              href="/suppliers"
              decoration={<MiniLineChart values={[6, 8, 7, 12, 9, 14, 11, 16]} />}
            />
          )}
          {sup && (
            <KpiCard
              variant="blue"
              label="In-flight Projects"
              value={inFlight}
              sub={`${closedThisYear} delivered in ${new Date().getFullYear()}`}
              href="/suppliers"
              decoration={<MiniGauge percent={inFlight === 0 ? 0 : 62} />}
            />
          )}
          {comp && (
            <KpiCard
              variant="violet"
              label="Competitor Brands"
              value={totalCompetitors}
              sub={`${totalCollections} collection${totalCollections === 1 ? "" : "s"} tracked`}
              href="/competitors"
              decoration={<MiniBars values={[4, 7, 5, 9, 6, 8, 10, 7]} />}
            />
          )}
          {comp && (
            <KpiCard
              variant="teal"
              label="Ideation Pipeline"
              value={totalIdeas}
              sub="Latest pinned ideas"
              href="/competitors"
              decoration={<MiniDots count={Math.min(8, totalIdeas)} />}
            />
          )}
        </section>

        <section className="mt-10 grid gap-5" style={{ gridTemplateColumns: "2fr 1fr" }}>
          <ModuleLauncher
            sup={sup}
            comp={comp}
            handbook={handbook}
            engineering={engineering}
            admin={admin}
          />
          <RecentActivity
            sup={sup}
            recentSuppliers={recentSuppliers}
            comp={comp}
            recentIdeas={ideationRows}
          />
        </section>

        <CompanyFootnote />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed-out hero
// ─────────────────────────────────────────────────────────────────────────────

function SignedOutHero() {
  // CADuniQ public landing page. Three audiences land here:
  //   1. Engineering companies (clients) — they sign up to manage their
  //      designs, suppliers, and projects on the CADuniQ platform.
  //   2. Suppliers — they sign up to be discovered by + work with one or
  //      more engineering companies.
  //   3. CADuniQ staff — they sign in directly via /sign-in.
  // The Sign up button always routes through /get-started (the role
  // chooser) — Clerk only renders AFTER a role is picked. Sign in goes
  // straight to Clerk for returning users.
  return (
    <main style={{ background: "var(--lb-bg)", color: "var(--lb-text)", minHeight: "100vh" }}>
      {/* ════════ TOP NAV — logo left, Sign in / Sign up right ════════ */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(255,255,255,0.85)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--lb-border)",
        padding: "12px clamp(16px, 4vw, 28px)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8,
      }}>
        <Link href="/" style={{
          display: "flex", alignItems: "center", gap: 10,
          textDecoration: "none", color: "var(--lb-text)",
          minWidth: 0,
        }}>
          <span aria-hidden style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 38, height: 38, borderRadius: 11,
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
            color: "#fff", fontWeight: 900, fontSize: 19, letterSpacing: "-0.04em",
            boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
            flexShrink: 0,
          }}>C</span>
          <span style={{ fontWeight: 800, fontSize: 19, letterSpacing: "-0.015em" }}>
            CADuniQ{" "}
            {/* "Manufacturing" subtitle hides on very small screens to */}
            {/* keep the nav from wrapping or pushing CTAs off-screen. */}
            <span
              className="hidden sm:inline"
              style={{ fontWeight: 500, color: "var(--lb-text-2)" }}
            >
              Manufacturing
            </span>
          </span>
        </Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {/* Anchor nav links hide on phones — they're nice-to-have on */}
          {/* desktop but eat the limited horizontal budget on mobile. */}
          <Link
            href="#how-it-works"
            className="hidden md:inline-flex"
            style={{
              padding: "8px 12px", fontSize: 13.5, fontWeight: 600,
              color: "var(--lb-text-2)", textDecoration: "none",
            }}
          >
            How it works
          </Link>
          <Link
            href="#audiences"
            className="hidden md:inline-flex"
            style={{
              padding: "8px 12px", fontSize: 13.5, fontWeight: 600,
              color: "var(--lb-text-2)", textDecoration: "none",
            }}
          >
            For you
          </Link>
          <Link href="/sign-in" style={{
            padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
            borderRadius: 999, color: "var(--lb-text)",
            border: "1px solid var(--lb-border)", background: "var(--lb-bg-elev)",
            textDecoration: "none", whiteSpace: "nowrap",
          }}>Sign in</Link>
          <Link href="/get-started" style={{
            padding: "8px 18px", fontSize: 13.5, fontWeight: 700,
            borderRadius: 999, color: "#fff",
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
            border: "1px solid #2563eb",
            textDecoration: "none",
            boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
            whiteSpace: "nowrap",
          }}>Sign up →</Link>
        </div>
      </nav>

      {/* ════════ HERO with embedded CAD-to-Cash visual flow ════════ */}
      <section style={{
        padding: "clamp(48px, 8vw, 96px) 28px clamp(32px, 5vw, 64px)",
        background: `
          linear-gradient(
            170deg,
            color-mix(in srgb, var(--lb-accent) 6%, transparent) 0%,
            transparent 40%,
            color-mix(in srgb, var(--lb-vivid-orange) 5%, transparent) 100%
          ),
          var(--lb-bg)
        `,
        color: "var(--lb-text)",
        position: "relative", overflow: "hidden",
      }}>
        <div aria-hidden style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(1200px 400px at 50% -10%, rgba(37,99,235,0.12), transparent 60%), radial-gradient(800px 400px at 80% 100%, rgba(124,58,237,0.08), transparent 60%), radial-gradient(700px 300px at 10% 60%, rgba(234,88,12,0.06), transparent 60%)",
          pointerEvents: "none",
        }} />
        <div style={{ position: "relative", maxWidth: 1240, margin: "0 auto", textAlign: "center" }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            padding: "8px 18px 8px 10px", borderRadius: 999,
            background: "rgba(37,99,235,0.10)", color: "#2563eb",
            fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
            border: "1px solid rgba(37,99,235,0.20)",
          }}>
            <span aria-hidden style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 7,
              background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
              color: "#fff", fontWeight: 800, fontSize: 12.5,
            }}>C</span>
            <span style={{ color: "var(--lb-text)", fontWeight: 800, letterSpacing: "-0.01em", textTransform: "none" }}>
              {CADUNIQ_PRODUCT_LABEL}
            </span>
            <span aria-hidden style={{ width: 1, height: 16, background: "rgba(37,99,235,0.30)" }} />
            THE POST-DESIGN MANUFACTURING PLATFORM
          </span>
          <h1 style={{
            margin: "20px auto 18px",
            maxWidth: 1000,
            fontSize: "clamp(40px, 6.5vw, 84px)", lineHeight: 1.02,
            letterSpacing: "-0.035em", fontWeight: 900,
            background: "linear-gradient(110deg, #1a1f36 0%, #2563eb 38%, #7c3aed 70%, #ea580c 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}>
            From CAD upload<br />to finished product. One platform.
          </h1>
          <p style={{
            maxWidth: 740, margin: "0 auto",
            fontSize: "clamp(15px, 1.6vw, 19px)", lineHeight: 1.6,
            color: "var(--lb-text-2)", letterSpacing: "-0.005em",
          }}>
            CADuniQ turns a 3D model into manufactured, inspected, kitted, and shipped product
            without you stitching together twelve different vendors. Engineering companies run
            every project here. Suppliers receive work without cold leads. Buyers see one
            polished result. All sides stay anonymous to each other.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 32, flexWrap: "wrap" }}>
            <Link href="/get-started" style={{
              padding: "14px 28px", fontSize: 15, fontWeight: 700,
              borderRadius: 999, color: "#fff",
              background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
              border: "none", textDecoration: "none",
              boxShadow: "0 6px 20px rgba(37,99,235,0.30)",
            }}>
              Get started for free
            </Link>
            <Link href="/sign-in" style={{
              padding: "14px 26px", fontSize: 15, fontWeight: 600,
              borderRadius: 999, color: "var(--lb-text)",
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              textDecoration: "none",
            }}>
              I already have an account
            </Link>
          </div>
          <div style={{ marginTop: 24, display: "flex", gap: 24, justifyContent: "center", flexWrap: "wrap", fontSize: 13, color: "var(--lb-text-3)" }}>
            <span>✓ Anonymous between parties</span>
            <span>✓ Free to start</span>
            <span>✓ No credit card required</span>
          </div>

          {/* Visual flow diagram — the 5-step CAD-to-Cash pipeline */}
          <FlowDiagram />
        </div>
      </section>

      {/* ════════ STATS BAND — what the platform replaces ════════ */}
      <section style={{
        padding: "clamp(36px, 5vw, 64px) 28px",
        background: "var(--lb-bg)",
        borderTop: "1px solid var(--lb-border)",
        borderBottom: "1px solid var(--lb-border)",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{
            display: "grid", gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            textAlign: "center",
          }}>
            {[
              { num: "12-18", lbl: "Vendors replaced per customer", color: "#2563eb" },
              { num: "90s", lbl: "CAD upload → manufacturable package", color: "#7c3aed" },
              { num: "48h", lbl: "Supplier payout after QC pass", color: "#16a34a" },
              { num: "100%", lbl: "Anonymity between parties", color: "#ea580c" },
            ].map((s) => (
              <div key={s.lbl} style={{
                padding: "20px 18px", borderRadius: 14,
                background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)",
              }}>
                <div style={{
                  fontSize: "clamp(34px, 4vw, 44px)", fontWeight: 900, lineHeight: 1,
                  letterSpacing: "-0.025em",
                  background: `linear-gradient(135deg, ${s.color}, #7c3aed)`,
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}>{s.num}</div>
                <div style={{
                  fontSize: 11.5, fontWeight: 700, color: "var(--lb-text-3)",
                  textTransform: "uppercase", letterSpacing: "0.10em", marginTop: 10,
                }}>{s.lbl}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════ HOW IT WORKS — 4 numbered steps ════════ */}
      <section id="how-it-works" style={{ padding: "clamp(64px, 8vw, 96px) 28px", maxWidth: 1200, margin: "0 auto", scrollMarginTop: 80 }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: "#7c3aed", textTransform: "uppercase" }}>
            How it works
          </span>
          <h2 style={{ margin: "10px 0 8px", fontSize: "clamp(28px, 3.5vw, 42px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
            One model in. A finished product out.
          </h2>
          <p style={{ margin: 0, fontSize: 15.5, color: "var(--lb-text-2)", maxWidth: 640, marginInline: "auto", lineHeight: 1.6 }}>
            Engineers finish the design. We handle everything after: drawings,
            sourcing, manufacturing, inspection, kitting, and shipping. Anywhere in the world.
          </p>
        </div>

        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {[
            { n: "01", icon: "📐", title: "Upload your 3D model", body: "STEP, IGES, SLDPRT, IPT, Fusion, NX, Creo. Every common format. The AI extracts the BOM and generates production-ready 2D drawings automatically.", color: "#2563eb" },
            { n: "02", icon: "🤖", title: "AI runs DFM + validation", body: "Manufacturability analysis, cost estimates, FEA / CFD validation, and an annotated suggestion list. All before a single supplier sees the part.", color: "#7c3aed" },
            { n: "03", icon: "🤝", title: "We match to the right supplier", body: "Best-fit by capability, capacity, region, lead time, and certifications. Suppliers see no buyer names. Buyers see no supplier names. Anonymity by design.", color: "#db2777" },
            { n: "04", icon: "🏭", title: "Manufacturing + QC + ship", body: "Production tracked in real-time. Parts converge at our hub for inspection, kitting, compliance docs, and one branded shipment to you or your customers.", color: "#16a34a" },
          ].map((step) => (
            <article key={step.n} style={{
              padding: 24, borderRadius: 14,
              background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{
                  width: 40, height: 40, borderRadius: 10, display: "grid", placeItems: "center",
                  background: `${step.color}15`, color: step.color,
                  fontSize: 22, border: `1px solid ${step.color}30`,
                }}>{step.icon}</span>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, fontWeight: 700, color: step.color, letterSpacing: 0.5 }}>
                  {step.n}
                </span>
              </div>
              <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em" }}>
                {step.title}
              </h3>
              <p style={{ margin: 0, fontSize: 13.5, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
                {step.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* ════════ STACK WE REPLACE — visual comparison ════════ */}
      <section style={{
        padding: "clamp(56px, 7vw, 88px) 28px",
        background: `
          linear-gradient(
            170deg,
            color-mix(in srgb, var(--lb-vivid-orange) 6%, transparent) 0%,
            transparent 60%,
            color-mix(in srgb, var(--lb-accent) 5%, transparent) 100%
          ),
          var(--lb-bg-sunken)
        `,
        color: "var(--lb-text)",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: "#ea580c", textTransform: "uppercase" }}>
              The stack we replace
            </span>
            <h2 style={{ margin: "10px 0 8px", fontSize: "clamp(28px, 3.5vw, 42px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
              12-18 tools. One platform.
            </h2>
            <p style={{ margin: 0, fontSize: 15.5, color: "var(--lb-text-2)", maxWidth: 680, marginInline: "auto", lineHeight: 1.6 }}>
              A typical mid-market hardware company juggles a dozen-plus vendors at $200-650k/year, plus
              two full-time people just keeping them synced. We rebuild the whole flow on one event bus.
            </p>
          </div>

          <div style={{
            display: "grid", gap: 18,
            gridTemplateColumns: "1fr 1fr",
            alignItems: "stretch",
          }}>
            {/* OLD STACK */}
            <div style={{
              padding: 28, borderRadius: 16,
              background: "var(--lb-bg-elev)", border: "2px solid rgba(220,38,38,0.18)",
            }}>
              <div style={{
                fontSize: 11, fontWeight: 800, color: "#dc2626", letterSpacing: "0.14em",
                marginBottom: 16, textTransform: "uppercase",
              }}>
                ✕ The old stack · $200-650k / year + 2 FTEs
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  "SolidWorks", "PDM Pro", "HSMWorks", "DraftAid", "KeyShot",
                  "NetSuite / Odoo", "QuickBooks", "Salesforce", "HubSpot",
                  "Xometry / Protolabs", "ShipStation", "DocuSign", "Avalara",
                  "Slack", "Dropbox", "manual spreadsheets",
                ].map((tool) => (
                  <span key={tool} style={{
                    padding: "6px 12px", borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                    background: "rgba(220,38,38,0.06)", color: "#7a1818",
                    border: "1px solid rgba(220,38,38,0.20)",
                    textDecoration: "line-through", textDecorationColor: "rgba(220,38,38,0.55)",
                    textDecorationThickness: 1.5,
                  }}>{tool}</span>
                ))}
              </div>
              <div style={{
                marginTop: 18, fontSize: 12.5, color: "var(--lb-text-3)",
                paddingTop: 14, borderTop: "1px dashed var(--lb-border)",
              }}>
                Plus 0.5-2 FTEs full-time just keeping the stack in sync. Two sources of
                truth, never reconciled.
              </div>
            </div>

            {/* CADUNIQ */}
            <div style={{
              padding: 28, borderRadius: 16,
              background: "linear-gradient(155deg, rgba(37,99,235,0.04), rgba(124,58,237,0.04))",
              border: "2px solid rgba(37,99,235,0.30)",
              position: "relative", overflow: "hidden",
            }}>
              <div aria-hidden style={{
                position: "absolute", top: -40, right: -40,
                width: 180, height: 180, borderRadius: "50%",
                background: "radial-gradient(circle, rgba(37,99,235,0.18), transparent 70%)",
                pointerEvents: "none",
              }} />
              <div style={{
                fontSize: 11, fontWeight: 800, color: "#2563eb", letterSpacing: "0.14em",
                marginBottom: 16, textTransform: "uppercase", position: "relative",
              }}>
                ✓ CADuniQ · one platform
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, position: "relative", display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { i: "📐", l: "CAD + drawings + BOM + manuals", c: "#2563eb" },
                  { i: "🤝", l: "Anonymized supplier network + escrow", c: "#7c3aed" },
                  { i: "📦", l: "Hub QC + kitting + white-label ship", c: "#16a34a" },
                  { i: "📊", l: "ERP, finance, inventory, MRP, CRM", c: "#ea580c" },
                  { i: "⚡", l: "Typed event bus · zero double-entry", c: "#db2777" },
                ].map((row) => (
                  <li key={row.l} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14.5, color: "var(--lb-text)" }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center",
                      background: `${row.c}15`, fontSize: 16,
                      border: `1px solid ${row.c}30`,
                    }}>{row.i}</span>
                    <span style={{ fontWeight: 600 }}>{row.l}</span>
                  </li>
                ))}
              </ul>
              <div style={{
                marginTop: 18, fontSize: 12.5, color: "var(--lb-text-3)",
                paddingTop: 14, borderTop: "1px dashed var(--lb-border)",
                position: "relative",
              }}>
                Zero FTEs spent on data sync. Zero double-entry. The audit log is the
                system of record.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ════════ THREE AUDIENCES — role chooser inline ════════ */}
      <section id="audiences" style={{
        padding: "clamp(64px, 8vw, 96px) 28px",
        background: `
          linear-gradient(
            155deg,
            color-mix(in srgb, var(--lb-vivid-violet) 6%, transparent) 0%,
            transparent 50%,
            color-mix(in srgb, var(--lb-accent) 5%, transparent) 100%
          ),
          var(--lb-bg)
        `,
        color: "var(--lb-text)",
        scrollMarginTop: 80,
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: "#db2777", textTransform: "uppercase" }}>
              Pick your side
            </span>
            <h2 style={{ margin: "10px 0 8px", fontSize: "clamp(28px, 3.5vw, 42px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
              Three roles. One platform. Anonymous between them.
            </h2>
            <p style={{ margin: 0, fontSize: 15.5, color: "var(--lb-text-2)", maxWidth: 680, marginInline: "auto", lineHeight: 1.6 }}>
              The same platform, three completely separate experiences. Sign up takes about
              three minutes, and your first project is on us.
            </p>
          </div>

          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            {[
              {
                tag: "DESIGNER / ENGINEERING COMPANY",
                color: "#2563eb",
                icon: "📊",
                title: "I design products",
                sub: "Run every project end-to-end",
                bullets: [
                  "Upload CAD; BOM, drawings, and assembly manual generate themselves",
                  "Approve a supplier in one click. We handle quote, escrow, and delivery.",
                  "Inventory, RFQs, POs, finance, CRM all driven by the design itself",
                  "Suppliers can't see other suppliers. Buyers can't see costs.",
                ],
                cta: "Sign up as designer/engineering company",
                href: "/api/signup-role/engineering",
              },
              {
                tag: "SUPPLIER",
                color: "#16a34a",
                icon: "🏭",
                title: "I make parts",
                sub: "Get work without marketing",
                bullets: [
                  "Receive RFQs that match your real capacity + certs",
                  "Build a private catalog: datasheets, IES, drawings, photos",
                  "Quote, ship, get paid via escrow within 48h of QC pass",
                  "Buyer identity stays anonymous until you both agree",
                ],
                cta: "Sign up as supplier",
                href: "/api/signup-role/supplier",
              },
              {
                tag: "RETAILER / BUYER",
                color: "#ea580c",
                icon: "🏬",
                title: "I buy finished products",
                sub: "Get parts, skip the chaos",
                bullets: [
                  "One contract, one contact, one shipment, even from 12 shops",
                  "Real-time dashboard tracks every part from CAM to your dock",
                  "Compliance docs (CoC, FAIR, RoHS / REACH) auto-generated",
                  "Optional white-label fulfillment direct to your end customers",
                ],
                cta: "Sign up as retailer",
                href: "/api/signup-role/retailer",
              },
            ].map((aud) => (
              <article key={aud.tag} style={{
                padding: "clamp(20px, 4vw, 28px)", borderRadius: 16,
                background: "var(--lb-bg-elev)", border: `2px solid ${aud.color}25`,
                display: "flex", flexDirection: "column",
                transition: "transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                  <span style={{
                    width: 48, height: 48, borderRadius: 12, display: "grid", placeItems: "center",
                    background: `${aud.color}12`, fontSize: 26, border: `1px solid ${aud.color}25`,
                  }}>{aud.icon}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: aud.color, letterSpacing: "0.14em" }}>
                    {aud.tag}
                  </span>
                </div>
                <h3 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.018em", color: "var(--lb-text)" }}>
                  {aud.title}
                </h3>
                <div style={{ fontSize: 13.5, color: aud.color, fontWeight: 700, marginBottom: 14 }}>
                  {aud.sub}
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: "0 0 22px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                  {aud.bullets.map((b, i) => (
                    <li key={i} style={{ fontSize: 13.5, color: "var(--lb-text-2)", lineHeight: 1.5, display: "flex", gap: 8 }}>
                      <span style={{ color: aud.color, fontWeight: 800, flexShrink: 0 }}>✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <Link href={aud.href} style={{
                  padding: "12px 18px", fontSize: 14, fontWeight: 700,
                  borderRadius: 999, color: "#fff",
                  background: `linear-gradient(135deg, ${aud.color}, ${aud.color}dd)`,
                  border: "none",
                  textDecoration: "none", textAlign: "center",
                  boxShadow: `0 4px 14px ${aud.color}33`,
                }}>
                  {aud.cta} →
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ════════ WHY ANONYMOUS — dark band ════════ */}
      <section style={{ padding: "clamp(64px, 8vw, 96px) 28px", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{
          padding: "clamp(36px, 5vw, 56px)", borderRadius: 18,
          background: "linear-gradient(135deg, #1a1f36 0%, #2d1b69 100%)",
          color: "#fff", textAlign: "center",
          position: "relative", overflow: "hidden",
        }}>
          <div aria-hidden style={{
            position: "absolute", inset: 0,
            background: "radial-gradient(600px 200px at 50% -20%, rgba(124,58,237,0.40), transparent 70%)",
            pointerEvents: "none",
          }} />
          <div style={{ position: "relative" }}>
            <span style={{
              display: "inline-block", padding: "6px 14px", borderRadius: 999,
              background: "rgba(255,255,255,0.10)", color: "#c4b5fd",
              fontSize: 11.5, fontWeight: 800, letterSpacing: "0.12em",
            }}>
              BUILT-IN ANONYMITY
            </span>
            <h2 style={{ margin: "18px 0 14px", fontSize: "clamp(26px, 3.2vw, 38px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
              Nobody sees what isn&apos;t theirs.
            </h2>
            <p style={{ margin: "0 auto", maxWidth: 720, fontSize: 15.5, lineHeight: 1.6, color: "#cbd5e1" }}>
              Buyers never learn supplier names. Suppliers never learn buyer identity. Files
              are scrubbed of company logos and project codes before being routed. Even
              shipping labels are issued by our hub, not by the supplier. The relationship
              you&apos;ve built and the costs you&apos;ve negotiated stay yours.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 18, marginTop: 36, maxWidth: 820, marginInline: "auto" }}>
              {[
                { label: "Supplier names hidden", val: "100%" },
                { label: "Buyer identity scrubbed", val: "100%" },
                { label: "Hub-as-shipper", val: "Always" },
                { label: "Cost data exposed", val: "0%" },
              ].map((s) => (
                <div key={s.label} style={{ padding: 14 }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#fff" }}>{s.val}</div>
                  <div style={{ fontSize: 11.5, color: "#a5b4fc", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 700, marginTop: 4 }}>
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ════════ FINAL CTA ════════ */}
      <section style={{ padding: "clamp(48px, 6vw, 80px) 28px", textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: "clamp(26px, 3.2vw, 38px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          Ready to skip the back-office?
        </h2>
        <p style={{ margin: "12px auto 28px", maxWidth: 580, fontSize: 15, color: "var(--lb-text-2)", lineHeight: 1.6 }}>
          Free to start. Designer/engineering company, supplier, or retailer. Sign up
          takes about three minutes. Your first project is on us.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link href="/get-started" style={{
            padding: "13px 28px", fontSize: 15, fontWeight: 700,
            borderRadius: 999, color: "#fff",
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
            border: "none", textDecoration: "none",
            boxShadow: "0 4px 14px rgba(37,99,235,0.25)",
          }}>
            Create my account →
          </Link>
          <Link href="/sign-in" style={{
            padding: "13px 24px", fontSize: 15, fontWeight: 600,
            borderRadius: 999, color: "var(--lb-text)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            textDecoration: "none",
          }}>
            Sign in
          </Link>
        </div>
      </section>

      {/* ════════ FOOTER ════════ */}
      <footer style={{
        padding: "32px 28px", textAlign: "center",
        borderTop: "1px solid var(--lb-border)", color: "var(--lb-text-3)",
        fontSize: 12.5,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
          <span aria-hidden style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 6,
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
            color: "#fff", fontWeight: 800, fontSize: 12,
          }}>C</span>
          <strong style={{ color: "var(--lb-text-2)" }}>{CADUNIQ_PRODUCT_LABEL}</strong>
          <span>· Made in Montréal</span>
        </div>
        <div>© {new Date().getFullYear()} · The post-design manufacturing platform</div>
      </footer>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowDiagram — pure-SVG visual showing the CAD → Cash pipeline.
// Renders server-side, no client JS. Five nodes connected by the typed
// event bus rail at the bottom (matches the architectural moat).
// ─────────────────────────────────────────────────────────────────────────────

function FlowDiagram() {
  const steps = [
    { x: 100,  icon: "📐", label: "CAD upload",      sub: "STEP · IPT · SLDPRT",       color: "#2563eb" },
    { x: 295,  icon: "🤖", label: "AI drawings",     sub: "BOM · DFM · manuals",       color: "#7c3aed" },
    { x: 490,  icon: "🤝", label: "Supplier match",  sub: "anonymous · escrow",        color: "#db2777" },
    { x: 685,  icon: "🏭", label: "Hub QC + kit",    sub: "compliance docs · branded", color: "#16a34a" },
    { x: 880,  icon: "📦", label: "Shipped",         sub: "AR + AP + GL auto-update",  color: "#ea580c" },
  ];
  return (
    <div style={{
      marginTop: 56, marginInline: "auto", maxWidth: 1040,
      padding: 28, borderRadius: 20,
      background: "rgba(255,255,255,0.72)",
      border: "1px solid var(--lb-border)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 10px 36px rgba(15,23,42,0.06)",
      overflow: "auto",
    }}>
      <svg
        viewBox="0 0 980 240"
        role="img"
        aria-label="From CAD upload through AI drawings, supplier matching, hub QC, and shipment. Every step publishes events to the typed event bus."
        style={{ width: "100%", height: "auto", display: "block", minWidth: 720 }}
      >
        <defs>
          <linearGradient id="bus-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#2563eb" />
            <stop offset="25%" stopColor="#7c3aed" />
            <stop offset="50%" stopColor="#db2777" />
            <stop offset="75%" stopColor="#16a34a" />
            <stop offset="100%" stopColor="#ea580c" />
          </linearGradient>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
          </marker>
          <filter id="node-shadow" x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.07" />
          </filter>
        </defs>

        {/* Connecting arrows between nodes */}
        {steps.slice(0, -1).map((s, i) => (
          <path
            key={i}
            d={`M ${s.x + 38} 60 L ${steps[i + 1].x - 38} 60`}
            stroke="#94a3b8"
            strokeWidth="1.5"
            strokeDasharray="4,3"
            markerEnd="url(#flow-arrow)"
            fill="none"
          />
        ))}

        {/* Pipeline nodes */}
        {steps.map((s) => (
          <g key={s.label} filter="url(#node-shadow)">
            <circle cx={s.x} cy={60} r={30} fill="#fff" stroke={s.color} strokeWidth={2.2} />
            <text x={s.x} y={68} textAnchor="middle" fontSize={24}>{s.icon}</text>
            <text x={s.x} y={114} textAnchor="middle" fontSize={13} fontWeight={800} fill={s.color}>
              {s.label}
            </text>
            <text x={s.x} y={132} textAnchor="middle" fontSize={10.5} fill="#64748b">
              {s.sub}
            </text>
            {/* Connector down to the event bus */}
            <line x1={s.x} y1={90} x2={s.x} y2={172} stroke={s.color} strokeWidth="1.5" strokeDasharray="2,3" opacity={0.5} />
          </g>
        ))}

        {/* Typed event bus rail. Tall enough (56) for two centered lines of text. */}
        <rect x={30} y={172} width={920} height={56} rx={14} fill="url(#bus-grad)" opacity={0.95} />
        <text x={490} y={194} textAnchor="middle" fontSize={13} fontWeight={800} fill="#fff" letterSpacing={1.2}>
          ⚡  TYPED EVENT BUS
        </text>
        <text x={490} y={214} textAnchor="middle" fontSize={10.5} fill="#fff" opacity={0.95} letterSpacing={0.3}>
          cad.uploaded  ·  bom.line.added  ·  design.approved  ·  order.shipped  ·  hub.qc.pass
        </text>
      </svg>
      <div style={{
        marginTop: 14, fontSize: 12.5, color: "var(--lb-text-3)",
        textAlign: "center", lineHeight: 1.55,
      }}>
        Every step publishes typed events. ERP, CRM, inventory, and finance subscribe automatically. No manual sync.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Awaiting access
// ─────────────────────────────────────────────────────────────────────────────

function AwaitingAccess() {
  return (
    <section
      className="flex flex-1 items-center justify-center px-6 py-24 min-h-screen"
      style={{ background: "var(--lb-bg)" }}
    >
      <div
        className="lb-card max-w-xl w-full text-center px-10 py-12"
        style={{ boxShadow: "var(--lb-shadow)" }}
      >
        <div
          className="inline-flex w-14 h-14 items-center justify-center rounded-full mb-6 text-2xl"
          style={{
            background: "color-mix(in srgb, var(--lb-accent) 16%, transparent)",
            color: "var(--lb-accent)",
          }}
        >
          ⏳
        </div>
        <h1
          className="mb-3"
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: 32,
            letterSpacing: "-0.022em",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Awaiting access
        </h1>
        <p
          className="mx-auto max-w-md mb-6 mt-3"
          style={{ color: "var(--lb-text-2)", fontSize: 15, lineHeight: 1.55 }}
        >
          Your account is signed in but doesn&apos;t have access to anything
          yet. Any CADuniQ staff member (any{" "}
          {ADMIN_EMAIL_DOMAINS.map((d, i) => (
            <span key={d}>
              <span style={{ color: "var(--lb-text)", fontWeight: 500 }}>
                @{d}
              </span>
              {i < ADMIN_EMAIL_DOMAINS.length - 1 ? " or " : ""}
            </span>
          ))}{" "}
          address), or an administrator (
          {ADMIN_EMAILS.map((email, i) => (
            <span key={email}>
              <span style={{ color: "var(--lb-text)", fontWeight: 500 }}>
                {email}
              </span>
              {i < ADMIN_EMAILS.length - 1 ? " or " : ""}
            </span>
          ))}
          ), can grant you access to the supplier list, competitor tracker, or
          both.
        </p>
        <p style={{ color: "var(--lb-text-3)", fontSize: 13 }}>
          Once approved this page will show your dashboard. You can{" "}
          <Link href="/" style={{ color: "var(--lb-accent)" }}>
            refresh
          </Link>{" "}
          at any time.
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand hero — vivid cobalt band introducing Lightbase Operations.
// ─────────────────────────────────────────────────────────────────────────────

function BrandHero({ displayName }: { displayName: string }) {
  return (
    <section
      className="lb-card-vivid lb-card-vivid-blue relative overflow-hidden"
      style={{ padding: 32, borderRadius: "var(--lb-radius-xl)" }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.78)",
        }}
      >
        {CLIENT_CONFIG.name} · Operations
      </span>
      <h1
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: "clamp(28px, 3.6vw, 44px)",
          fontWeight: 800,
          letterSpacing: "-0.025em",
          lineHeight: 1.05,
          margin: "10px 0 8px",
          color: "#ffffff",
        }}
      >
        Welcome back, {firstName(displayName)}.
      </h1>
      <p
        style={{
          maxWidth: 680,
          fontSize: 15,
          lineHeight: 1.55,
          color: "rgba(255,255,255,0.82)",
          margin: 0,
        }}
      >
        Design meets engineering across eleven collections, from horticulture
        and architectural cove to bespoke decorative work. This is your single
        view of the suppliers, projects, and market intelligence behind every
        product line.
      </p>

      <div
        className="mt-5 flex flex-wrap"
        style={{ gap: 8 }}
        aria-label="Lightbase facts"
      >
        {[
          "Montreal, QC",
          "11 product collections",
          "Healthcare · Retail · Hospitality · Education",
          "Eco-engineered",
        ].map((t) => (
          <span
            key={t}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "6px 12px",
              borderRadius: "var(--lb-radius-pill)",
              background: "rgba(255,255,255,0.16)",
              border: "1px solid rgba(255,255,255,0.22)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "-0.005em",
            }}
          >
            {t}
          </span>
        ))}
      </div>

      {/* Decorative concentric rings — pure CSS, picks up the SaaS feel */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: -120,
          top: -120,
          width: 360,
          height: 360,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.18)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: -60,
          top: -60,
          width: 240,
          height: 240,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.22)",
          pointerEvents: "none",
        }}
      />
    </section>
  );
}

function firstName(s: string): string {
  if (!s) return "team";
  if (s.includes("@")) return s.split("@")[0].split(".")[0];
  return s.split(/\s+/)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI card — vivid solid color with mini decoration in the corner.
// ─────────────────────────────────────────────────────────────────────────────

type KpiVariant = "orange" | "blue" | "violet" | "teal";

function KpiCard({
  variant,
  label,
  value,
  sub,
  href,
  decoration,
}: {
  variant: KpiVariant;
  label: string;
  value: number;
  sub: string;
  href: string;
  decoration?: React.ReactNode;
}) {
  const cls = `lb-card-vivid lb-card-vivid-${variant}`;
  return (
    <Link
      href={href}
      className={cls}
      style={{
        position: "relative",
        overflow: "hidden",
        textDecoration: "none",
        color: "#fff",
        padding: 22,
        borderRadius: "var(--lb-radius-lg)",
        display: "block",
        transition: "transform 160ms ease",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.82)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: "-0.022em",
          lineHeight: 1,
          marginTop: 8,
          color: "#fff",
        }}
      >
        {value.toLocaleString()}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: "rgba(255,255,255,0.82)",
        }}
      >
        {sub}
      </div>
      {decoration && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            opacity: 0.85,
          }}
        >
          {decoration}
        </div>
      )}
    </Link>
  );
}

// Small static SVG decorations — render server-side, no client JS.

function MiniLineChart({ values }: { values: number[] }) {
  if (!values.length) return null;
  const w = 96;
  const h = 36;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="trend">
      <polyline
        points={points}
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MiniBars({ values }: { values: number[] }) {
  const w = 96;
  const h = 36;
  const gap = 3;
  const bw = (w - gap * (values.length - 1)) / values.length;
  const max = Math.max(...values, 1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="distribution">
      {values.map((v, i) => {
        const bh = (v / max) * h;
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            rx={2}
            fill="rgba(255,255,255,0.72)"
          />
        );
      })}
    </svg>
  );
}

function MiniGauge({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <svg
      width={42}
      height={42}
      viewBox="0 0 42 42"
      role="img"
      aria-label={`${percent}%`}
    >
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="4"
      />
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="#ffffff"
        strokeWidth="4"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 21 21)"
      />
    </svg>
  );
}

function MiniDots({ count }: { count: number }) {
  const dots = Array.from({ length: 8 }, (_, i) => i < count);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 8px)",
        gap: 4,
      }}
      aria-hidden
    >
      {dots.map((on, i) => (
        <span
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: 9999,
            background: on ? "#ffffff" : "rgba(255,255,255,0.32)",
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module launcher
// ─────────────────────────────────────────────────────────────────────────────

function ModuleLauncher({
  sup,
  comp,
  handbook,
  engineering,
  admin,
}: {
  sup: boolean;
  comp: boolean;
  handbook: boolean;
  engineering: boolean;
  admin: boolean;
}) {
  // Tile order mirrors the sidebar: Design & Engineering group
  // (Competitors / Process / Engineering) → ERP System → Admin.
  const tiles: Array<{
    show: boolean;
    href: string;
    icon: string;
    title: string;
    body: string;
  }> = [
    {
      show: comp,
      href: "/competitors",
      icon: "◊",
      title: "Competitors & Market Research",
      body:
        "Track every relevant brand, benchmark by tier and capability, and capture ideation against each collection.",
    },
    {
      show: handbook,
      href: "/handbook",
      icon: "≡",
      title: "Process Handbook",
      body:
        "Interactive process spec. Fill the design brief, track progress, save revisions, submit as final.",
    },
    {
      show: engineering,
      href: "/engineering",
      icon: "⚙",
      title: "Engineering Handbook",
      body:
        "Mechanical, electrical, and optical reference: housing, mounting, drivers, optics, thermal.",
    },
    {
      show: sup,
      href: "/suppliers",
      icon: "▢",
      title: "ERP System",
      body:
        "Suppliers, inventory, purchase orders, manufacturing, BOMs, quality, maintenance, and barcodes. All in one tab.",
    },
    {
      show: admin,
      href: "/admin",
      icon: "★",
      title: "Admin",
      body: "Approve new accounts, grant access to specific modules, manage user roles.",
    },
  ];

  return (
    <section className="lb-card" style={{ padding: 24, borderRadius: "var(--lb-radius-lg)" }}>
      <h2 className="lb-section-title" style={{ marginBottom: 16 }}>
        Modules
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {tiles.filter((t) => t.show).map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              display: "block",
              padding: 18,
              borderRadius: "var(--lb-radius)",
              background: "var(--lb-bg-sunken)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              textDecoration: "none",
              transition: "border-color 160ms ease, background 160ms ease",
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "var(--lb-radius-sm)",
                background: "var(--lb-accent)",
                color: "var(--lb-accent-fg)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                marginBottom: 12,
              }}
            >
              {t.icon}
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                marginBottom: 4,
              }}
            >
              {t.title}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--lb-text-2)",
                lineHeight: 1.5,
              }}
            >
              {t.body}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent activity
// ─────────────────────────────────────────────────────────────────────────────

type RecentSupplier = { id: number; name: string; category: string | null; createdAt: Date };
type RecentIdea = { id: number; title: string | null; sourceUrl?: string | null };

function RecentActivity({
  sup,
  recentSuppliers,
  comp,
  recentIdeas,
}: {
  sup: boolean;
  recentSuppliers: RecentSupplier[];
  comp: boolean;
  recentIdeas: RecentIdea[];
}) {
  return (
    <section className="lb-card" style={{ padding: 24, borderRadius: "var(--lb-radius-lg)" }}>
      <h2 className="lb-section-title" style={{ marginBottom: 16 }}>
        Recent activity
      </h2>

      {sup && recentSuppliers.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              marginBottom: 8,
            }}
          >
            Newest suppliers
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recentSuppliers.slice(0, 5).map((s) => (
              <li key={s.id} style={{ marginBottom: 6 }}>
                <Link
                  href="/suppliers"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: "var(--lb-radius-sm)",
                    background: "var(--lb-bg-sunken)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textDecoration: "none",
                    fontSize: 13,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 9999,
                      background: "var(--lb-accent)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.name}
                  </span>
                  {s.category && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--lb-text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.category}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {comp && recentIdeas.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              marginBottom: 8,
            }}
          >
            Latest ideas
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recentIdeas.slice(0, 5).map((i) => (
              <li key={i.id} style={{ marginBottom: 6 }}>
                <Link
                  href="/competitors"
                  style={{
                    display: "block",
                    padding: "8px 10px",
                    borderRadius: "var(--lb-radius-sm)",
                    background: "var(--lb-bg-sunken)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textDecoration: "none",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {i.title?.trim() || "Untitled idea"}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(!sup || recentSuppliers.length === 0) &&
        (!comp || recentIdeas.length === 0) && (
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: 0 }}>
            Nothing new to surface yet. As suppliers and ideas are added, the
            latest entries will appear here.
          </p>
        )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer note — small Lightbase-grounded line at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

function CompanyFootnote() {
  return (
    <div
      style={{
        marginTop: 32,
        fontSize: 12,
        color: "var(--lb-text-3)",
        textAlign: "center",
      }}
    >
      Lightbase Inc. · Montreal, QC · Design Meets Engineering
    </div>
  );
}

// Run a Drizzle query, fall back to an empty array on any failure. Logs the
// error so we can spot unmigrated tables / missing columns in dev. The
// dashboard treats absent data as an empty section rather than a 500.
async function safeQuery<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn("[home] query failed, returning []:", e);
    return [];
  }
}
