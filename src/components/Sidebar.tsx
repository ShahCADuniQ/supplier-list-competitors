"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CLIENT_CONFIG } from "@/lib/client-config";
import CaduniqLogo from "./CaduniqLogo";

type Props = {
  email: string | null;
  role: string | null;
  isSupplier: boolean;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  canViewDesignEngineering: boolean;
  canViewCrm: boolean;
  canViewOee: boolean;
  isAdmin: boolean;
};

type RailItem = {
  href: string;
  label: string;
  icon: string;
  show: boolean;
  // For grouped destinations (Design & Engineering), the rail item links
  // to the first available child; the parent's `active` state matches if
  // any of its routes is active.
  matchPrefixes?: string[];
};

export default function Sidebar({
  email,
  role,
  isSupplier,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  canViewDesignEngineering,
  canViewCrm,
  canViewOee,
  isAdmin,
}: Props) {
  const pathname = usePathname() ?? "/";

  // Sidebar order: Design & Engineering → ERP System → CRM → OEE → Tools → Admin.
  // Every item's visibility is gated by a dedicated admin-controlled
  // permission so the Admin matrix covers everything on the rail. When you
  // add a new top-level surface here, also add a corresponding canView* flag
  // in src/db/schema.ts + src/lib/permissions.ts and surface a column in
  // the Admin panel — that's the contract.
  //
  // Routing classification: /competitors, /handbook, /engineering are
  // RESERVED URLs (kept stable for bookmarks / DB FKs) but classified
  // under the Tools group in the navigation. The Tools rail icon
  // highlights on these routes.

  // Suppliers see ONE rail item — their vendor portal. Everything else is
  // hidden so they can't poke around the ERP / CRM / Admin etc.
  const items: RailItem[] = isSupplier
    ? [
        {
          href: "/portal",
          label: "Vendor Portal",
          icon: "◈",
          show: true,
          matchPrefixes: ["/portal"],
        },
      ]
    : [
    {
      href: "/design-engineering",
      label: "Design & Engineering",
      icon: "⊞",
      show: canViewDesignEngineering,
      matchPrefixes: ["/design-engineering"],
    },
    {
      // The /suppliers route hosts the ERP system (inventory, manufacturing,
      // suppliers, project-entry tracking). Path stays /suppliers for URL
      // / DB stability; only the visible label is "ERP System".
      href: "/suppliers",
      label: "ERP System",
      icon: "▢",
      show: canViewSuppliers,
      matchPrefixes: ["/suppliers"],
    },
    {
      href: "/crm",
      label: "CRM",
      icon: "◉",
      show: canViewCrm,
      matchPrefixes: ["/crm"],
    },
    {
      href: "/oee",
      label: "OEE & Floor Ops",
      icon: "⚡",
      show: canViewOee,
      matchPrefixes: ["/oee"],
    },
    {
      // Tools section — Municipal Contacts moved under /crm, so the remaining
      // Tools tabs are Competitors / Process (handbook) / Engineering. The
      // rail item links to the first one the user can access. matchPrefixes
      // still includes /tools so legacy bookmarks under that path keep the
      // icon highlighted while redirecting.
      href: canViewCompetitors
        ? "/competitors"
        : canViewHandbook
          ? "/handbook"
          : "/engineering",
      label: "Tools",
      icon: "🛠",
      show:
        canViewCompetitors || canViewHandbook || canViewEngineering || isAdmin,
      matchPrefixes: [
        "/tools",
        "/competitors",
        "/handbook",
        "/engineering",
      ],
    },
    {
      href: "/admin",
      label: "Admin",
      icon: "★",
      show: isAdmin,
      matchPrefixes: ["/admin"],
    },
  ];

  return (
    <aside
      className="flex flex-col items-center shrink-0 py-4 gap-1"
      style={{
        width: "var(--lb-sidebar-w)",
        background: "var(--lb-bg)",
      }}
    >
      {/* Brand mark — CADuniQ logo. Renders transparent so it sits
          flush on the sidebar surface in both light and dark themes
          (the dark variant of the PNG handles the navy → white text
          recolour). */}
      <div className="mb-3 transition-transform hover:scale-105">
        <CaduniqLogo href="/" height={60} label={CLIENT_CONFIG.name} />
      </div>

      {/* Primary nav rail */}
      <nav className="flex flex-col items-center gap-2 flex-1" aria-label="Primary">
        {items
          .filter((i) => i.show)
          .map((i) => {
            const active = (i.matchPrefixes ?? [i.href]).some(
              (p) => pathname === p || pathname.startsWith(p + "/"),
            );
            return <RailIcon key={i.label} item={i} active={active} />;
          })}
      </nav>

      {/* Footer — settings + user avatar. The gear opens /settings/email
          (currently the only settings surface) and is available to every
          signed-in user, regardless of tenant access. */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <Link
          href="/settings"
          title="Manage Account"
          aria-label="Manage Account"
          aria-current={
            pathname === "/settings/email" ||
            pathname.startsWith("/settings/")
              ? "page"
              : undefined
          }
          className="inline-flex items-center justify-center transition-colors"
          style={{
            width: 40,
            height: 40,
            borderRadius: 14,
            background:
              pathname.startsWith("/settings/")
                ? "var(--lb-accent)"
                : "var(--lb-bg-elev)",
            color:
              pathname.startsWith("/settings/")
                ? "var(--lb-accent-fg)"
                : "var(--lb-text-2)",
            border:
              pathname.startsWith("/settings/")
                ? "1px solid var(--lb-accent)"
                : "1px solid var(--lb-border)",
            boxShadow: pathname.startsWith("/settings/")
              ? "var(--lb-glow-accent)"
              : "none",
            fontSize: 16,
            textDecoration: "none",
          }}
        >
          ⚙
        </Link>
        {email && (
          <div
            title={`${email}${role && role !== "member" ? ` · ${role}` : ""}`}
            aria-label={`Signed in as ${email}`}
            className="inline-flex items-center justify-center"
            style={{
              width: 40,
              height: 40,
              borderRadius: 9999,
              background: "var(--lb-bg-elev)",
              color: "var(--lb-text)",
              border: "1px solid var(--lb-border)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {email.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
    </aside>
  );
}

function RailIcon({ item, active }: { item: RailItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className="inline-flex items-center justify-center transition-all"
      style={{
        width: 44,
        height: 44,
        borderRadius: 14,
        background: active ? "var(--lb-accent)" : "var(--lb-bg-elev)",
        color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
        border: active ? "1px solid var(--lb-accent)" : "1px solid var(--lb-border)",
        boxShadow: active ? "var(--lb-glow-accent)" : "none",
        fontSize: 18,
      }}
    >
      <span aria-hidden style={{ lineHeight: 1 }}>
        {item.icon}
      </span>
    </Link>
  );
}
