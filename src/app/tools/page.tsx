import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewEngineering,
  isAdmin,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

const TOOLS: Array<{
  href: string;
  title: string;
  description: string;
  icon: string;
}> = [
  {
    href: "/tools/municipal-contacts",
    title: "Canadian Municipal Contacts",
    description:
      "Generate engineering and administration contacts for cities, towns, and villages across any Canadian province. Pick scope, target count, and the tool researches and categorizes the records.",
    icon: "🏛",
  },
];

export default async function ToolsLanding() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  return (
    <div
      style={{
        padding: "32px 28px",
        maxWidth: 1200,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--lb-text-3)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Tools
        </div>
        <h1
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: 30,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: "var(--lb-text)",
            margin: "4px 0 6px",
          }}
        >
          Specialized utilities
        </h1>
        <p
          style={{
            color: "var(--lb-text-2)",
            fontSize: 14,
            margin: 0,
            maxWidth: 720,
          }}
        >
          Lightweight, AI-assisted utilities the team uses ad hoc — research,
          enrichment, and exports.
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 14,
        }}
      >
        {TOOLS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 18,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 14,
              color: "var(--lb-text)",
              textDecoration: "none",
              transition: "border-color 160ms, transform 120ms, box-shadow 160ms",
            }}
            className="lb-tool-card"
          >
            <div style={{ fontSize: 28, lineHeight: 1 }}>{t.icon}</div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>
              {t.title}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--lb-text-2)", lineHeight: 1.5 }}>
              {t.description}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
