"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string };

type Props = {
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
};

// Routes the unified Tools sub-nav renders under. /competitors, /handbook,
// /engineering are kept at the top level for URL stability but classified
// in the navigation as Tools tabs.
const TOOLS_PREFIXES = [
  "/tools",
  "/competitors",
  "/handbook",
  "/engineering",
];

export default function SubNav({
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
}: Props) {
  const pathname = usePathname() ?? "/";

  const inTools = TOOLS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  if (!inTools) return null;

  // Tools subpages (Municipal Contacts, Municipal Contact List) reuse the
  // same "any content access" gate as the page-level guard — see
  // src/app/tools/municipal-contacts/page.tsx.
  const hasToolsBaseAccess =
    canViewSuppliers ||
    canViewCompetitors ||
    canViewEngineering ||
    isAdmin;

  const tabs: Tab[] = [
    hasToolsBaseAccess && {
      href: "/tools/municipal-contacts",
      label: "Municipal Contacts",
    },
    hasToolsBaseAccess && {
      href: "/tools/municipal-contact-list",
      label: "Municipal Contact List",
    },
    canViewCompetitors && {
      href: "/competitors",
      label: "Competitors & Market Research",
    },
    canViewHandbook && { href: "/handbook", label: "Process" },
    canViewEngineering && { href: "/engineering", label: "Engineering" },
  ].filter((t): t is Tab => Boolean(t));

  if (tabs.length <= 1) return null;

  return (
    <nav
      aria-label="Tools sections"
      className="flex items-center gap-2 px-6 py-3 shrink-0 overflow-x-auto"
      style={{
        background: "var(--lb-bg)",
        borderBottom: "1px solid var(--lb-border)",
      }}
    >
      {tabs.map((t) => {
        const active =
          pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 16px",
              height: 36,
              borderRadius: "var(--lb-radius-pill)",
              fontSize: "var(--lb-text-13)",
              fontWeight: active ? 600 : 500,
              letterSpacing: "-0.005em",
              color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
              background: active ? "var(--lb-accent)" : "var(--lb-bg-elev)",
              border: active
                ? "1px solid var(--lb-accent)"
                : "1px solid var(--lb-border)",
              whiteSpace: "nowrap",
              transition:
                "background 160ms ease, color 160ms ease, border-color 160ms ease",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
