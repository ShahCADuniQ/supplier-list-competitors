"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { OeeMachine } from "@/db/schema";
import { STATUS_META, STATUS_ORDER } from "../constants";

export default function MachinesGrid({
  machines,
}: {
  machines: OeeMachine[];
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OeeMachine["status"] | "all">("all");

  const counts = useMemo(() => {
    const m = new Map<OeeMachine["status"], number>();
    for (const x of machines) m.set(x.status, (m.get(x.status) ?? 0) + 1);
    return m;
  }, [machines]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return machines.filter((m) => {
      if (status !== "all" && m.status !== status) return false;
      if (
        q &&
        !`${m.name} ${m.code ?? ""} ${m.line ?? ""} ${m.location ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [machines, query, status]);

  return (
    <>
      <section
        style={{
          padding: "12px 16px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, code, line, location…"
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
            label={`All (${machines.length})`}
            active={status === "all"}
            color="var(--lb-text-2)"
            onClick={() => setStatus("all")}
          />
          {STATUS_ORDER.map((s) => {
            const m = STATUS_META[s];
            const c = counts.get(s) ?? 0;
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
            {machines.length === 0
              ? "No machines yet. Click + New machine up top."
              : "No machines match the current filters."}
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
                  <Th>Name</Th>
                  <Th>Code</Th>
                  <Th>Line</Th>
                  <Th>Location</Th>
                  <Th>Status</Th>
                  <Th style={{ textAlign: "right" }}>
                    Ideal cycle (sec)
                  </Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const sm = STATUS_META[m.status];
                  return (
                    <tr
                      key={m.id}
                      style={{ borderTop: "1px solid var(--lb-border)" }}
                    >
                      <Td>
                        <Link
                          href={`/oee/machines/${m.id}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            color: "inherit",
                            textDecoration: "none",
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              background: sm.color,
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ fontWeight: 700 }}>{m.name}</span>
                        </Link>
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {m.code || "—"}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {m.line || "—"}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {m.location || "—"}
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
                            letterSpacing: 0.6,
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
                          color: "var(--lb-text-2)",
                        }}
                      >
                        {Number(m.idealCycleSeconds).toFixed(1)}
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {new Date(m.updatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
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
