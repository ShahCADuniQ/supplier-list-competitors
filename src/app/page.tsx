import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import {
  suppliers,
  supplierProjectEntries,
  competitors,
  competitorIdeationItems,
  competitorCollections,
} from "@/db/schema";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
  ADMIN_EMAIL,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Lightbase Operations — front page.
//
// Three render paths:
//   • Signed out: brand hero pointing at sign-in.
//   • Signed in but no permissions yet: awaiting-access card.
//   • Signed in with at least one permission: full operations dashboard
//     (hero band + vivid KPI cards + module launcher + recent activity).
//
// All data queries are gated by the same canView* helpers used elsewhere,
// so a user only sees aggregates from the modules they're allowed into.
export default async function Home() {
  const profile = await getOrCreateProfile();

  if (!profile) return <SignedOutHero />;

  const sup = canViewSuppliers(profile);
  const comp = canViewCompetitors(profile);
  const handbook = canViewHandbook(profile);
  const engineering = canViewEngineering(profile);
  const admin = isAdmin(profile);

  const hasAnyAccess = sup || comp || handbook || engineering || admin;
  if (!hasAnyAccess) return <AwaitingAccess />;

  // Fetch only what the user is allowed to see; everything in parallel.
  const [supRows, peRows, compRows, ideationRows, collectionRows] =
    await Promise.all([
      sup ? db.select().from(suppliers) : Promise.resolve([]),
      sup ? db.select().from(supplierProjectEntries) : Promise.resolve([]),
      comp ? db.select().from(competitors) : Promise.resolve([]),
      comp
        ? db
            .select()
            .from(competitorIdeationItems)
            .orderBy(desc(competitorIdeationItems.id))
            .limit(8)
        : Promise.resolve([]),
      comp
        ? db.select().from(competitorCollections).limit(50)
        : Promise.resolve([]),
    ]);

  // ── KPI rollups ────────────────────────────────────────────────────────
  const totalSuppliers = supRows.length;
  const activeSuppliers = supRows.filter((s) => s.status === "Active").length;
  const distinctOrigins = new Set(
    supRows.map((s) => s.origin).filter(Boolean),
  ).size;
  const inFlight = peRows.filter((p) =>
    ["PO Issued", "In Production", "Shipped"].includes(p.status),
  ).length;
  const closedThisYear = peRows.filter((p) => {
    if (!p.actualDelivery) return false;
    const yr = new Date(p.actualDelivery).getFullYear();
    return yr === new Date().getFullYear();
  }).length;
  const totalCompetitors = compRows.length;
  const totalCollections = collectionRows.length;
  const totalIdeas = ideationRows.length;
  const recentSuppliers = [...supRows]
    .sort(
      (a, b) =>
        new Date(b.createdAt as unknown as string).getTime() -
        new Date(a.createdAt as unknown as string).getTime(),
    )
    .slice(0, 5);

  return (
    <div
      className="min-h-full"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <div className="px-6 pt-6 pb-10" style={{ maxWidth: 1400, margin: "0 auto" }}>
        <BrandHero displayName={profile.displayName ?? profile.email} />

        <section
          className="mt-6 grid gap-5"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
          aria-label="Operations summary"
        >
          {sup && (
            <KpiCard
              variant="orange"
              label="Suppliers"
              value={totalSuppliers}
              sub={`${activeSuppliers} active · ${distinctOrigins} origins`}
              href="/suppliers"
              decoration={<MiniLineChart values={[6, 8, 7, 12, 9, 14, 11, 16]} />}
            />
          )}
          {sup && (
            <KpiCard
              variant="blue"
              label="In-flight Projects"
              value={inFlight}
              sub={`${closedThisYear} delivered in ${new Date().getFullYear()}`}
              href="/suppliers"
              decoration={<MiniGauge percent={inFlight === 0 ? 0 : 62} />}
            />
          )}
          {comp && (
            <KpiCard
              variant="violet"
              label="Competitor Brands"
              value={totalCompetitors}
              sub={`${totalCollections} collection${totalCollections === 1 ? "" : "s"} tracked`}
              href="/competitors"
              decoration={<MiniBars values={[4, 7, 5, 9, 6, 8, 10, 7]} />}
            />
          )}
          {comp && (
            <KpiCard
              variant="teal"
              label="Ideation Pipeline"
              value={totalIdeas}
              sub="Latest pinned ideas"
              href="/competitors"
              decoration={<MiniDots count={Math.min(8, totalIdeas)} />}
            />
          )}
        </section>

        <section className="mt-10 grid gap-5" style={{ gridTemplateColumns: "2fr 1fr" }}>
          <ModuleLauncher
            sup={sup}
            comp={comp}
            handbook={handbook}
            engineering={engineering}
            admin={admin}
          />
          <RecentActivity
            sup={sup}
            recentSuppliers={recentSuppliers}
            comp={comp}
            recentIdeas={ideationRows}
          />
        </section>

        <CompanyFootnote />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed-out hero
// ─────────────────────────────────────────────────────────────────────────────

function SignedOutHero() {
  return (
    <section
      className="flex flex-1 items-center justify-center px-6 py-24 min-h-screen"
      style={{ background: "var(--lb-bg)" }}
    >
      <div className="max-w-3xl text-center">
        <span
          className="lb-section-title"
          style={{
            display: "inline-block",
            padding: "6px 16px",
            borderRadius: "var(--lb-radius-pill)",
            background: "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
            color: "var(--lb-accent)",
            fontSize: 12,
          }}
        >
          Lightbase · Operations
        </span>
        <h1
          className="mt-5"
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: "clamp(44px, 6vw, 76px)",
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            fontWeight: 700,
            color: "var(--lb-text)",
            margin: 0,
          }}
        >
          Design meets engineering —
          <br />
          managed in one place.
        </h1>
        <p
          className="mt-5 mx-auto"
          style={{
            maxWidth: 640,
            fontSize: "clamp(16px, 1.5vw, 19px)",
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
            letterSpacing: "-0.005em",
          }}
        >
          The internal operations console for the Lightbase team — suppliers,
          inventory, manufacturing, competitor research, and the full process
          and engineering handbooks. Sign in to continue. New accounts require
          admin approval before any module unlocks.
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Awaiting access
// ─────────────────────────────────────────────────────────────────────────────

function AwaitingAccess() {
  return (
    <section
      className="flex flex-1 items-center justify-center px-6 py-24 min-h-screen"
      style={{ background: "var(--lb-bg)" }}
    >
      <div
        className="lb-card max-w-xl w-full text-center px-10 py-12"
        style={{ boxShadow: "var(--lb-shadow)" }}
      >
        <div
          className="inline-flex w-14 h-14 items-center justify-center rounded-full mb-6 text-2xl"
          style={{
            background: "color-mix(in srgb, var(--lb-accent) 16%, transparent)",
            color: "var(--lb-accent)",
          }}
        >
          ⏳
        </div>
        <h1
          className="mb-3"
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: 32,
            letterSpacing: "-0.022em",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Awaiting access
        </h1>
        <p
          className="mx-auto max-w-md mb-6 mt-3"
          style={{ color: "var(--lb-text-2)", fontSize: 15, lineHeight: 1.55 }}
        >
          Your account is signed in but doesn&apos;t have access to anything
          yet. An administrator (
          <span style={{ color: "var(--lb-text)", fontWeight: 500 }}>
            {ADMIN_EMAIL}
          </span>
          ) needs to grant you access to the supplier list, competitor tracker,
          or both.
        </p>
        <p style={{ color: "var(--lb-text-3)", fontSize: 13 }}>
          Once approved this page will show your dashboard. You can{" "}
          <Link href="/" style={{ color: "var(--lb-accent)" }}>
            refresh
          </Link>{" "}
          at any time.
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand hero — vivid cobalt band introducing Lightbase Operations.
// ─────────────────────────────────────────────────────────────────────────────

function BrandHero({ displayName }: { displayName: string }) {
  return (
    <section
      className="lb-card-vivid lb-card-vivid-blue relative overflow-hidden"
      style={{ padding: 32, borderRadius: "var(--lb-radius-xl)" }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.78)",
        }}
      >
        Lightbase · Operations
      </span>
      <h1
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: "clamp(28px, 3.6vw, 44px)",
          fontWeight: 800,
          letterSpacing: "-0.025em",
          lineHeight: 1.05,
          margin: "10px 0 8px",
          color: "#ffffff",
        }}
      >
        Welcome back, {firstName(displayName)}.
      </h1>
      <p
        style={{
          maxWidth: 680,
          fontSize: 15,
          lineHeight: 1.55,
          color: "rgba(255,255,255,0.82)",
          margin: 0,
        }}
      >
        Design meets engineering — across eleven collections, from horticulture
        and architectural cove to bespoke decorative work. This is your single
        view of the suppliers, projects, and market intelligence behind every
        product line.
      </p>

      <div
        className="mt-5 flex flex-wrap"
        style={{ gap: 8 }}
        aria-label="Lightbase facts"
      >
        {[
          "Montreal, QC",
          "11 product collections",
          "Healthcare · Retail · Hospitality · Education",
          "Eco-engineered",
        ].map((t) => (
          <span
            key={t}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "6px 12px",
              borderRadius: "var(--lb-radius-pill)",
              background: "rgba(255,255,255,0.16)",
              border: "1px solid rgba(255,255,255,0.22)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "-0.005em",
            }}
          >
            {t}
          </span>
        ))}
      </div>

      {/* Decorative concentric rings — pure CSS, picks up the SaaS feel */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: -120,
          top: -120,
          width: 360,
          height: 360,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.18)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: -60,
          top: -60,
          width: 240,
          height: 240,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.22)",
          pointerEvents: "none",
        }}
      />
    </section>
  );
}

