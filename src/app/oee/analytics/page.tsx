import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewOee } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getOeeDashboard, computeOeeForWindow, listMyMachines } from "../actions";
import {
  DOWNTIME_REASON_META,
  STATUS_META,
  fmtDuration,
  fmtPct,
  oeeBand,
} from "../constants";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Analytics — OEE — ${CLIENT_CONFIG.name}`,
};

const WINDOW_DAYS = 7;

export default async function OeeAnalyticsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewOee(profile)) redirect("/");

  // Two windows so we can compare: last 24h (live) and last 7 days (trend).
  const [machines, dashboard24h, dashboard7d] = await Promise.all([
    listMyMachines(),
    getOeeDashboard(24),
    getOeeDashboard(WINDOW_DAYS * 24),
  ]);

  // Daily OEE for the last 7 days (computed per-day from the existing data).
  // For each day, average each machine's OEE that day; then average machines
  // weighted by run-time. This is a cheap "trend" — for prod we'd cache it.
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const days: Array<{ label: string; oee: number }> = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const end = new Date(now.getTime() - i * dayMs);
    const start = new Date(end.getTime() - dayMs);
    let runMs = 0;
    let weighted = 0;
    for (const m of machines) {
      const b = await computeOeeForWindow(m.id, start, end);
      runMs += b.runTimeMs;
      weighted += b.oee * b.runTimeMs;
    }
    const oee = runMs > 0 ? weighted / runMs : 0;
    days.push({
      label: start.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      oee,
    });
  }
  const maxBar = Math.max(0.001, ...days.map((d) => d.oee));

  // Rank machines by 24h OEE
  const ranked = [...dashboard24h.machines].sort(
    (a, b) => b.breakdown.oee - a.breakdown.oee,
  );

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
            OEE Analytics
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
              maxWidth: 720,
            }}
          >
            Multi-day fleet trend, machine ranking, and loss-reason mix —
            measure where time is actually being lost so you can attack the
            biggest bucket first.
          </p>
        </div>
        <Link
          href="/oee"
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

      {/* KPI row */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <KpiTile
          label="OEE — last 24h"
          value={fmtPct(dashboard24h.fleet.oee, 1)}
          hint={oeeBand(dashboard24h.fleet.oee).label}
          color={oeeBand(dashboard24h.fleet.oee).color}
          big
        />
        <KpiTile
          label="OEE — last 7d"
          value={fmtPct(dashboard7d.fleet.oee, 1)}
          hint={oeeBand(dashboard7d.fleet.oee).label}
          color={oeeBand(dashboard7d.fleet.oee).color}
        />
        <KpiTile
          label="Unplanned (7d)"
          value={fmtDuration(dashboard7d.fleet.unplannedDowntimeMs)}
          hint="across the fleet"
          color="#dc2626"
        />
        <KpiTile
          label="Planned (7d)"
          value={fmtDuration(dashboard7d.fleet.plannedDowntimeMs)}
          hint="setup / changeover / maint."
          color="#ca8a04"
        />
        <KpiTile
          label="Good parts (7d)"
          value={dashboard7d.fleet.goodCount.toLocaleString()}
          hint={`${dashboard7d.fleet.totalCount.toLocaleString()} produced`}
          color="#16a34a"
        />
      </section>

      {/* Trend chart + Top loss reasons */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: 12,
        }}
      >
        <Panel
          title="Daily OEE — last 7 days"
          subtitle="Weighted by run-time across the fleet"
        >
          {days.every((d) => d.oee === 0) ? (
            <Empty>No production data in the last 7 days yet.</Empty>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 8,
                height: 220,
              }}
            >
              {days.map((d) => {
                const heightPct = (d.oee / maxBar) * 100;
                const band = oeeBand(d.oee);
                return (
                  <div
                    key={d.label}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        flex: 1,
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-end",
                        position: "relative",
                      }}
                    >
                      <div
                        title={`${d.label} · ${fmtPct(d.oee, 1)}`}
                        style={{
                          width: "100%",
                          height: `${Math.max(heightPct, 4)}%`,
                          background: band.color,
                          borderRadius: "6px 6px 0 0",
                          minHeight: 4,
                          transition: "height 200ms ease",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: band.color,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtPct(d.oee, 0)}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--lb-text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.label}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel
          title="Top loss reasons — last 7d"
          subtitle="Hours lost by reason — attack the biggest bucket first"
        >
          {dashboard7d.topLossReasons.length === 0 ? (
            <Empty>No downtime recorded.</Empty>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {dashboard7d.topLossReasons.map((row) => {
                const max = dashboard7d.topLossReasons[0].totalMs || 1;
                const pct = (row.totalMs / max) * 100;
                const meta = DOWNTIME_REASON_META[row.reason];
                return (
                  <li
                    key={row.reason}
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
                        fontSize: 12.5,
                      }}
                    >
                      <span
                        style={{
                          color: meta.color,
                          fontWeight: 700,
                        }}
                      >
                        {meta.label}{" "}
                        <span
                          style={{
                            color: "var(--lb-text-3)",
                            fontWeight: 500,
                            fontSize: 11,
                          }}
                        >
                          · {meta.category}
                        </span>
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
                        height: 8,
                        borderRadius: 4,
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
      </section>

      {/* Machine ranking */}
      <Panel
        title="Machine ranking — last 24h OEE"
        subtitle="Sorted high → low. Click a row to drill in."
      >
        {ranked.length === 0 ? (
          <Empty>No machines yet.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Machine</Th>
                  <Th>Status</Th>
                  <Th style={{ textAlign: "right" }}>OEE</Th>
                  <Th style={{ textAlign: "right" }}>A</Th>
                  <Th style={{ textAlign: "right" }}>P</Th>
                  <Th style={{ textAlign: "right" }}>Q</Th>
                  <Th style={{ textAlign: "right" }}>Good / Total</Th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, i) => {
                  const sm = STATUS_META[row.machine.status];
                  const band = oeeBand(row.breakdown.oee);
                  return (
                    <tr
                      key={row.machine.id}
                      style={{ borderTop: "1px solid var(--lb-border)" }}
                    >
                      <Td
                        style={{
                          color: "var(--lb-text-3)",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 700,
                        }}
                      >
                        {i + 1}
                      </Td>
                      <Td>
                        <Link
                          href={`/oee/machines/${row.machine.id}`}
                          style={{
                            color: "inherit",
                            textDecoration: "none",
                            fontWeight: 700,
                          }}
                        >
                          {row.machine.name}
                        </Link>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--lb-text-3)",
                          }}
                        >
                          {row.machine.line ?? "—"} ·{" "}
                          {row.machine.code ?? "no code"}
                        </div>
                      </Td>
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${sm.color}22`,
                            color: sm.color,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {sm.label}
                        </span>
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 800,
                          color: band.color,
                        }}
                      >
                        {fmtPct(row.breakdown.oee, 1)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtPct(row.breakdown.availability)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtPct(row.breakdown.performance)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtPct(row.breakdown.quality)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--lb-text-2)",
                        }}
                      >
                        {row.breakdown.goodCount} /{" "}
                        {row.breakdown.totalCount}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
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

function Th({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 10px",
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--lb-text-3)",
        borderBottom: "1px solid var(--lb-border)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        padding: "10px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}
