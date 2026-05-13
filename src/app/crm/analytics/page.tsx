import Link from "next/link";
import { redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getCrmAnalytics } from "../actions";
import { ACTIVITY_ICON, ACTIVITY_LABEL, STAGE_META } from "../constants";
import type { CrmOpportunity } from "@/db/schema";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Analytics — CRM — ${CLIENT_CONFIG.name}`,
};

function fmtUsd(n: number) {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number) {
  return `${Math.round(n * 100)}%`;
}

export default async function CrmAnalyticsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");
  const a = await getCrmAnalytics();

  // Funnel — show only open + won/lost stages (skip on-hold for the funnel)
  const FUNNEL_STAGES: Array<CrmOpportunity["stage"]> = [
    "lead",
    "qualified",
    "demo",
    "proposal",
    "negotiation",
    "won",
  ];
  const funnelMap = new Map(a.funnel.map((f) => [f.stage, f]));
  const funnelMax = Math.max(
    1,
    ...FUNNEL_STAGES.map((s) => funnelMap.get(s)?.count ?? 0),
  );

  const totalForecast =
    a.forecast.next30.weightedUsd +
    a.forecast.next60.weightedUsd +
    a.forecast.next90.weightedUsd;

  const totalAccountsHealth =
    a.healthBuckets.healthy + a.healthBuckets.watch + a.healthBuckets.atRisk;

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "clamp(24px, 3vw, 32px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            Analytics & Forecasting
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
              maxWidth: 720,
            }}
          >
            Pipeline funnel, win rates, weighted forecasting by close window,
            account health distribution, and recent activity volume — all
            scoped to the records you own.
          </p>
        </div>
        <Link
          href="/crm"
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            background: "transparent",
            color: "var(--lb-text-2)",
            border: "1px solid var(--lb-border)",
            fontSize: 12.5,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          ← Overview
        </Link>
      </header>

      {/* Top KPI row */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <KpiTile
          label="Win rate (count)"
          value={fmtPct(a.winRateByCount)}
          hint="Won ÷ (Won + Lost) by deal count"
          color="#16a34a"
        />
        <KpiTile
          label="Win rate ($)"
          value={fmtPct(a.winRateByValue)}
          hint="Weighted by closed-deal value"
          color="#0891b2"
        />
        <KpiTile
          label="90-day forecast"
          value={fmtUsd(totalForecast)}
          hint="Weighted, expected close ≤ 90d"
          color="#7c3aed"
        />
        <KpiTile
          label="Activities (30d)"
          value={String(a.totalActivities30d)}
          hint="Calls + emails + meetings + notes + tasks"
          color="#ea580c"
        />
      </section>

      {/* Funnel + Forecast side-by-side */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: 12,
        }}
      >
        <Panel title="Pipeline funnel" subtitle="Count and $ at each stage">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {FUNNEL_STAGES.map((s) => {
              const row = funnelMap.get(s);
              const cnt = row?.count ?? 0;
              const total = row?.totalUsd ?? 0;
              const weighted = row?.weightedUsd ?? 0;
              const meta = STAGE_META[s];
              const pct = (cnt / funnelMax) * 100;
              return (
                <div
                  key={s}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 700, color: meta.color }}>
                      {meta.label}
                    </span>
                    <span
                      style={{
                        color: "var(--lb-text-3)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {cnt} · {fmtUsd(total)}{" "}
                      {s !== "won" && (
                        <span style={{ color: "var(--lb-text-3)" }}>
                          (w. {fmtUsd(weighted)})
                        </span>
                      )}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 10,
                      borderRadius: 5,
                      background: "var(--lb-bg)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: meta.color,
                        transition: "width 220ms ease",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          title="Weighted forecast"
          subtitle="Open opps grouped by expected close date"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ForecastRow
              label="Next 30 days"
              bucket={a.forecast.next30}
              color="#16a34a"
            />
            <ForecastRow
              label="Days 31–60"
              bucket={a.forecast.next60}
              color="#0891b2"
            />
            <ForecastRow
              label="Days 61–90"
              bucket={a.forecast.next90}
              color="#7c3aed"
            />
            <ForecastRow
              label="Beyond 90 days"
              bucket={a.forecast.later}
              color="#6b7280"
            />
            <ForecastRow
              label="No close date set"
              bucket={a.forecast.noDate}
              color="#ca8a04"
            />
          </div>
        </Panel>
      </section>

      {/* Top open deals + activity volume + health */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 12,
        }}
      >
        <Panel
          title="Top open opportunities"
          subtitle="By weighted $ value — focus your next move here"
        >
          {a.topOpen.length === 0 ? (
            <Empty>No open opportunities yet.</Empty>
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
              {a.topOpen.map((o) => {
                const meta = STAGE_META[o.stage];
                return (
                  <li
                    key={o.id}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      borderLeft: `4px solid ${meta.color}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {o.title}
                      </div>
                      <Link
                        href={`/crm/accounts/${o.accountId}`}
                        style={{
                          fontSize: 11.5,
                          color: "var(--lb-text-3)",
                          textDecoration: "none",
                        }}
                      >
                        {o.accountName} · {meta.label} · {o.probability}%
                      </Link>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 800 }}>
                        {fmtUsd(o.weightedUsd)}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--lb-text-3)",
                        }}
                      >
                        of {fmtUsd(o.amountUsd)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Account health"
          subtitle={`${totalAccountsHealth} accounts scored`}
        >
          {totalAccountsHealth === 0 ? (
            <Empty>No accounts yet.</Empty>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  height: 28,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                }}
              >
                <HealthSegment
                  count={a.healthBuckets.healthy}
                  total={totalAccountsHealth}
                  color="#16a34a"
                />
                <HealthSegment
                  count={a.healthBuckets.watch}
                  total={totalAccountsHealth}
                  color="#ca8a04"
                />
                <HealthSegment
                  count={a.healthBuckets.atRisk}
                  total={totalAccountsHealth}
                  color="#dc2626"
                />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  marginTop: 12,
                  fontSize: 12,
                }}
              >
                <HealthLegend
                  label="Healthy 70+"
                  count={a.healthBuckets.healthy}
                  color="#16a34a"
                />
                <HealthLegend
                  label="Watch 40–69"
                  count={a.healthBuckets.watch}
                  color="#ca8a04"
                />
                <HealthLegend
                  label="At risk <40"
                  count={a.healthBuckets.atRisk}
                  color="#dc2626"
                />
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Activity volume (30d)"
          subtitle="Engagement intensity by channel"
        >
          {a.totalActivities30d === 0 ? (
            <Empty>No activity logged in the last 30 days.</Empty>
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
              {(["call", "email", "meeting", "note", "task"] as const).map(
                (t) => {
                  const row = a.activityVolume.find((r) => r.type === t);
                  const c = row?.count ?? 0;
                  const pct = (c / a.totalActivities30d) * 100;
                  return (
                    <li
                      key={t}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {ACTIVITY_ICON[t]} {ACTIVITY_LABEL[t]}
                        </span>
                        <span
                          style={{
                            color: "var(--lb-text-3)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {c}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 6,
                          borderRadius: 3,
                          background: "var(--lb-bg)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            background: "var(--lb-accent)",
                          }}
                        />
                      </div>
                    </li>
                  );
                },
              )}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color: string;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${color}`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          letterSpacing: 0.6,
          fontWeight: 800,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: "var(--lb-text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{hint}</span>
      )}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 18,
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            style={{
              fontSize: 12,
              color: "var(--lb-text-3)",
              margin: "2px 0 0",
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function ForecastRow({
  label,
  bucket,
  color,
}: {
  label: string;
  bucket: { count: number; totalUsd: number; weightedUsd: number };
  color: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${color}`,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--lb-text-3)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {bucket.count} deal{bucket.count === 1 ? "" : "s"} ·{" "}
          {fmtUsd(bucket.totalUsd)} gross
        </div>
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtUsd(bucket.weightedUsd)}
      </div>
    </div>
  );
}

function HealthSegment({
  count,
  total,
  color,
}: {
  count: number;
  total: number;
  color: string;
}) {
  if (count === 0) return null;
  const pct = (count / total) * 100;
  return (
    <div
      title={`${count} accounts`}
      style={{
        width: `${pct}%`,
        background: color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: 11,
        fontWeight: 800,
      }}
    >
      {pct >= 8 ? count : ""}
    </div>
  );
}

function HealthLegend({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: color,
        }}
      />
      <span style={{ color: "var(--lb-text-2)" }}>
        {label} · <b>{count}</b>
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 12px",
        borderRadius: 10,
        border: "1px dashed var(--lb-border)",
        textAlign: "center",
        color: "var(--lb-text-3)",
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}