function firstName(s: string): string {
  if (!s) return "team";
  if (s.includes("@")) return s.split("@")[0].split(".")[0];
  return s.split(/\s+/)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI card — vivid solid color with mini decoration in the corner.
// ─────────────────────────────────────────────────────────────────────────────

type KpiVariant = "orange" | "blue" | "violet" | "teal";

function KpiCard({
  variant,
  label,
  value,
  sub,
  href,
  decoration,
}: {
  variant: KpiVariant;
  label: string;
  value: number;
  sub: string;
  href: string;
  decoration?: React.ReactNode;
}) {
  const cls = `lb-card-vivid lb-card-vivid-${variant}`;
  return (
    <Link
      href={href}
      className={cls}
      style={{
        position: "relative",
        overflow: "hidden",
        textDecoration: "none",
        color: "#fff",
        padding: 22,
        borderRadius: "var(--lb-radius-lg)",
        display: "block",
        transition: "transform 160ms ease",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.82)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: "-0.022em",
          lineHeight: 1,
          marginTop: 8,
          color: "#fff",
        }}
      >
        {value.toLocaleString()}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: "rgba(255,255,255,0.82)",
        }}
      >
        {sub}
      </div>
      {decoration && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            opacity: 0.85,
          }}
        >
          {decoration}
        </div>
      )}
    </Link>
  );
}

