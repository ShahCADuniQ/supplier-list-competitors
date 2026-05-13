import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewOee } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getOeeDashboard } from "./actions";
import {
  ALERT_SEVERITY_META,
  ALERT_STATUS_META,
  DOWNTIME_REASON_META,
  STATUS_META,
  STATUS_ORDER,
  fmtDuration,
  fmtPct,
  oeeBand,
} from "./constants";
import SeedDemoButton from "./SeedDemoButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `OEE & Floor Ops — ${CLIENT_CONFIG.name}`,
};

export default async function OeeOverviewPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewOee(profile)) redirect("/");

  const data = await getOeeDashboard(24);
  const isEmpty = data.machines.length === 0;
  const band = oeeBand(data.fleet.oee);

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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                background: "rgba(8, 145, 178, 0.16)",
                color: "rgb(8, 145, 178)",
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: 1.2,
                padding: "3px 10px",
                borderRadius: 5,
                textTransform: "uppercase",
              }}
            >
              Stage 6 · Floor Ops
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--lb-text-3)",
                fontWeight: 600,
              }}
            >
              window: last {data.windowHours}h ·{" "}
              {data.asOf.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <h1
            style={{
              fontSize: "clamp(24px, 3vw, 32px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: "8px 0 0",
              lineHeight: 1.1,
            }}
          >
            OEE & Floor Operations
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
              maxWidth: 720,
            }}
          >
            Real-time Overall Equipment Effectiveness for every machine on the
            floor — availability, performance, and quality rolled up across the
            fleet. Any breakdown raises an alert; alerts can be escalated into
            CRM tickets in one click.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link
            href="/oee/machines"
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12.5,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            + Add machine
          </Link>
        </div>
      </header>

      {isEmpty && (
        <section
          style={{
            padding: 24,
            borderRadius: 14,
            background: "var(--lb-bg-elev)",
            border: "1px dashed var(--lb-border)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
            No machines yet
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--lb-text-2)",
              maxWidth: 640,
            }}
          >
            Add machines under <code>/oee/machines</code> to start logging
            runs, downtime, and quality events. Or seed the dashboard with a
            small demo dataset to see the live OEE flow in action.
          </p>
          <SeedDemoButton />
        </section>
      )}

      {/* Fleet KPI tiles */}
      {!isEmpty && (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <KpiTile
              label="Fleet OEE"
              value={fmtPct(data.fleet.oee, 1)}
              hint={band.label}
              color={band.color}
              big
            />
            <KpiTile
              label="Availability"
              value={fmtPct(data.fleet.availability)}
              hint={`${fmtDuration(data.fleet.unplannedDowntimeMs)} unplanned`}
              color="#0891b2"
            />
            <KpiTile
              label="Performance"
              value={fmtPct(data.fleet.performance)}
              hint="vs. ideal cycle"
              color="#7c3aed"
            />
            <KpiTile
              label="Quality"
              value={fmtPct(data.fleet.quality)}
              hint={`${data.fleet.goodCount}/${data.fleet.totalCount} good`}
              color="#16a34a"
            />
            <KpiTile
              label="Open alerts"
              value={String(data.openAlerts)}
              hint={
                data.criticalAlerts > 0
                  ? `${data.criticalAlerts} critical`
                  : "all clear"
              }
              color={data.criticalAlerts > 0 ? "#dc2626" : "#16a34a"}
            />
            <KpiTile
              label="Running now"
              value={String(data.statusCounts.running)}
              hint={`of ${data.machines.length} machines`}
              color="#16a34a"
            />
          </section>

          {/* Machine status grid + Loss reasons */}
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gap: 12,
            }}
          >
            <Panel
              title="Machine status"
              subtitle="Live state · click for the detail view"
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 8,
                }}
              >
                {data.machines.map(
                  ({ machine, breakdown, currentRun, openDowntime }) => {
                    const sm = STATUS_META[machine.status];
                    const mBand = oeeBand(breakdown.oee);
                    return (
                      <Link
                        key={machine.id}
                        href={`/oee/machines/${machine.id}`}
                        style={{
                          textDecoration: "none",
                          color: "inherit",
                        }}
                      >
                        <div
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            background: "var(--lb-bg)",
                            border: "1px solid var(--lb-border)",
                            borderLeft: `4px solid ${sm.color}`,
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            transition: "border-color 140ms ease",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 6,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {machine.name}
                            </div>
                            <span
                              style={{
                                fontSize: 9.5,
                                fontWeight: 800,
                                letterSpacing: 0.6,
                                textTransform: "uppercase",
                                padding: "2px 6px",
                                borderRadius: 4,
                                background: `${sm.color}22`,
                                color: sm.color,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {sm.label}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--lb-text-3)",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 4,
                            }}
                          >
                            <span>
                              {machine.line ?? "—"} ·{" "}
                              {machine.code ?? "no code"}
                            </span>
                            <span
                              style={{
                                color: mBand.color,
                                fontWeight: 700,
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {fmtPct(breakdown.oee, 0)}
                            </span>
                          </div>
                          {currentRun && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--lb-text-2)",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              ▶ {currentRun.partNumber} ·{" "}
                              {currentRun.goodCount}/{currentRun.targetCount}
                            </div>
                          )}
                          {openDowntime && (
                            <div
                              style={{
                                fontSize: 11,
                                color:
                                  DOWNTIME_REASON_META[openDowntime.reason]
                                    .color,
                                fontWeight: 600,
                              }}
                            >
                              ⏸{" "}
                              {DOWNTIME_REASON_META[openDowntime.reason].label}{" "}
                              ·{" "}
                              {fmtDuration(
                                Date.now() - openDowntime.startAt.getTime(),
                              )}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 4 }}>
                            <StatBar
                              label="A"
                              value={breakdown.availability}
                              color="#0891b2"
                            />
                            <StatBar
                              label="P"
                              value={breakdown.performance}
                              color="#7c3aed"
                            />
                            <StatBar
                              label="Q"
                              value={breakdown.quality}
                              color="#16a34a"
                            />
                          </div>
                        </div>
                      </Link>
                    );
                  },
                )}
              </div>
            </Panel>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <Panel
                title="Status mix"
                subtitle="Where every machine sits right now"
              >
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
                  {STATUS_ORDER.map((s) => {
                    const cnt = data.statusCounts[s];
                    if (cnt === 0) return null;
                    const pct = (cnt / data.machines.length) * 100;
                    return (
                      <div
                        key={s}
                        title={`${cnt} ${STATUS_META[s].label}`}
                        style={{
                          width: `${pct}%`,
                          background: STATUS_META[s].color,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 10.5,
                          fontWeight: 800,
                        }}
                      >
                        {pct >= 12 ? cnt : ""}
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginTop: 10,
                    fontSize: 11.5,
                  }}
                >
                  {STATUS_ORDER.map((s) => (
                    <span
                      key={s}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: STATUS_META[s].color,
                        }}
                      />
                      <span style={{ color: "var(--lb-text-2)" }}>
                        {STATUS_META[s].label} · <b>{data.statusCounts[s]}</b>
                      </span>
                    </span>
                  ))}
                </div>
              </Panel>

              <Panel
                title="Top loss reasons"
                subtitle={`Downtime by reason · last ${data.windowHours}h`}
              >
                {data.topLossReasons.length === 0 ? (
                  <Empty>No downtime in the window.</Empty>
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
                    {data.topLossReasons.slice(0, 6).map((row) => {
                      const max = data.topLossReasons[0].totalMs || 1;
                      const pct = (row.totalMs / max) * 100;
                      const meta = DOWNTIME_REASON_META[row.reason];
                      return (
                        <li
                          key={row.reason}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 3,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 12,
                            }}
                          >
                            <span
                              style={{
                                color: meta.color,
                                fontWeight: 700,
                              }}
                            >
                              {meta.label}
                            </span>
                            <span
                              style={{
                                color: "var(--lb-text-3)",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {fmtDuration(row.totalMs)} · {row.count}×
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
                                background: meta.color,
                              }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>
          </section>

          {/* Recent alerts */}
          <Panel
            title="Recent alerts"
            subtitle="Last 10 events · open & resolved"
          >
            {data.recentAlerts.length === 0 ? (
              <Empty>No alerts yet — fleet is clean.</Empty>
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
                {data.recentAlerts.map((a) => {
                  const sev = ALERT_SEVERITY_META[a.severity];
                  const stat = ALERT_STATUS_META[a.status];
                  return (
                    <li
                      key={a.id}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        background: "var(--lb-bg)",
                        border: "1px solid var(--lb-border)",
                        borderLeft: `4px solid ${sev.color}`,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 800,
                          letterSpacing: 0.6,
                          textTransform: "uppercase",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: `${sev.color}22`,
                          color: sev.color,
                        }}
                      >
                        {sev.label}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        {a.title}
                      </span>
                      <Link
                        href={`/oee/machines/${a.machineId}`}
                        style={{
                          fontSize: 11.5,
                          color: "var(--lb-text-3)",
                          textDecoration: "none",
                        }}
                      >
                        on {a.machineName}
                      </Link>
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: `${stat.color}22`,
                          color: stat.color,
                          letterSpacing: 0.4,
                          textTransform: "uppercase",
                        }}
                      >
                        {stat.label}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--lb-text-3)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtDuration(Date.now() - a.raisedAt.getTime())} ago
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
  color,
  big,
}: {
  label: string;
  value: string;
  hint?: string;
  color: string;
  big?: boolean;
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
          fontSize: big ? 32 : 26,
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

function StatBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          fontSize: 9,
          color: "var(--lb-text-3)",
          fontWeight: 800,
          letterSpacing: 0.4,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{label}</span>
        <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
          {fmtPct(value)}
        </span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: "var(--lb-bg-elev)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(value * 100)}%`,
            height: "100%",
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 12px",
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
