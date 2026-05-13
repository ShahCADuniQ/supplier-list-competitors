import Link from "next/link";
import { redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import {
  getCrmDashboard,
  listMyAccounts,
  listPipelineOpportunities,
  listRecentActivities,
} from "./actions";
import NewAccountButton from "./NewAccountButton";
import { STAGE_META, TIER_META, ACTIVITY_ICON } from "./constants";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `CRM — ${CLIENT_CONFIG.name}`,
};

function fmtUsd(n: number) {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRelative(d: Date) {
  const ms = Date.now() - d.getTime();
  const min = ms / 60_000;
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  const day = hr / 24;
  if (day < 30) return `${Math.round(day)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default async function CrmOverviewPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");

  const [dashboard, accounts, pipeline, activities] = await Promise.all([
    getCrmDashboard(),
    listMyAccounts(),
    listPipelineOpportunities(),
    listRecentActivities(8),
  ]);

  const topAccounts = accounts.slice(0, 5);
  const topOpps = pipeline
    .filter((o) => o.stage !== "won" && o.stage !== "lost")
    .sort((a, b) => Number(b.amountUsd) - Number(a.amountUsd))
    .slice(0, 5);

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      {/* HERO */}
      <header
        style={{
          padding: "24px 28px",
          borderRadius: 14,
          background:
            "linear-gradient(155deg, rgba(219,39,119,0.10), var(--lb-bg-elev))",
          border: "1px solid rgba(219,39,119,0.28)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 320 }}>
          <span
            style={{
              display: "inline-block",
              padding: "4px 12px",
              borderRadius: 20,
              background: "rgba(219,39,119,0.18)",
              color: "rgb(219,39,119)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            Stage 4 · Customer Lifecycle
          </span>
          <h1
            style={{
              fontSize: "clamp(28px, 3.6vw, 42px)",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            CRM Overview
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--lb-text-2)",
              margin: "12px 0 0",
              maxWidth: 760,
            }}
          >
            Accounts, opportunities, activities, and tickets — one customer
            record per company. Auto-populated from product signals when other
            CADuniQ stages emit events (CAD upload, quote accept, hub QC pass,
            OEE alert) and editable here at any time.
          </p>
        </div>
        <NewAccountButton />
      </header>

      {/* KPI ROW */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        <Kpi label="Accounts" value={dashboard.totalAccounts} />
        <Kpi label="Contacts" value={dashboard.totalContacts} />
        <Kpi label="Open opps" value={dashboard.openOpportunities} />
        <Kpi
          label="Pipeline value"
          value={fmtUsd(dashboard.totalPipelineValueUsd)}
          isText
        />
        <Kpi
          label="Weighted pipeline"
          value={fmtUsd(dashboard.weightedPipelineUsd)}
          isText
          accent="rgb(124,58,237)"
        />
        <Kpi
          label="Closed won"
          value={fmtUsd(dashboard.closedWonUsd)}
          isText
          accent="rgb(22,163,74)"
        />
        <Kpi
          label="Open tickets"
          value={dashboard.openTickets}
          accent={
            dashboard.urgentTickets > 0 ? "rgb(220,38,38)" : "var(--lb-text)"
          }
        />
      </section>

      {/* TWO-COL: PIPELINE BY STAGE + ACCOUNT TIERS */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 12,
        }}
      >
        <PipelineByStage byStage={dashboard.byStage} />
        <AccountTiers byTier={dashboard.byTier} />
      </section>

      {/* TOP OPEN OPPORTUNITIES */}
      <section
        style={{
          padding: "18px 22px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            Top open opportunities
          </h2>
          <Link
            href="/crm/pipeline"
            style={{
              fontSize: 12.5,
              color: "var(--lb-accent)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Open pipeline →
          </Link>
        </div>
        {topOpps.length === 0 ? (
          <Empty msg="No open opportunities yet. Open an account and add one from its detail page." />
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {topOpps.map((o) => {
              const meta = STAGE_META[o.stage];
              return (
                <li key={o.id}>
                  <Link
                    href={`/crm/accounts/${o.accountId}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 14px",
                      borderRadius: 10,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      borderLeft: `4px solid ${meta.color}`,
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 13.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {o.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--lb-text-3)",
                          marginTop: 2,
                        }}
                      >
                        {o.accountName} · {o.probability}% probability
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 10.5,
                        padding: "3px 9px",
                        borderRadius: 5,
                        background: `${meta.color}22`,
                        color: meta.color,
                        fontWeight: 800,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                      }}
                    >
                      {meta.label}
                    </span>
                    <span
                      style={{
                        fontWeight: 800,
                        fontSize: 14,
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmtUsd(Number(o.amountUsd))}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* TWO-COL: RECENT ACCOUNTS + ACTIVITY */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 12,
        }}
      >
        <div
          style={{
            padding: "18px 22px",
            borderRadius: 14,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h2
              style={{
                fontSize: 14,
                fontWeight: 700,
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Recent accounts
            </h2>
            <Link
              href="/crm/accounts"
              style={{
                fontSize: 12.5,
                color: "var(--lb-accent)",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              All accounts →
            </Link>
          </div>
          {topAccounts.length === 0 ? (
            <Empty msg="No accounts yet. Click + New account to add your first." />
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {topAccounts.map((a) => {
                const tm = TIER_META[a.tier];
                return (
                  <li key={a.id}>
                    <Link
                      href={`/crm/accounts/${a.id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: "var(--lb-bg)",
                        border: "1px solid var(--lb-border)",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: `${tm.color}22`,
                          color: tm.color,
                          fontWeight: 800,
                          fontSize: 12,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {a.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 13.5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.name}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--lb-text-3)",
                          }}
                        >
                          {a.industry || "—"} · health {a.healthScore}
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 5,
                          background: `${tm.color}22`,
                          color: tm.color,
                          fontWeight: 800,
                          textTransform: "uppercase",
                          letterSpacing: 0.6,
                        }}
                      >
                        {tm.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          style={{
            padding: "18px 22px",
            borderRadius: 14,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
          }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: "0 0 12px",
              letterSpacing: "-0.01em",
            }}
          >
            Recent activity
          </h2>
          {activities.length === 0 ? (
            <Empty msg="Activity logs show up here when you record calls, emails, meetings, or notes inside an account." />
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {activities.map((a) => (
                <li
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    fontSize: 12.5,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {ACTIVITY_ICON[a.type]}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link
                      href={`/crm/accounts/${a.accountId}`}
                      style={{
                        color: "var(--lb-text)",
                        fontWeight: 600,
                        textDecoration: "none",
                      }}
                    >
                      {a.subject}
                    </Link>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--lb-text-3)",
                        marginTop: 1,
                      }}
                    >
                      {a.accountName} · {fmtRelative(new Date(a.occurredAt))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  isText,
  accent,
}: {
  label: string;
  value: number | string;
  isText?: boolean;
  accent?: string;
}) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: isText ? 20 : 26,
          fontWeight: 800,
          marginTop: 4,
          letterSpacing: "-0.02em",
          color: accent ?? "var(--lb-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function PipelineByStage({
  byStage,
}: {
  byStage: Array<{
    stage: keyof typeof STAGE_META;
    count: number;
    totalUsd: number;
  }>;
}) {
  const order: Array<keyof typeof STAGE_META> = [
    "lead",
    "qualified",
    "demo",
    "proposal",
    "negotiation",
    "won",
    "lost",
    "on-hold",
  ];
  const map = new Map(byStage.map((s) => [s.stage, s]));
  const maxCount = Math.max(1, ...byStage.map((s) => s.count));
  return (
    <div
      style={{
        padding: "18px 22px",
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          margin: "0 0 12px",
          letterSpacing: "-0.01em",
        }}
      >
        Pipeline by stage
      </h2>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {order.map((k) => {
          const s = map.get(k) ?? { stage: k, count: 0, totalUsd: 0 };
          const meta = STAGE_META[k];
          const pct = (s.count / maxCount) * 100;
          return (
            <li
              key={k}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <span
                style={{
                  width: 110,
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: meta.color,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  flexShrink: 0,
                }}
              >
                {meta.label}
              </span>
              <div
                aria-hidden
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 999,
                  background: "var(--lb-bg)",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: `${pct}%`,
                    background: meta.color,
                  }}
                />
              </div>
              <span
                style={{
                  width: 50,
                  textAlign: "right",
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--lb-text-2)",
                }}
              >
                {s.count}
              </span>
              <span
                style={{
                  width: 70,
                  textAlign: "right",
                  fontSize: 12,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--lb-text)",
                }}
              >
                {fmtUsd(s.totalUsd)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AccountTiers({
  byTier,
}: {
  byTier: Array<{ tier: keyof typeof TIER_META; count: number }>;
}) {
  const order: Array<keyof typeof TIER_META> = [
    "lead",
    "prospect",
    "customer",
    "partner",
    "churned",
  ];
  const map = new Map(byTier.map((t) => [t.tier, t.count]));
  const total = Array.from(map.values()).reduce((s, n) => s + n, 0) || 1;
  return (
    <div
      style={{
        padding: "18px 22px",
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          margin: "0 0 12px",
          letterSpacing: "-0.01em",
        }}
      >
        Accounts by tier
      </h2>
      <div
        aria-hidden
        style={{
          display: "flex",
          height: 12,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--lb-bg)",
          marginBottom: 12,
        }}
      >
        {order.map((k) => {
          const c = map.get(k) ?? 0;
          const meta = TIER_META[k];
          if (c === 0) return null;
          return (
            <div
              key={k}
              title={`${meta.label}: ${c}`}
              style={{
                width: `${(c / total) * 100}%`,
                background: meta.color,
              }}
            />
          );
        })}
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 8,
        }}
      >
        {order.map((k) => {
          const c = map.get(k) ?? 0;
          const meta = TIER_META[k];
          return (
            <li
              key={k}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 8,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: meta.color,
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  color: "var(--lb-text-2)",
                  fontWeight: 600,
                }}
              >
                {meta.label}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: "var(--lb-text)",
                }}
              >
                {c}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div
      style={{
        padding: "20px 18px",
        borderRadius: 10,
        border: "1px dashed var(--lb-border)",
        textAlign: "center",
        color: "var(--lb-text-2)",
        fontSize: 13,
      }}
    >
      {msg}
    </div>
  );
}