// Small static SVG decorations — render server-side, no client JS.

function MiniLineChart({ values }: { values: number[] }) {
  if (!values.length) return null;
  const w = 96;
  const h = 36;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="trend">
      <polyline
        points={points}
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MiniBars({ values }: { values: number[] }) {
  const w = 96;
  const h = 36;
  const gap = 3;
  const bw = (w - gap * (values.length - 1)) / values.length;
  const max = Math.max(...values, 1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="distribution">
      {values.map((v, i) => {
        const bh = (v / max) * h;
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            rx={2}
            fill="rgba(255,255,255,0.72)"
          />
        );
      })}
    </svg>
  );
}

function MiniGauge({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <svg
      width={42}
      height={42}
      viewBox="0 0 42 42"
      role="img"
      aria-label={`${percent}%`}
    >
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="4"
      />
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="#ffffff"
        strokeWidth="4"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 21 21)"
      />
    </svg>
  );
}

function MiniDots({ count }: { count: number }) {
  const dots = Array.from({ length: 8 }, (_, i) => i < count);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 8px)",
        gap: 4,
      }}
      aria-hidden
    >
      {dots.map((on, i) => (
        <span
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: 9999,
            background: on ? "#ffffff" : "rgba(255,255,255,0.32)",
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module launcher
// ─────────────────────────────────────────────────────────────────────────────

function ModuleLauncher({
  sup,
  comp,
  handbook,
  engineering,
  admin,
}: {
  sup: boolean;
  comp: boolean;
  handbook: boolean;
  engineering: boolean;
  admin: boolean;
}) {
  const tiles: Array<{
    show: boolean;
    href: string;
    icon: string;
    title: string;
    body: string;
  }> = [
    {
      show: sup,
      href: "/suppliers",
      icon: "▢",
      title: "Inventory & Manufacturing",
      body:
        "Suppliers, projects, POs, BOMs, quality, maintenance, and barcodes — all in one tab.",
    },
    {
      show: comp,
      href: "/competitors",
      icon: "◊",
      title: "Competitors & Market Research",
      body:
        "Track every relevant brand, benchmark by tier and capability, and capture ideation against each collection.",
    },
    {
      show: handbook,
      href: "/handbook",
      icon: "≡",
      title: "Process Handbook",
      body:
        "Interactive process spec — fill the design brief, track progress, save revisions, submit as final.",
    },
    {
      show: engineering,
      href: "/engineering",
      icon: "⚙",
      title: "Engineering Handbook",
      body:
        "Mechanical, electrical, optical reference — housing, mounting, drivers, optics, thermal.",
    },
    {
      show: admin,
      href: "/admin",
      icon: "★",
      title: "Admin",
      body: "Approve new accounts, grant access to specific modules, manage user roles.",
    },
  ];

  return (
    <section className="lb-card" style={{ padding: 24, borderRadius: "var(--lb-radius-lg)" }}>
      <h2 className="lb-section-title" style={{ marginBottom: 16 }}>
        Modules
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {tiles.filter((t) => t.show).map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              display: "block",
              padding: 18,
              borderRadius: "var(--lb-radius)",
              background: "var(--lb-bg-sunken)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              textDecoration: "none",
              transition: "border-color 160ms ease, background 160ms ease",
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "var(--lb-radius-sm)",
                background: "var(--lb-accent)",
                color: "var(--lb-accent-fg)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                marginBottom: 12,
              }}
            >
              {t.icon}
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                marginBottom: 4,
              }}
            >
              {t.title}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--lb-text-2)",
                lineHeight: 1.5,
              }}
            >
              {t.body}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent activity
