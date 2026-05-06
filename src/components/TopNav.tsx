"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
};

export default function TopNav({
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
}: Props) {
  const pathname = usePathname() ?? "/";

  const tabs: [boolean, string, string][] = [
    [canViewSuppliers, "/suppliers", "Inventory & Manufacturing"],
    [canViewCompetitors, "/competitors", "Competitors & Market Research"],
    [canViewHandbook, "/handbook", "Process"],
    [canViewEngineering, "/engineering", "Engineering"],
    [isAdmin, "/admin", "Admin"],
  ];

  return (
    <nav className="lb-topnav" aria-label="Primary">
      {tabs
        .filter(([show]) => show)
        .map(([, href, label]) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`lb-topnav-link${active ? " is-active" : ""}`}
            >
              {label}
            </Link>
          );
        })}

      <style>{`
        .lb-topnav{display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none}
        .lb-topnav::-webkit-scrollbar{display:none}
        .lb-topnav-link{
          display:inline-flex;align-items:center;justify-content:center;
          padding:6px 12px;border-radius:var(--lb-radius-pill);
          font-size:12.5px;font-weight:500;letter-spacing:-.005em;white-space:nowrap;
          color:var(--lb-text-2);text-decoration:none;
          transition:color .2s ease,background .2s ease;
        }
        .lb-topnav-link:hover{color:var(--lb-text);background:color-mix(in srgb,var(--lb-text) 5%,transparent)}
        .lb-topnav-link.is-active{
          color:var(--lb-text);
          background:color-mix(in srgb,var(--lb-text) 8%,transparent);
          font-weight:600;
        }
      `}</style>
    </nav>
  );
}
