"use client";

// Live machine detail. Four tabs:
//   Status   — current run + open downtime + quick actions (start/end run,
//              open/close downtime, log scrap/rework)
//   Runs     — scheduled + actual production runs ledger
//   Downtime — every downtime event with reason + duration
//   Quality  — scrap / rework / defect events
//
// Every action saves via a server action and refreshes the route so the
// OEE breakdown at the top updates without a manual reload.

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  OeeAlert,
  OeeDowntimeEvent,
  OeeMachine,
  OeeQualityEvent,
  OeeRun,
} from "@/db/schema";
import {
  ALERT_SEVERITY_META,
  ALERT_STATUS_META,
  DOWNTIME_REASON_META,
  DOWNTIME_REASON_ORDER,
  QUALITY_TYPE_META,
  STATUS_META,
  fmtDuration,
  fmtPct,
  oeeBand,
} from "../../constants";
import type { OeeBreakdown } from "../../actions";
import {
  closeDowntime,
  createRun,
  deleteDowntime,
  deleteMachine,
  deleteQuality,
  deleteRun,
  endRun,
  recordDowntime,
  recordQuality,
  startRun,
  updateMachine,
  updateRunCounts,
} from "../../actions";

type Tab = "status" | "runs" | "downtime" | "quality";

export default function MachineDetail({
  machine,
  runs,
  downtime,
  quality,
  alerts,
  breakdown24h,
}: {
  machine: OeeMachine;
  runs: OeeRun[];
  downtime: OeeDowntimeEvent[];
  quality: OeeQualityEvent[];
  alerts: OeeAlert[];
  breakdown24h: OeeBreakdown;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("status");
  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }

  function run<T>(fn: () => Promise<T>, label: string) {
    setBusy(true);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
        if (label) ping(label);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusy(false);
      }
    });
  }

  const sm = STATUS_META[machine.status];
  const band = oeeBand(breakdown24h.oee);
  const currentRun = runs.find((r) => r.actualStart && !r.actualEnd) ?? null;
  const openDowntime = downtime.find((d) => !d.endAt) ?? null;

  return (
    <>
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "10px 16px",
            borderRadius: 8,
            background: "rgba(15,23,42,0.95)",
            color: "#fff",
            fontSize: 13,
            zIndex: 80,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          }}
        >
          {toast}
        </div>
      )}

      {/* Hero */}
      <header
        style={{
          padding: 18,
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderLeft: `4px solid ${sm.color}`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <input
            value={machine.name}
            onChange={(e) =>
              run(
                () => updateMachine(machine.id, { name: e.target.value }),
                "",
              )
            }
            style={{
              background: "transparent",
              border: 0,
              fontSize: "clamp(20px, 2.4vw, 26px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: "var(--lb-text)",
              padding: 0,
              outline: "none",
              minWidth: 200,
            }}
          />
          <select
            value={machine.status}
            onChange={(e) =>
              run(
                () =>
                  updateMachine(machine.id, {
                    status: e.target.value as OeeMachine["status"],
                  }),
                `Status: ${e.target.value}`,
              )
            }
            style={{
              padding: "4px 8px",
              borderRadius: 5,
              background: `${sm.color}22`,
              color: sm.color,
              border: `1px solid ${sm.color}55`,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {(
              [
                "running",
                "idle",
                "down",
                "maintenance",
                "offline",
              ] as OeeMachine["status"][]
            ).map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (
                !confirm("Delete this machine and all its runs/events/alerts?")
              )
                return;
              run(async () => {
                await deleteMachine(machine.id);
                router.push("/oee/machines");
              }, "Deleted");
            }}
            disabled={busy}
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              borderRadius: 999,
              background: "transparent",
              color: "#ef4444",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Delete
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            fontSize: 12,
            color: "var(--lb-text-3)",
          }}
        >
          <span>Code: {machine.code ?? "—"}</span>
          <span>Line: {machine.line ?? "—"}</span>
          <span>Location: {machine.location ?? "—"}</span>
          <span>
            Ideal cycle: {Number(machine.idealCycleSeconds).toFixed(1)}s/unit
          </span>
        </div>
      </header>

      {/* 24h breakdown */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <Kpi
          label="OEE (24h)"
          value={fmtPct(breakdown24h.oee, 1)}
          hint={band.label}
          color={band.color}
          big
        />
        <Kpi
          label="Availability"
          value={fmtPct(breakdown24h.availability)}
          hint={`${fmtDuration(breakdown24h.unplannedDowntimeMs)} unplanned`}
          color="#0891b2"
        />
        <Kpi
          label="Performance"
          value={fmtPct(breakdown24h.performance)}
          hint={`${breakdown24h.goodCount} good · ${fmtDuration(
            breakdown24h.runTimeMs,
          )} run`}
          color="#7c3aed"
        />
        <Kpi
          label="Quality"
          value={fmtPct(breakdown24h.quality)}
          hint={`${breakdown24h.goodCount}/${breakdown24h.totalCount} good`}
          color="#16a34a"
        />
      </section>

      {/* Tab strip */}
      <nav
        style={{
          display: "flex",
          gap: 6,
          padding: 4,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 999,
          width: "fit-content",
        }}
      >
        {(
          [
            ["status", "Status"],
            ["runs", `Runs (${runs.length})`],
            ["downtime", `Downtime (${downtime.length})`],
            ["quality", `Quality (${quality.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background:
                tab === k ? "var(--lb-accent)" : "transparent",
              color:
                tab === k ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
              border: 0,
              fontSize: 12.5,
              fontWeight: tab === k ? 700 : 500,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "status" && (
        <StatusTab
          machine={machine}
          currentRun={currentRun}
          openDowntime={openDowntime}
          alerts={alerts}
          busy={busy}
          run={run}
        />
      )}
      {tab === "runs" && (
        <RunsTab
          machineId={machine.id}
          runs={runs}
          busy={busy}
          run={run}
        />
      )}
      {tab === "downtime" && (
        <DowntimeTab
          machineId={machine.id}
          downtime={downtime}
          currentRunId={currentRun?.id ?? null}
          busy={busy}
          run={run}
        />
      )}
      {tab === "quality" && (
        <QualityTab
          machineId={machine.id}
          quality={quality}
          currentRunId={currentRun?.id ?? null}
          busy={busy}
          run={run}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS TAB — current run + open downtime + alerts + quick actions
// ─────────────────────────────────────────────────────────────────────────────

function StatusTab({
  machine,
  currentRun,
  openDowntime,
  alerts,
  busy,
  run,
}: {
  machine: OeeMachine;
  currentRun: OeeRun | null;
  openDowntime: OeeDowntimeEvent | null;
  alerts: OeeAlert[];
  busy: boolean;
  run: <T>(fn: () => Promise<T>, label: string) => void;
}) {
  const [reason, setReason] = useState<OeeDowntimeEvent["reason"]>("breakdown");
  const [downNotes, setDownNotes] = useState("");
  const [qtyGood, setQtyGood] = useState(currentRun?.goodCount ?? 0);
  const [qtyScrap, setQtyScrap] = useState(currentRun?.scrapCount ?? 0);
  const [qtyRework, setQtyRework] = useState(currentRun?.reworkCount ?? 0);

  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: 12,
      }}
    >
      <Panel title="Current run">
        {currentRun ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {currentRun.partNumber}
                {currentRun.partName && (
                  <span
                    style={{
                      color: "var(--lb-text-3)",
                      fontWeight: 500,
                      marginLeft: 6,
                    }}
                  >
                    {currentRun.partName}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--lb-text-3)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Started{" "}
                {fmtDuration(
                  Date.now() -
                    (currentRun.actualStart
                      ? currentRun.actualStart.getTime()
                      : Date.now()),
                )}{" "}
                ago · target {currentRun.targetCount}
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              <CountInput
                label="Good"
                value={qtyGood}
                color="#16a34a"
                onChange={setQtyGood}
              />
              <CountInput
                label="Scrap"
                value={qtyScrap}
                color="#dc2626"
                onChange={setQtyScrap}
              />
              <CountInput
                label="Rework"
                value={qtyRework}
                color="#ca8a04"
                onChange={setQtyRework}
              />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() =>
                  run(
                    () =>
                      updateRunCounts(currentRun.id, {
                        goodCount: qtyGood,
                        scrapCount: qtyScrap,
                        reworkCount: qtyRework,
                      }),
                    "Counts saved",
                  )
                }
                disabled={busy}
                style={primaryBtnStyle}
              >
                Save counts
              </button>
              <button
                type="button"
                onClick={() => run(() => endRun(currentRun.id), "Run ended")}
                disabled={busy}
                style={dangerBtnStyle}
              >
                End run
              </button>
            </div>
          </div>
        ) : (
          <Empty>
            No active run. Schedule one under the <b>Runs</b> tab, then click{" "}
            <i>Start</i> to begin counting OEE.
          </Empty>
        )}
      </Panel>

      <Panel title="Downtime control">
        {openDowntime ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                padding: 10,
                borderRadius: 8,
                background: `${DOWNTIME_REASON_META[openDowntime.reason].color}22`,
                color: DOWNTIME_REASON_META[openDowntime.reason].color,
                fontWeight: 700,
              }}
            >
              ⏸ {DOWNTIME_REASON_META[openDowntime.reason].label} for{" "}
              {fmtDuration(Date.now() - openDowntime.startAt.getTime())}
            </div>
            {openDowntime.notes && (
              <div style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
                {openDowntime.notes}
              </div>
            )}
            <button
              type="button"
              onClick={() =>
                run(() => closeDowntime(openDowntime.id), "Downtime closed")
              }
              disabled={busy}
              style={primaryBtnStyle}
            >
              ▶ Resume — close downtime
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <select
              value={reason}
              onChange={(e) =>
                setReason(e.target.value as OeeDowntimeEvent["reason"])
              }
              style={inputStyle}
            >
              {DOWNTIME_REASON_ORDER.map((r) => (
                <option key={r} value={r}>
                  {DOWNTIME_REASON_META[r].label} (
                  {DOWNTIME_REASON_META[r].category})
                </option>
              ))}
            </select>
            <input
              type="text"
              value={downNotes}
              onChange={(e) => setDownNotes(e.target.value)}
              placeholder="Notes (optional)…"
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => {
                const category = DOWNTIME_REASON_META[reason].category;
                run(
                  () =>
                    recordDowntime({
                      machineId: machine.id,
                      runId: currentRun?.id ?? null,
                      reason,
                      category,
                      notes: downNotes,
                    }),
                  "Downtime recorded",
                );
                setDownNotes("");
              }}
              disabled={busy}
              style={dangerBtnStyle}
            >
              ⏸ Mark machine down
            </button>
          </div>
        )}
      </Panel>

      <Panel title="Recent alerts">
        {alerts.length === 0 ? (
          <Empty>No alerts on this machine.</Empty>
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
            {alerts.slice(0, 6).map((a) => {
              const sev = ALERT_SEVERITY_META[a.severity];
              const stat = ALERT_STATUS_META[a.status];
              return (
                <li
                  key={a.id}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    borderLeft: `4px solid ${sev.color}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
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
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {a.title}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
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
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--lb-text-3)",
                      marginTop: 2,
                    }}
                  >
                    {fmtDuration(Date.now() - a.raisedAt.getTime())} ago
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Link
          href="/oee/alerts"
          style={{
            fontSize: 11.5,
            color: "var(--lb-accent)",
            textDecoration: "none",
            fontWeight: 600,
            marginTop: 4,
          }}
        >
          → Open alert queue
        </Link>
      </Panel>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNS TAB
// ─────────────────────────────────────────────────────────────────────────────

function RunsTab({
  machineId,
  runs,
  busy,
  run,
}: {
  machineId: number;
  runs: OeeRun[];
  busy: boolean;
  run: <T>(fn: () => Promise<T>, label: string) => void;
}) {
  const [partNumber, setPartNumber] = useState("");
  const [partName, setPartName] = useState("");
  const [target, setTarget] = useState(500);
  const [hours, setHours] = useState(8);

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <Panel title="Schedule a new run">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          <input
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            placeholder="Part number"
            style={inputStyle}
          />
          <input
            value={partName}
            onChange={(e) => setPartName(e.target.value)}
            placeholder="Part name (optional)"
            style={inputStyle}
          />
          <input
            type="number"
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            placeholder="Target count"
            style={inputStyle}
          />
          <input
            type="number"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            placeholder="Hours scheduled"
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (!partNumber.trim()) return;
            const start = new Date();
            const end = new Date(start.getTime() + hours * 3600_000);
            run(
              () =>
                createRun({
                  machineId,
                  partNumber,
                  partName: partName || undefined,
                  plannedStart: start,
                  plannedEnd: end,
                  targetCount: target,
                }),
              "Run scheduled",
            );
            setPartNumber("");
            setPartName("");
          }}
          disabled={busy || !partNumber.trim()}
          style={{ ...primaryBtnStyle, alignSelf: "flex-start" }}
        >
          + Schedule run
        </button>
      </Panel>

      <Panel title="Recent runs">
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th>Part</Th>
                  <Th>Planned</Th>
                  <Th>Actual</Th>
                  <Th style={{ textAlign: "right" }}>Good / Target</Th>
                  <Th style={{ textAlign: "right" }}>Scrap</Th>
                  <Th style={{ textAlign: "right" }}>Rework</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const isOpen = r.actualStart && !r.actualEnd;
                  return (
                    <tr
                      key={r.id}
                      style={{
                        borderTop: "1px solid var(--lb-border)",
                        background: isOpen
                          ? "rgba(22, 163, 74, 0.06)"
                          : "transparent",
                      }}
                    >
                      <Td>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 1,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>
                            {r.partNumber}
                          </span>
                          {r.partName && (
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--lb-text-3)",
                              }}
                            >
                              {r.partName}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {r.plannedStart.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {r.actualStart
                          ? r.actualStart.toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                        {r.actualEnd && (
                          <span style={{ color: "var(--lb-text-3)" }}>
                            {" → "}
                            {r.actualEnd.toLocaleString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        <b>{r.goodCount}</b> / {r.targetCount}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: r.scrapCount > 0 ? "#dc2626" : "inherit",
                        }}
                      >
                        {r.scrapCount}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: r.reworkCount > 0 ? "#ca8a04" : "inherit",
                        }}
                      >
                        {r.reworkCount}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                          }}
                        >
                          {!r.actualStart && (
                            <button
                              type="button"
                              onClick={() =>
                                run(() => startRun(r.id), "Run started")
                              }
                              disabled={busy}
                              style={miniBtnStyle("#16a34a")}
                            >
                              Start
                            </button>
                          )}
                          {isOpen && (
                            <button
                              type="button"
                              onClick={() =>
                                run(() => endRun(r.id), "Run ended")
                              }
                              disabled={busy}
                              style={miniBtnStyle("#ea580c")}
                            >
                              End
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (!confirm("Delete this run?")) return;
                              run(() => deleteRun(r.id), "Deleted");
                            }}
                            disabled={busy}
                            style={miniBtnStyle("#dc2626")}
                          >
                            ✕
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNTIME TAB
// ─────────────────────────────────────────────────────────────────────────────

function DowntimeTab({
  machineId,
  downtime,
  currentRunId,
  busy,
  run,
}: {
  machineId: number;
  downtime: OeeDowntimeEvent[];
  currentRunId: number | null;
  busy: boolean;
  run: <T>(fn: () => Promise<T>, label: string) => void;
}) {
  const [reason, setReason] = useState<OeeDowntimeEvent["reason"]>("setup");
  const [notes, setNotes] = useState("");

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="Record a downtime event">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "200px 1fr",
            gap: 8,
          }}
        >
          <select
            value={reason}
            onChange={(e) =>
              setReason(e.target.value as OeeDowntimeEvent["reason"])
            }
            style={inputStyle}
          >
            {DOWNTIME_REASON_ORDER.map((r) => (
              <option key={r} value={r}>
                {DOWNTIME_REASON_META[r].label} (
                {DOWNTIME_REASON_META[r].category})
              </option>
            ))}
          </select>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (e.g. tool break, material wait)…"
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const category = DOWNTIME_REASON_META[reason].category;
            run(
              () =>
                recordDowntime({
                  machineId,
                  runId: currentRunId,
                  reason,
                  category,
                  notes,
                }),
              "Recorded",
            );
            setNotes("");
          }}
          disabled={busy}
          style={{ ...dangerBtnStyle, alignSelf: "flex-start" }}
        >
          ⏸ Open downtime
        </button>
      </Panel>

      <Panel title="Downtime ledger">
        {downtime.length === 0 ? (
          <Empty>No downtime recorded.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th>Reason</Th>
                  <Th>Category</Th>
                  <Th>Start</Th>
                  <Th>Duration</Th>
                  <Th>Notes</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {downtime.map((d) => {
                  const meta = DOWNTIME_REASON_META[d.reason];
                  const isOpen = !d.endAt;
                  const ms = (d.endAt ?? new Date()).getTime() - d.startAt.getTime();
                  return (
                    <tr
                      key={d.id}
                      style={{ borderTop: "1px solid var(--lb-border)" }}
                    >
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${meta.color}22`,
                            color: meta.color,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {meta.label}
                        </span>
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {d.category}
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {d.startAt.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Td>
                      <Td
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: isOpen ? "#dc2626" : "inherit",
                          fontWeight: isOpen ? 700 : 500,
                        }}
                      >
                        {fmtDuration(ms)}
                        {isOpen && (
                          <span
                            style={{ fontSize: 10, marginLeft: 6, fontWeight: 800 }}
                          >
                            OPEN
                          </span>
                        )}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {d.notes || "—"}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                          }}
                        >
                          {isOpen && (
                            <button
                              type="button"
                              onClick={() =>
                                run(() => closeDowntime(d.id), "Closed")
                              }
                              disabled={busy}
                              style={miniBtnStyle("#16a34a")}
                            >
                              Resume
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (!confirm("Delete this downtime event?"))
                                return;
                              run(() => deleteDowntime(d.id), "Deleted");
                            }}
                            disabled={busy}
                            style={miniBtnStyle("#dc2626")}
                          >
                            ✕
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY TAB
// ─────────────────────────────────────────────────────────────────────────────

function QualityTab({
  machineId,
  quality,
  currentRunId,
  busy,
  run,
}: {
  machineId: number;
  quality: OeeQualityEvent[];
  currentRunId: number | null;
  busy: boolean;
  run: <T>(fn: () => Promise<T>, label: string) => void;
}) {
  const [type, setType] = useState<OeeQualityEvent["type"]>("scrap");
  const [qty, setQty] = useState(1);
  const [defectCode, setDefectCode] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="Log a quality event">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "120px 80px 1fr 1fr",
            gap: 8,
          }}
        >
          <select
            value={type}
            onChange={(e) =>
              setType(e.target.value as OeeQualityEvent["type"])
            }
            style={inputStyle}
          >
            {(["scrap", "rework", "defect"] as const).map((t) => (
              <option key={t} value={t}>
                {QUALITY_TYPE_META[t].label}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={qty}
            min={1}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
            style={inputStyle}
          />
          <input
            value={defectCode}
            onChange={(e) => setDefectCode(e.target.value)}
            placeholder="Defect code (optional)"
            style={inputStyle}
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes…"
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            run(
              () =>
                recordQuality({
                  machineId,
                  runId: currentRunId,
                  type,
                  quantity: qty,
                  defectCode,
                  notes,
                }),
              "Logged",
            );
            setDefectCode("");
            setNotes("");
            setQty(1);
          }}
          disabled={busy}
          style={{ ...primaryBtnStyle, alignSelf: "flex-start" }}
        >
          + Log event
        </button>
      </Panel>

      <Panel title="Quality ledger">
        {quality.length === 0 ? (
          <Empty>No quality events recorded.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th>Type</Th>
                  <Th style={{ textAlign: "right" }}>Qty</Th>
                  <Th>Defect code</Th>
                  <Th>Notes</Th>
                  <Th>When</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {quality.map((q) => {
                  const meta = QUALITY_TYPE_META[q.type];
                  return (
                    <tr
                      key={q.id}
                      style={{ borderTop: "1px solid var(--lb-border)" }}
                    >
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${meta.color}22`,
                            color: meta.color,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {meta.label}
                        </span>
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {q.quantity}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {q.defectCode || "—"}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {q.notes || "—"}
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {q.occurredAt.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!confirm("Delete this quality event?"))
                              return;
                            run(() => deleteQuality(q.id), "Deleted");
                          }}
                          disabled={busy}
                          style={miniBtnStyle("#dc2626")}
                        >
                          ✕
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS + STYLES
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({
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
        padding: 14,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${color}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
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
          fontSize: big ? 28 : 22,
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 16,
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function CountInput({
  label,
  value,
  color,
  onChange,
}: {
  label: string;
  value: number;
  color: string;
  onChange: (n: number) => void;
}) {
  return (
    <label
      style={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      <span
        style={{
          fontSize: 10.5,
          color,
          fontWeight: 800,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={0}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        style={{
          ...inputStyle,
          borderLeft: `3px solid ${color}`,
          fontWeight: 700,
        }}
      />
    </label>
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
        padding: "8px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 13,
  outline: "none",
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  border: "1px solid var(--lb-accent)",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
};

const dangerBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  background: "rgba(220, 38, 38, 0.15)",
  color: "#dc2626",
  border: "1px solid rgba(220, 38, 38, 0.5)",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
};

function miniBtnStyle(color: string): React.CSSProperties {
  return {
    padding: "3px 9px",
    borderRadius: 6,
    background: `${color}15`,
    color,
    border: `1px solid ${color}55`,
    fontSize: 10.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}
