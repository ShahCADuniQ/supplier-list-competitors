"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CrmAccount } from "@/db/schema";
import { TIER_META, TIER_ORDER } from "../constants";

export default function AccountsTable({
  accounts,
}: {
  accounts: CrmAccount[];
}) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<CrmAccount["tier"] | "all">("all");

  const tierCounts = useMemo(() => {
    const m = new Map<CrmAccount["tier"], number>();
    for (const a of accounts) m.set(a.tier, (m.get(a.tier) ?? 0) + 1);
    return m;
  }, [accounts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (tier !== "all" && a.tier !== tier) return false;
      if (
        q &&
        !`${a.name} ${a.industry ?? ""} ${a.country ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [accounts, query, tier]);

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
          placeholder="Search by company, industry, country…"
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
          <TierPill
            label={`All (${accounts.length})`}
            active={tier === "all"}
            color="var(--lb-text-2)"
            onClick={() => setTier("all")}
          />
          {TIER_ORDER.map((t) => {
            const m = TIER_META[t];
            const c = tierCounts.get(t) ?? 0;
            return (
              <TierPill
                key={t}
                label={`${m.label} (${c})`}
                active={tier === t}
                color={m.color}
                onClick={() => setTier(t)}
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
            {accounts.length === 0
              ? "No accounts yet. Click + New account up top."
              : "No accounts match the current filters."}
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
                  <Th>Company</Th>
                  <Th>Tier</Th>
                  <Th>Industry</Th>
                  <Th>Country</Th>
                  <Th style={{ textAlign: "right" }}>Health</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const tm = TIER_META[a.tier];
                  return (
                    <tr
                      key={a.id}
                      style={{ borderTop: "1px solid var(--lb-border)" }}
                    >
                      <Td>
                        <Link
                          href={`/crm/accounts/${a.id}`}
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
                              width: 28,
                              height: 28,
                              borderRadius: 7,
                              background: `${tm.color}22`,
                              color: tm.color,
                              fontWeight: 800,
                              fontSize: 11.5,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            {a.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span style={{ fontWeight: 700 }}>{a.name}</span>
                        </Link>
                      </Td>
                      <Td>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: `${tm.color}22`,
                            color: tm.color,
                            fontWeight: 800,
                            letterSpacing: 0.6,
                            textTransform: "uppercase",
                          }}
                        >
                          {tm.label}
                        </span>
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {a.industry || "—"}
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {a.country || "—"}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <HealthBadge score={a.healthScore} />
                      </Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {new Date(a.updatedAt).toLocaleDateString(undefined, {
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

function HealthBadge({ score }: { score: number }) {
  const color =
    score >= 70 ? "#16a34a" : score >= 40 ? "#ca8a04" : "#dc2626";
  return (
    <span
      title={`Health ${score}/100`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 4,
          borderRadius: 999,
          background: "var(--lb-bg)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${score}%`,
            background: color,
          }}
        />
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {score}
      </span>
    </span>
  );
}

function TierPill({
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

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
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

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
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
