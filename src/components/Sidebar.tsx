"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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

type Child = { href: string; label: string; show: boolean };

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
  const pathname = usePathname() ?? "/";

  const designChildren: Child[] = [
    { href: "/competitors", label: "Competitors & Market Research", show: canViewCompetitors },
    { href: "/handbook", label: "Process", show: canViewHandbook },
    { href: "/engineering", label: "Engineering", show: canViewEngineering },
  ].filter((c) => c.show);

  const designGroupShown = designChildren.length > 0;
  const designGroupActive = designChildren.some(
    (c) => pathname === c.href || pathname.startsWith(c.href + "/"),
  );

  // null = follow auto-derived state (expanded when a child is active);
  // boolean = user explicitly toggled. Avoids setState-in-effect.
  const [forceOpen, setForceOpen] = useState<boolean | null>(null);
  const designOpen = forceOpen ?? designGroupActive;

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
        {canViewSuppliers && (
          <SidebarItem
            href="/suppliers"
            icon="▢"
            label="Inventory & Manufacturing"
            collapsed={collapsed}
          />
        )}

        {designGroupShown && (
          <DesignGroup
            collapsed={collapsed}
            open={designOpen}
            active={designGroupActive}
            onToggle={() => setForceOpen(!designOpen)}
            entries={designChildren}
            pathname={pathname}
          />
        )}

        {isAdmin && (
          <SidebarItem href="/admin" icon="★" label="Admin" collapsed={collapsed} />
        )}
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

function DesignGroup({
  collapsed,
  open,
  active,
  onToggle,
  entries,
  pathname,
}: {
  collapsed: boolean;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  entries: Child[];
  pathname: string;
}) {
  // Collapsed sidebar: render the group as a single icon link to the first
  // available child. Expanded sidebar: render the group header as a button
  // that toggles the children below.
  if (collapsed) {
    const firstHref = entries[0]?.href ?? "/";
    return (
      <Link
        href={firstHref}
        title="Design & Engineering"
        aria-current={active ? "page" : undefined}
        className="flex items-center gap-3 rounded-[var(--lb-radius-sm)] px-3 h-9 transition-colors"
        style={{
          color: active ? "var(--lb-text)" : "var(--lb-text-2)",
          background: active ? "var(--lb-bg-sunken)" : "transparent",
          fontSize: "var(--lb-text-13)",
          fontWeight: active ? 600 : 500,
          letterSpacing: "-0.005em",
        }}
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center shrink-0"
          style={{ width: 16, height: 16, fontSize: 14 }}
        >
          ⊞
        </span>
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-3 rounded-[var(--lb-radius-sm)] px-3 h-9 transition-colors w-full text-left"
        style={{
          color: active ? "var(--lb-text)" : "var(--lb-text-2)",
          background: active && !open ? "var(--lb-bg-sunken)" : "transparent",
          fontSize: "var(--lb-text-13)",
          fontWeight: active ? 600 : 500,
          letterSpacing: "-0.005em",
          cursor: "pointer",
          border: "none",
        }}
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center shrink-0"
          style={{ width: 16, height: 16, fontSize: 14 }}
        >
          ⊞
        </span>
        <span className="truncate flex-1">Design &amp; Engineering</span>
        <span
          aria-hidden
          className="shrink-0"
          style={{
            fontSize: 10,
            color: "var(--lb-text-3)",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 120ms ease",
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 mt-0.5 mb-1">
          {entries.map((c) => {
            const isActive =
              pathname === c.href || pathname.startsWith(c.href + "/");
            return (
              <Link
                key={c.href}
                href={c.href}
                aria-current={isActive ? "page" : undefined}
                className="flex items-center rounded-[var(--lb-radius-sm)] h-8 transition-colors"
                style={{
                  paddingLeft: 32,
                  paddingRight: 12,
                  color: isActive ? "var(--lb-text)" : "var(--lb-text-2)",
                  background: isActive ? "var(--lb-bg-sunken)" : "transparent",
                  fontSize: "var(--lb-text-13)",
                  fontWeight: isActive ? 600 : 500,
                  letterSpacing: "-0.005em",
                }}
              >
                <span className="truncate">{c.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