// ─────────────────────────────────────────────────────────────────────────────

type RecentSupplier = { id: number; name: string; category: string | null; createdAt: Date };
type RecentIdea = { id: number; title: string | null; sourceUrl?: string | null };

function RecentActivity({
  sup,
  recentSuppliers,
  comp,
  recentIdeas,
}: {
  sup: boolean;
  recentSuppliers: RecentSupplier[];
  comp: boolean;
  recentIdeas: RecentIdea[];
}) {
  return (
    <section className="lb-card" style={{ padding: 24, borderRadius: "var(--lb-radius-lg)" }}>
      <h2 className="lb-section-title" style={{ marginBottom: 16 }}>
        Recent activity
      </h2>

      {sup && recentSuppliers.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              marginBottom: 8,
            }}
          >
            Newest suppliers
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recentSuppliers.slice(0, 5).map((s) => (
              <li key={s.id} style={{ marginBottom: 6 }}>
                <Link
                  href="/suppliers"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: "var(--lb-radius-sm)",
                    background: "var(--lb-bg-sunken)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textDecoration: "none",
                    fontSize: 13,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 9999,
                      background: "var(--lb-accent)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.name}
                  </span>
                  {s.category && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--lb-text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.category}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {comp && recentIdeas.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              marginBottom: 8,
            }}
          >
            Latest ideas
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recentIdeas.slice(0, 5).map((i) => (
              <li key={i.id} style={{ marginBottom: 6 }}>
                <Link
                  href="/competitors"
                  style={{
                    display: "block",
                    padding: "8px 10px",
                    borderRadius: "var(--lb-radius-sm)",
                    background: "var(--lb-bg-sunken)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textDecoration: "none",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {i.title?.trim() || "Untitled idea"}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(!sup || recentSuppliers.length === 0) &&
        (!comp || recentIdeas.length === 0) && (
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: 0 }}>
            Nothing new to surface yet. As suppliers and ideas are added, the
            latest entries will appear here.
          </p>
        )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer note — small Lightbase-grounded line at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

function CompanyFootnote() {
  return (
    <div
      style={{
        marginTop: 32,
        fontSize: 12,
        color: "var(--lb-text-3)",
        textAlign: "center",
      }}
    >
      Lightbase Inc. · Montreal, QC · Design Meets Engineering
    </div>
  );
}
