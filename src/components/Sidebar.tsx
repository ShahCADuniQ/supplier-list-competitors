"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

  // First available child of the Design & Engineering group, used as the
  // single tap-target on the rail. The full breakdown (Competitors / Process
  // / Engineering) lives in the page-level sub-tabs once a child route loads.
  const designFirstHref = canViewCompetitors
    ? "/competitors"
    : canViewHandbook
      ? "/handbook"
      : canViewEngineering
        ? "/engineering"
        : null;

  const items: RailItem[] = [
    {
      href: "/suppliers",
      label: "Inventory & Manufacturing",
      icon: "▢",
      show: canViewSuppliers,
      matchPrefixes: ["/suppliers"],
    },
    {
      href: designFirstHref ?? "/",
      label: "Design & Engineering",
      icon: "⊞",
      show: Boolean(designFirstHref),
      matchPrefixes: ["/competitors", "/handbook", "/engineering"],
    },
    {
      // Tools section — Municipal Contacts is the first tool. The rail item
      // links straight to the most-used child for now.
      href: "/tools/municipal-contacts",
      label: "Tools",
      icon: "🛠",
      show: canViewSuppliers || canViewCompetitors || canViewEngineering || isAdmin,
      matchPrefixes: ["/tools"],
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
        title="Lightbase"
        aria-label="Lightbase home"
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
        L
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
