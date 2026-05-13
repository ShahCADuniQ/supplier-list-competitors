"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; comingSoon?: boolean };

type Props = {
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
};

// Sub-nav strips appear on routes that have multiple sub-pages. Today only
// two groups need one:
//   1. Design & Engineering (Stage 1 Software · Stage 5 Full CAD · Stage 5i PDM)
//   2. Tools (Municipal Contacts · Municipal Contact List · Competitors · Process · Engineering)
//
// CRM (/crm) and OEE (/oee) are their own top-level sidebar destinations now
// and don't need a strip until they grow sub-pages of their own. The same
// goes for /suppliers — its sub-tabs live INSIDE the page (the
// InventoryAndManufacturing pill bar), not in this top-of-page strip.

const DESIGN_PREFIXES = ["/design-engineering"];

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

  const inDesign = DESIGN_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const inTools = TOOLS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!inDesign && !inTools) return null;

  let label = "";
  let tabs: Tab[] = [];

  if (inDesign) {
    label = "Design & Engineering sections";
    tabs = [
      { href: "/design-engineering", label: "Projects" },
      {
        href: "/design-engineering/software",
        label: "Software",
        comingSoon: true,
      },
      {
        href: "/design-engineering/full-cad",
        label: "Full CAD + PDM",
        comingSoon: true,
      },
      {
        href: "/design-engineering/enterprise-pdm",
        label: "Enterprise PDM",
        comingSoon: true,
      },
    ];
  } else {
    // inTools
    label = "Tools sections";
    const hasToolsBaseAccess =
      canViewSuppliers ||
      canViewCompetitors ||
      canViewEngineering ||
      isAdmin;
    tabs = (
      [
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
      ] as Array<Tab | false>
    ).filter((t): t is Tab => Boolean(t));
  }

  if (tabs.length <= 1) return null;

  return (
    <nav
      aria-label={label}
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
              gap: 8,
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
            <span>{t.label}</span>
            {t.comingSoon && (
              <span
                aria-hidden
                style={{
                  background: active
                    ? "rgba(255,255,255,0.22)"
                    : "rgba(234,88,12,0.18)",
                  color: active ? "var(--lb-accent-fg)" : "rgb(234,88,12)",
                  fontSize: 9.5,
                  fontWeight: 800,
                  letterSpacing: 0.8,
                  padding: "1px 6px",
                  borderRadius: 4,
                  textTransform: "uppercase",
                }}
              >
                Soon
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
