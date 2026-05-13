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

// Sub-nav strips appear on routes that have multiple sub-pages. Today four
// groups need one:
//   1. Design & Engineering (Projects · Software · Full CAD + PDM · Enterprise PDM)
//   2. CRM (Overview · Accounts · Pipeline · Tickets · Analytics · Municipal Lead Gen · Municipal List)
//   3. OEE & Floor Ops (Overview · Machines · Alerts · Analytics)
//   4. Tools (Competitors · Process · Engineering)
//
// Municipal Contacts (lead generator + list) live under CRM since they are
// lead-generation sources that feed into accounts/contacts. The old
// /tools/municipal-contact* URLs redirect to their new /crm/municipal-contact*
// homes so existing bookmarks don't 404.
//
// /suppliers (ERP System) has its sub-tabs INSIDE the page (the
// InventoryAndManufacturing pill bar), not in this top-of-page strip.

const DESIGN_PREFIXES = ["/design-engineering"];

const CRM_PREFIXES = ["/crm"];

const OEE_PREFIXES = ["/oee"];

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
  const inCrm = CRM_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const inOee = OEE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const inTools = TOOLS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!inDesign && !inCrm && !inOee && !inTools) return null;

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
  } else if (inCrm) {
    label = "CRM sections";
    const hasMunicipalAccess =
      canViewSuppliers ||
      canViewCompetitors ||
      canViewEngineering ||
      isAdmin;
    tabs = (
      [
        { href: "/crm", label: "Overview" },
        { href: "/crm/accounts", label: "Accounts" },
        { href: "/crm/pipeline", label: "Pipeline" },
        { href: "/crm/tickets", label: "Tickets" },
        { href: "/crm/analytics", label: "Analytics" },
        hasMunicipalAccess && {
          href: "/crm/municipal-contacts",
          label: "Municipal Lead Gen",
        },
        hasMunicipalAccess && {
          href: "/crm/municipal-contact-list",
          label: "Municipal List",
        },
      ] as Array<Tab | false>
    ).filter((t): t is Tab => Boolean(t));
  } else if (inOee) {
    label = "OEE & Floor Ops sections";
    tabs = [
      { href: "/oee", label: "Overview" },
      { href: "/oee/machines", label: "Machines" },
      { href: "/oee/alerts", label: "Alerts" },
      { href: "/oee/analytics", label: "Analytics" },
    ];
  } else {
    // inTools
    label = "Tools sections";
    tabs = (
      [
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
        // A tab is the "best match" for the current pathname if its href is
        // a prefix AND no other tab in this strip has a longer matching
        // prefix. Without this rule, /crm/accounts would highlight both
        // "Overview" (/crm) and "Accounts" (/crm/accounts).
        const isPrefix =
          pathname === t.href || pathname.startsWith(t.href + "/");
        const hasLongerMatch = tabs.some(
          (o) =>
            o.href !== t.href &&
            o.href.length > t.href.length &&
            (pathname === o.href || pathname.startsWith(o.href + "/")),
        );
        const active = isPrefix && !hasLongerMatch;
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
