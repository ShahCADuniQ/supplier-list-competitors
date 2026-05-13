"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Static map. Add entries here as new routes ship.
const ROUTE_LABELS: Record<string, string> = {
  "": "Home",
  suppliers: "ERP System",
  "design-engineering": "Design & Engineering",
  // /competitors, /handbook, /engineering now live under the Tools group
  // in the navigation, but their breadcrumb label is still the resource
  // name — that's what the segment URL means.
  competitors: "Competitors & Market Research",
  handbook: "Process",
  engineering: "Engineering",
  tools: "Tools",
  admin: "Admin",
  "sign-in": "Sign in",
  "sign-up": "Sign up",
};

export default function Breadcrumbs() {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);

  // Build crumb objects with hrefs.
  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = ROUTE_LABELS[seg] ?? seg;
    return { href, label };
  });

  // Always anchor with Home.
  const all = [{ href: "/", label: "Home" }, ...crumbs];

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
      {all.map((c, i) => {
        const last = i === all.length - 1;
        return (
          <span key={c.href} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && (
              <span
                aria-hidden
                style={{ color: "var(--lb-text-3)", fontSize: 12 }}
              >
                /
              </span>
            )}
            {last ? (
              <span
                className="truncate"
                style={{
                  color: "var(--lb-text)",
                  fontSize: "var(--lb-text-13)",
                  fontWeight: 500,
                }}
              >
                {c.label}
              </span>
            ) : (
              <Link
                href={c.href}
                className="truncate"
                style={{
                  color: "var(--lb-text-2)",
                  fontSize: "var(--lb-text-13)",
                }}
              >
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
