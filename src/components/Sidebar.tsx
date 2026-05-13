"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CLIENT_CONFIG } from "@/lib/client-config";

type Props = {
  email: string | null;
  role: string | null;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
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
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
}: Props) {
  const pathname = usePathname() ?? "/";

  // Sidebar order: Design & Engineering → ERP System → Tools → Admin.
  // Every item's visibility is gated by an admin-controlled permission so
  // the admin lock system covers everything on the rail. When you add a
  // new top-level surface here, also add a corresponding canView* flag in
  // src/db/schema.ts + src/lib/permissions.ts and surface a column in the
  // Admin panel — that's the contract.
  //
  // Routing classification: /competitors, /handbook, /engineering are
  // RESERVED URLs (kept stable for bookmarks / DB FKs) but classified
  // under the Tools group in the navigation. The Tools rail icon
  // highlights on these routes; Design & Engineering is a separate empty
  // placeholder for future modules.
  const hasDesignEngAccess =
    isAdmin || canViewCompetitors || canViewHandbook || canViewEngineering;

  const items: RailItem[] = [
    {
      href: "/design-engineering",
      label: "Design & Engineering",
      icon: "⊞",
      show: hasDesignEngAccess,
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
      // Tools section — Municipal Contacts is the first tool. The rail item
      // links to the first tab the user can access. matchPrefixes includes
      // /competitors, /handbook, /engineering because those routes are now
      // classified as Tools tabs (see SubNav.tsx) — the Tools icon must
      // highlight when the user is on any of them.
      href: canViewCompetitors
        ? "/competitors"
        : canViewHandbook
          ? "/handbook"
          : canViewEngineering
            ? "/engineering"
            : "/tools/municipal-contacts",
      label: "Tools",
      icon: "🛠",
      show:
        canViewSuppliers ||
        canViewCompetitors ||
        canViewHandbook ||
        canViewEngineering ||
        isAdmin,
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
      {/* Brand mark — solid accent square */}
      <Link
        href="/"
        title={CLIENT_CONFIG.name}
        aria-label={`${CLIENT_CONFIG.name} home`}
        className="inline-flex items-center justify-center mb-3 transition-transform hover:scale-105"
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          background: "var(--lb-accent)",
          color: "var(--lb-accent-fg)",
          fontWeight: 700,
          fontSize: 18,
          letterSpacing: "-0.02em",
        }}
      >
        {CLIENT_CONFIG.name.slice(0, 1).toUpperCase()}
      </Link>

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

      {/* Footer — settings (placeholder) + user avatar */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          className="inline-flex items-center justify-center transition-colors"
          style={{
            width: 40,
            height: 40,
            borderRadius: 14,
            background: "var(--lb-bg-elev)",
            color: "var(--lb-text-2)",
            border: "1px solid var(--lb-border)",
            cursor: "pointer",
            fontSize: 16,
          }}
        >
          ⚙
        </button>
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
