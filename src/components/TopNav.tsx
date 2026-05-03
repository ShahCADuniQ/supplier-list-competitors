"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  isAdmin: boolean;
};

export default function TopNav({ canViewSuppliers, canViewCompetitors, isAdmin }: Props) {
  const pathname = usePathname() ?? "/";
  const tab = (href: string, label: string) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    return (
      <Link
        href={href}
        className={
          "px-3 py-1.5 rounded-md text-sm font-medium transition-colors " +
          (active
            ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
            : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800")
        }
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex items-center gap-1">
      {canViewSuppliers && tab("/suppliers", "Suppliers")}
      {canViewCompetitors && tab("/competitors", "Competitors")}
      {isAdmin && tab("/handbook", "Process")}
      {isAdmin && tab("/engineering", "Engineering")}
      {isAdmin && tab("/admin", "Admin")}
    </nav>
  );
}
