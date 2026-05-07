"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string };

const TABS: Tab[] = [
  {
    href: "/tools/municipal-contacts",
    label: "Municipal Contact Lead Generator",
  },
  {
    href: "/tools/municipal-contact-list",
    label: "Municipal Contact List",
  },
];

export default function ToolsTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Tools"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        overflowX: "auto",
      }}
    >
      {TABS.map((t) => {
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
              textDecoration: "none",
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
