"use client";

// Cross-machine alert queue. Each row supports inline acknowledge, resolve,
// and "→ CRM" escalation (creates a high-priority CRM ticket on the
// machine's linked CRM account, or on an internal "Shop Floor" account).

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OeeAlert } from "@/db/schema";
import {
  acknowledgeAlert,
  deleteAlert,
  escalateAlertToCrm,
  resolveAlert,
} from "../actions";
import { ALERT_SEVERITY_META, ALERT_STATUS_META, fmtDuration } from "../constants";

type Row = OeeAlert & { machineName: string; machineId: number };

const STATUS_ORDER: Array<OeeAlert["status"]> = [
  "open",
  "acknowledged",
  "resolved",
  "escalated",
];

const SEVERITY_ORDER: Array<OeeAlert["severity"]> = [
  "critical",
  "warning",
  "info",
];

export default function AlertsTable({ alerts }: { alerts: Row[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OeeAlert["status"] | "all">("all");
  const [severity, setSeverity] = useState<OeeAlert["severity"] | "all">("all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const statusCounts = useMemo(() => {
    const m = new Map<OeeAlert["status"], number>();
    for (const t of alerts) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return m;
  }, [alerts]);

  const sevCounts = useMemo(() => {
    const m = new Map<OeeAlert["severity"], number>();
    for (const t of alerts) m.set(t.severity, (m.get(t.severity) ?? 0) + 1);
    return m;
  }, [alerts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts.filter((a) => {
      if (status !== "all" && a.status !== status) return false;
      if (severity !== "all" && a.severity !== severity) return false;
      if (
        q &&
        !`${a.title} ${a.machineName} ${a.code}`.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [alerts, query, status, severity]);

  function withBusy(id: number, label: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
        ping(label);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    });
  }

  async function escalate(id: number) {
    setBusyId(id);
    startTransition(async () => {
      try {
        const { ticketId, accountId } = await escalateAlertToCrm(id);
        router.refresh();
        ping(`Created ticket #${ticketId} on account ${accountId}.`);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Escalation failed");
      } finally {
        setBusyId(null);
      }
    });
  }

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

      <section
        style={{
          padding: "12px 16px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, machine, code…"
          style={{
            flex: 1,
            minWidth: 220,
            padding: "9px 14px",
            borderRadius: 999,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13.5,
          }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill
            label={`All status (${alerts.length})`}
            active={status === "all"}
            color="var(--lb-text-2)"
            onClick={() => setStatus("all")}
          />
          {STATUS_ORDER.map((s) => {
            const m = ALERT_STATUS_META[s];
            const c = statusCounts.get(s) ?? 0;
            return (
              <Pill
                key={s}
                label={`${m.label} (${c})`}
                active={status === s}
                color={m.color}
                onClick={() => setStatus(s)}
              />
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill
            label="All severity"
            active={severity === "all"}
            color="var(--lb-text-2)"
            onClick={() => setSeverity("all")}
          />
          {SEVERITY_ORDER.map((s) => {
            const m = ALERT_SEVERITY_META[s];
            const c = sevCounts.get(s) ?? 0;
            return (
              <Pill
                key={s}
                label={`${m.label} (${c})`}
                active={severity === s}
                color={m.color}
                onClick={() => setSeverity(s)}
              />
            );
          })}
        </div>
      </section>

      <section
        style={{
          padding: "16px 20px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "32px 20px",
              borderRadius: 10,
              border: "1px dashed var(--lb-border)",
              textAlign: "center",
              color: "var(--lb-text-2)",
              fontSize: 13.5,
            }}
          >
            {alerts.length === 0
              ? "No alerts yet — fleet is clean."
              : "No alerts match the current filters."}
          </div>
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
                  <Th>Severity</Th>
                  <Th>Title</Th>
                  <Th>Machine</Th>
                  <Th>Raised</Th>
                  <Th>Status</Th>
                  <Th style={{ textAlign: "right" }}>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const sev = ALERT_SEVERITY_META[a.severity];
                  const stat = ALERT_STATUS_META[a.status];
                  const busy = busyId === a.id;
                  const escalated = a.status === "escalated";
                  return (
                    <tr
                      key={a.id}
                      style={{
                        borderTop: "1px solid var(--lb-border)",
                        opacity: busy ? 0.55 : 1,
                      }}
                    >
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${sev.color}22`,
                            color: sev.color,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {sev.label}
                        </span>
                      </Td>
                      <Td>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 1,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>{a.title}</span>
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--lb-text-3)",
                            }}
                          >
                            {a.code}
                            {a.body && ` · ${a.body}`}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <Link
                          href={`/oee/machines/${a.machineId}`}
                          style={{
                            color: "var(--lb-accent)",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          {a.machineName}
                        </Link>
                      </Td>
                      <Td
                        style={{
                          color: "var(--lb-text-3)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtDuration(Date.now() - a.raisedAt.getTime())} ago
                      </Td>
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${stat.color}22`,
                            color: stat.color,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {stat.label}
                        </span>
                        {a.crmTicketId && (
                          <Link
                            href="/crm/tickets"
                            style={{
                              fontSize: 10.5,
                              marginLeft: 6,
                              color: "var(--lb-accent)",
                              fontWeight: 600,
                              textDecoration: "none",
                            }}
                          >
                            ticket #{a.crmTicketId}
                          </Link>
                        )}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                            flexWrap: "wrap",
                          }}
                        >
                          {a.status === "open" && (
                            <button
                              type="button"
                              onClick={() =>
                                withBusy(a.id, "Acknowledged", () =>
                                  acknowledgeAlert(a.id),
                                )
                              }
                              disabled={busy}
                              style={miniBtnStyle("#ca8a04")}
                            >
                              Ack
                            </button>
                          )}
                          {a.status !== "resolved" && a.status !== "escalated" && (
                            <button
                              type="button"
                              onClick={() =>
                                withBusy(a.id, "Resolved", () =>
                                  resolveAlert(a.id),
                                )
                              }
                              disabled={busy}
                              style={miniBtnStyle("#16a34a")}
                            >
                              Resolve
                            </button>
                          )}
                          {!escalated && (
                            <button
                              type="button"
                              onClick={() => escalate(a.id)}
                              disabled={busy}
                              style={miniBtnStyle("#7c3aed")}
                              title="Create a CRM ticket from this alert"
                            >
                              → CRM
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (!confirm("Delete this alert?")) return;
                              withBusy(a.id, "Deleted", () => deleteAlert(a.id));
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
      </section>
    </>
  );
}

function Pill({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: 999,
        background: active ? color : "var(--lb-bg)",
        color: active ? "#fff" : color,
        border: active ? `1px solid ${color}` : `1px solid ${color}55`,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
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

function miniBtnStyle(color: string): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    background: `${color}15`,
    color,
    border: `1px solid ${color}55`,
    fontSize: 10.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}
