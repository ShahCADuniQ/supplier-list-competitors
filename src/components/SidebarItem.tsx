"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  href: string;
  icon: string; // single character / emoji / svg-as-text — replace with lucide later
  label: string;
  collapsed: boolean;
  exact?: boolean; // match only on exact pathname; default false (prefix match)
};

export default function SidebarItem({
  href,
  icon,
  label,
  collapsed,
  exact = false,
}: Props) {
  const pathname = usePathname() ?? "/";
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
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
        {icon}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
