"use client";

// Cross-account tickets table. Each row shows subject, account link,
// priority pill, inline status changer (open → in-progress → resolved →
// closed), and a delete button. Search filters on subject + account name;
// status and priority pills filter by exact match.

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CrmTicket } from "@/db/schema";
import { deleteTicket, updateTicket } from "../actions";
import { TICKET_PRIORITY_META, TICKET_STATUS_META } from "../constants";

type Row = CrmTicket & { accountName: string };

const STATUS_ORDER: Array<CrmTicket["status"]> = [
  "open",
  "in-progress",
  "resolved",
  "closed",
];

const PRIORITY_ORDER: Array<CrmTicket["priority"]> = [
  "urgent",
  "high",
  "medium",
  "low",
];

export default function TicketsTable({ tickets }: { tickets: Row[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CrmTicket["status"] | "all">("all");
  const [priority, setPriority] = useState<CrmTicket["priority"] | "all">(
    "all",
  );
  const [busyId, setBusyId] = useState<number | null>(null);

  const statusCounts = useMemo(() => {
    const m = new Map<CrmTicket["status"], number>();
    for (const t of tickets) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return m;
  }, [tickets]);

  const priorityCounts = useMemo(() => {
    const m = new Map<CrmTicket["priority"], number>();
    for (const t of tickets) m.set(t.priority, (m.get(t.priority) ?? 0) + 1);
    return m;
  }, [tickets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (status !== "all" && t.status !== status) return false;
      if (priority !== "all" && t.priority !== priority) return false;
      if (
        q &&
        !`${t.subject} ${t.accountName} ${t.body ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [tickets, query, status, priority]);

  function changeStatus(id: number, next: CrmTicket["status"]) {
    setBusyId(id);
    startTransition(async () => {
      try {
        await updateTicket(id, { status: next });
        router.refresh();
      } catch (e) {
        console.error(e);
      } finally {
        setBusyId(null);
      }
    });
  }

  function changePriority(id: number, next: CrmTicket["priority"]) {
    setBusyId(id);
    startTransition(async () => {
      try {
        await updateTicket(id, { priority: next });
        router.refresh();
      } catch (e) {
        console.error(e);
      } finally {
        setBusyId(null);
      }
    });
  }

  function remove(id: number) {
    if (!confirm("Delete this ticket? This cannot be undone.")) return;
    setBusyId(id);
    startTransition(async () => {
      try {
        await deleteTicket(id);
        router.refresh();
      } catch (e) {
        console.error(e);
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <>
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
          placeholder="Search subject, account, body…"
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
          <FilterPill
            label={`All status (${tickets.length})`}
            active={status === "all"}
            color="var(--lb-text-2)"
            onClick={() => setStatus("all")}
          />
          {STATUS_ORDER.map((s) => {
            const m = TICKET_STATUS_META[s];
            const c = statusCounts.get(s) ?? 0;
            return (
              <FilterPill
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
          <FilterPill
            label="All priority"
            active={priority === "all"}
            color="var(--lb-text-2)"
            onClick={() => setPriority("all")}
          />
          {PRIORITY_ORDER.map((p) => {
            const m = TICKET_PRIORITY_META[p];
            const c = priorityCounts.get(p) ?? 0;
            return (
              <FilterPill
                key={p}
                label={`${m.label} (${c})`}
                active={priority === p}
                color={m.color}
                onClick={() => setPriority(p)}
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
            {tickets.length === 0
              ? "No tickets yet. Open an account and use the Tickets tab to create one."
              : "No tickets match the current filters."}
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
                  <Th>Subject</Th>
                  <Th>Account</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th>Updated</Th>
                  <Th style={{ textAlign: "right" }}>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const sm = TICKET_STATUS_META[t.status];
                  const pm = TICKET_PRIORITY_META[t.priority];
                  const busy = busyId === t.id;
                  return (
                    <tr
                      key={t.id}
                      style={{
                        borderTop: "1px solid var(--lb-border)",
                        opacity: busy ? 0.55 : 1,
                      }}
                    >
                      <Td>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 2,
                            maxWidth: 380,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>{t.subject}</span>
                          {t.body && (
                            <span
                              style={{
                                fontSize: 11.5,
                                color: "var(--lb-text-3)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {t.body}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <Link
                          href={`/crm/accounts/${t.accountId}`}
                          style={{
                            color: "var(--lb-accent)",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          {t.accountName}
                        </Link>
                      </Td>
                      <Td>
                        <select
                          value={t.priority}
                          disabled={busy}
                          onChange={(e) =>
                            changePriority(
                              t.id,
                              e.target.value as CrmTicket["priority"],
                            )
                          }
                          style={{
                            padding: "3px 8px",
                            borderRadius: 5,
                            background: `${pm.color}22`,
                            color: pm.color,
                            border: `1px solid ${pm.color}55`,
                            fontSize: 11,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                            cursor: "pointer",
                          }}
                        >
                          {PRIORITY_ORDER.map((p) => (
                            <option key={p} value={p}>
                              {TICKET_PRIORITY_META[p].label}
                            </option>
                          ))}
                        </select>
                      </Td>
                      <Td>
                        <select
                          value={t.status}
                          disabled={busy}
                          onChange={(e) =>
                            changeStatus(
                              t.id,
                              e.target.value as CrmTicket["status"],
                            )
                          }
                          style={{
                            padding: "3px 8px",
                            borderRadius: 5,
                            background: `${sm.color}22`,
                            color: sm.color,
                            border: `1px solid ${sm.color}55`,
                            fontSize: 11,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                            cursor: "pointer",
                          }}
                        >
                          {STATUS_ORDER.map((s) => (
                            <option key={s} value={s}>
                              {TICKET_STATUS_META[s].label}
                            </option>
                          ))}
                        </select>
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {new Date(t.updatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={() => remove(t.id)}
                          disabled={busy}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 6,
                            background: "transparent",
                            color: "var(--lb-text-3)",
                            border: "1px solid var(--lb-border)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: busy ? "wait" : "pointer",
                          }}
                        >
                          Delete
                        </button>
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

function FilterPill({
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
