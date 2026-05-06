"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string };

type Props = {
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
};

const DESIGN_PREFIXES = ["/competitors", "/handbook", "/engineering"];

export default function SubNav({
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
}: Props) {
  const pathname = usePathname() ?? "/";

  const inDesign = DESIGN_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  if (!inDesign) return null;

  const tabs: Tab[] = [
    canViewCompetitors && { href: "/competitors", label: "Competitors & Market Research" },
    canViewHandbook && { href: "/handbook", label: "Process" },
    canViewEngineering && { href: "/engineering", label: "Engineering" },
  ].filter((t): t is Tab => Boolean(t));

  if (tabs.length <= 1) return null;

  return (
    <nav
      aria-label="Design & Engineering sections"
      className="flex items-center gap-2 px-6 py-3 shrink-0 overflow-x-auto"
      style={{
        background: "var(--lb-bg)",
        borderBottom: "1px solid var(--lb-border)",
      }}
    >
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
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
              border: active ? "1px solid var(--lb-accent)" : "1px solid var(--lb-border)",
              whiteSpace: "nowrap",
              transition: "background 160ms ease, color 160ms ease, border-color 160ms ease",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
