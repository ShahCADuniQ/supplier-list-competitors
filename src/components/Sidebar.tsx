"use client";

import Link from "next/link";
import SidebarItem from "./SidebarItem";

type Props = {
  collapsed: boolean;
  email: string | null;
  role: string | null;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
};

type Item = {
  href: string;
  icon: string;
  label: string;
  show: boolean;
};

export default function Sidebar({
  collapsed,
  email,
  role,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
}: Props) {
  const items: Item[] = [
    { href: "/suppliers", icon: "▢", label: "Inventory & Manufacturing", show: canViewSuppliers },
    { href: "/competitors", icon: "◊", label: "Competitors & Market Research", show: canViewCompetitors },
    { href: "/handbook", icon: "≡", label: "Process", show: canViewHandbook },
    { href: "/engineering", icon: "⚙", label: "Engineering", show: canViewEngineering },
    { href: "/admin", icon: "★", label: "Admin", show: isAdmin },
  ];

  const width = collapsed ? "var(--lb-sidebar-collapsed-w)" : "var(--lb-sidebar-w)";

  return (
    <aside
      className="flex flex-col shrink-0 border-r"
      style={{
        width,
        borderColor: "var(--lb-border)",
        background: "var(--lb-bg-elev)",
        transition: "width 160ms ease",
      }}
    >
      {/* Brand */}
      <Link
        href="/"
        className="flex items-center gap-2 h-12 px-3 border-b shrink-0"
        style={{
          borderColor: "var(--lb-border)",
          color: "var(--lb-text)",
          fontWeight: 600,
          letterSpacing: "-0.015em",
          fontSize: "var(--lb-text-15)",
        }}
        title="Lightbase"
      >
        <span
          aria-hidden
          className="inline-block shrink-0"
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "var(--lb-accent)",
          }}
        />
        {!collapsed && <span>Lightbase</span>}
      </Link>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
        {items
          .filter((i) => i.show)
          .map((i) => (
            <SidebarItem
              key={i.href}
              href={i.href}
              icon={i.icon}
              label={i.label}
              collapsed={collapsed}
            />
          ))}
      </nav>

      {/* User pill */}
      {email && (
        <div
          className="border-t px-3 py-3 flex items-center gap-2 shrink-0"
          style={{ borderColor: "var(--lb-border)" }}
        >
          <span
            aria-hidden
            className="inline-flex items-center justify-center shrink-0 rounded-full"
            style={{
              width: 28,
              height: 28,
              background: "var(--lb-bg-sunken)",
              color: "var(--lb-text-2)",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {email.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{
                  color: "var(--lb-text)",
                  fontSize: "var(--lb-text-13)",
                  fontWeight: 500,
                }}
              >
                {email}
              </div>
              {role && role !== "member" && (
                <div
                  className="truncate uppercase"
                  style={{
                    color: "var(--lb-text-3)",
                    fontSize: "var(--lb-text-12)",
                    letterSpacing: "0.04em",
                  }}
                >
                  {role}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
