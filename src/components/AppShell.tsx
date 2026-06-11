"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import SubNav from "./SubNav";
import ThemeToggle from "./ThemeToggle";
import CaduniqLogo from "./CaduniqLogo";

type Props = {
  email: string | null;
  role: string | null;
  isSupplier: boolean;
  // CADuniQ staff (@caduniq.com). True for cross-tenant operators.
  // When set, the home page (/) renders the CADuniQ HQ dashboard
  // instead of the Lightbase-branded view, so we render the chrome
  // brand-neutral on that route.
  isCaduniq?: boolean;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  canViewDesignEngineering: boolean;
  canViewCrm: boolean;
  canViewOee: boolean;
  isAdmin: boolean;
  children: React.ReactNode;
};

// Routes that must NOT show the tenant (Lightbase) chrome.
//
//   /onboarding, /get-started, /sign-in, /sign-up — sign-up flows that
//     happen before any client has approved the user. Showing
//     "LIGHTBASE" anywhere here implies a relationship that doesn't
//     exist yet AND leaks the engineering company's identity to a
//     supplier who hasn't even submitted their onboarding form.
//
//   /portal — the supplier vendor portal. The platform's whole premise
//     is anonymity between suppliers and buyers: suppliers see anonymized
//     job codes, never the engineering company's name. The tenant
//     branding on the sidebar would break that invariant for every
//     supplier on every visit, not just during onboarding.
//
//   /vendor — magic-link supplier portal (legacy entry point); same
//     anonymity reasoning as /portal.
//
// On these routes we render a minimal CADuniQ-only header with theme
// toggle and the user menu so the visitor can still sign out.
const BRAND_NEUTRAL_PREFIXES = [
  "/onboarding",
  "/get-started",
  "/sign-in",
  "/sign-up",
  "/portal",
  "/vendor",
];

function isBrandNeutral(pathname: string): boolean {
  return BRAND_NEUTRAL_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export default function AppShell({
  email,
  role,
  isSupplier,
  isCaduniq,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  canViewDesignEngineering,
  canViewCrm,
  canViewOee,
  isAdmin,
  children,
}: Props) {
  const pathname = usePathname() ?? "/";

  // Brand-neutral mode: signup / onboarding / role-chooser routes AND
  // the / route when the signed-in user is CADuniQ staff (their HQ
  // dashboard is cross-tenant — showing "LIGHTBASE" in the sidebar there
  // would imply the wrong tenant scope).
  const caduniqOnHome = isCaduniq && pathname === "/";
  if (isBrandNeutral(pathname) || caduniqOnHome) {
    return (
      <div
        className="flex min-h-screen w-full flex-col"
        style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
      >
        <header
          className="sticky top-0 z-30 flex items-center justify-between px-6"
          style={{
            height: "var(--lb-topbar-h)",
            background: "transparent",
          }}
        >
          <CaduniqLogo href="/" height={60} />
          <div className="flex items-center gap-3">
            <Link
              href="/settings/email"
              title="Settings"
              aria-label="Settings"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 999,
                border: "1px solid var(--lb-border)",
                background: "var(--lb-bg-elev)",
                color: "var(--lb-text-2)",
                textDecoration: "none",
                fontSize: 15,
              }}
            >
              ⚙
            </Link>
            <ThemeToggle />
            <UserButton />
          </div>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    );
  }

  // Default tenant-branded shell (dashboard, portal post-approval, admin, etc.)
  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <Sidebar
        email={email}
        role={role}
        isSupplier={isSupplier}
        canViewSuppliers={canViewSuppliers}
        canViewCompetitors={canViewCompetitors}
        canViewHandbook={canViewHandbook}
        canViewEngineering={canViewEngineering}
        canViewDesignEngineering={canViewDesignEngineering}
        canViewCrm={canViewCrm}
        canViewOee={canViewOee}
        isAdmin={isAdmin}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar isCaduniq={isCaduniq} />
        <SubNav
          canViewSuppliers={canViewSuppliers}
          canViewCompetitors={canViewCompetitors}
          canViewHandbook={canViewHandbook}
          canViewEngineering={canViewEngineering}
          isAdmin={isAdmin}
        />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
