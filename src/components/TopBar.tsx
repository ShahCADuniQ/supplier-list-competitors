"use client";

import { Show, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import NotificationsBell from "./NotificationsBell";
import { CLIENT_CONFIG, CADUNIQ_INDUSTRY_SUFFIX } from "@/lib/client-config";

// Top-bar title reflects the sidebar GROUP, not the active sub-tab. The
// sub-nav pills underneath already tell the user which child route is
// active, so showing the same name twice would be redundant. Keep this
// table aligned with the sidebar groups in src/components/Sidebar.tsx.
//
// /competitors, /handbook, /engineering are kept at the top level for URL
// stability but classified in the navigation under the Tools group — they
// all render with the "TOOLS" title and appear as tabs in the unified
// Tools sub-nav (see SubNav.tsx).
const TITLE_BY_PREFIX: { prefix: string; title: string }[] = [
  { prefix: "/suppliers", title: "ERP SYSTEM" },
  { prefix: "/crm", title: "CRM" },
  { prefix: "/oee", title: "OEE & FLOOR OPS" },
  { prefix: "/design-engineering", title: "DESIGN & ENGINEERING" },
  { prefix: "/competitors", title: "TOOLS" },
  { prefix: "/handbook", title: "TOOLS" },
  { prefix: "/engineering", title: "TOOLS" },
  { prefix: "/tools", title: "TOOLS" },
  { prefix: "/admin", title: "ADMIN" },
  { prefix: "/sign-in", title: "SIGN IN" },
  { prefix: "/sign-up", title: "SIGN UP" },
];

function pageTitle(pathname: string): string {
  const match = TITLE_BY_PREFIX.find(
    (m) => pathname === m.prefix || pathname.startsWith(m.prefix + "/"),
  );
  return match?.title ?? CLIENT_CONFIG.name.toUpperCase();
}

export default function TopBar({
  isCaduniq = false,
}: {
  // When true, the CADuniQ pill in the top-right becomes an internal
  // link to "/" (the cross-tenant HQ dashboard) instead of an external
  // link to caduniq.com. Lets staff one-click back to their HQ from
  // anywhere they've drilled into a client.
  isCaduniq?: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const title = pageTitle(pathname);

  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-4 px-6 shrink-0"
      style={{
        height: "var(--lb-topbar-h)",
        background: "var(--lb-bg)",
      }}
    >
      <h1
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: "var(--lb-text)",
          textTransform: "uppercase",
          flexShrink: 0,
          margin: 0,
        }}
      >
        {title}
      </h1>

      {/* Pill search slot */}
      <div className="flex-1 max-w-xl" role="search" aria-label="Search">
        <div
          className="flex items-center gap-2 px-4"
          style={{
            height: 40,
            borderRadius: "var(--lb-radius-pill)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
          }}
        >
          <span aria-hidden style={{ fontSize: 14, color: "var(--lb-text-3)" }}>
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search…"
            className="flex-1 bg-transparent outline-none"
            style={{
              color: "var(--lb-text)",
              fontSize: "var(--lb-text-14)",
              border: "none",
              padding: 0,
              minWidth: 0,
            }}
          />
        </div>
      </div>

      <Show when="signed-in">
        <NotificationsBell />
      </Show>

      <ThemeToggle />

      {/* CADuniQ pill. For staff (@caduniq.com) it's an internal link
          back to "/" — their HQ dashboard listing every client tenant.
          For everyone else it stays an external link to caduniq.com so
          the "powered by" affordance still works. Identical visuals
          either way. */}
      {isCaduniq ? (
        <Link
          href="/"
          title="CADuniQ HQ · back to all clients"
          aria-label="CADuniQ HQ — back to all clients"
          className="hidden sm:inline-flex items-center gap-2.5 px-4 transition-colors"
          style={{
            height: 40,
            borderRadius: "var(--lb-radius-pill)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-2)",
            textDecoration: "none",
            whiteSpace: "nowrap",
            letterSpacing: "-0.005em",
          }}
        >
          <CaduniqPillContents />
        </Link>
      ) : (
        <a
          href="https://caduniq.com"
          target="_blank"
          rel="noopener noreferrer"
          title={`CADuniQ ${CADUNIQ_INDUSTRY_SUFFIX} — property & software`}
          aria-label={`CADuniQ ${CADUNIQ_INDUSTRY_SUFFIX} — property and software`}
          className="hidden sm:inline-flex items-center gap-2.5 px-4 transition-colors"
          style={{
            height: 40,
            borderRadius: "var(--lb-radius-pill)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-2)",
            textDecoration: "none",
            whiteSpace: "nowrap",
            letterSpacing: "-0.005em",
          }}
        >
          <CaduniqPillContents />
        </a>
      )}

      <Show when="signed-out">
        <SignInButton>
          <button className="lb-btn lb-btn-ghost">Sign in</button>
        </SignInButton>
        <SignUpButton>
          <button className="lb-btn lb-btn-primary">Get started</button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </header>
  );
}

// Shared inner content of the CADuniQ pill so the staff (Link → "/")
// and visitor (anchor → caduniq.com) branches stay visually identical
// without duplicating four spans.
function CaduniqPillContents() {
  return (
    <>
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: 8,
          background: "var(--lb-accent)",
          color: "var(--lb-accent-fg)",
          fontSize: 14,
          fontWeight: 800,
          letterSpacing: "-0.02em",
        }}
      >
        C
      </span>
      <span
        style={{
          color: "var(--lb-text)",
          fontWeight: 700,
          fontSize: 15,
          letterSpacing: "-0.01em",
        }}
      >
        CADuniQ{" "}
        <span
          style={{
            color: "var(--lb-text-2)",
            fontWeight: 500,
          }}
        >
          {CADUNIQ_INDUSTRY_SUFFIX}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          width: 1,
          height: 18,
          background: "var(--lb-border)",
        }}
      />
      <span
        style={{
          color: "var(--lb-text-3)",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        property &amp; software
      </span>
    </>
  );
}
