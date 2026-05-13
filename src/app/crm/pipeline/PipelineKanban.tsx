"use client";

// Kanban view of every opportunity by stage. Each card is draggable between
// columns; dropping it triggers updateOpportunity with the new stage. Also
// supports keyboard "Move to ▾" menu for accessibility.

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CrmOpportunity } from "@/db/schema";
import { updateOpportunity } from "../actions";
import { STAGE_META, STAGE_ORDER } from "../constants";

type PipelineOpp = CrmOpportunity & { accountName: string };

function fmtUsd(n: number) {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export default function PipelineKanban({
  opportunities,
}: {
  opportunities: PipelineOpp[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<
    CrmOpportunity["stage"] | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);

  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  const byStage = useMemo(() => {
    const m = new Map<CrmOpportunity["stage"], PipelineOpp[]>();
    for (const s of STAGE_ORDER) m.set(s, []);
    for (const o of opportunities) {
      m.get(o.stage)?.push(o);
    }
    // Sort each column by amount desc
    for (const list of m.values()) {
      list.sort((a, b) => Number(b.amountUsd) - Number(a.amountUsd));
    }
    return m;
  }, [opportunities]);

  function moveTo(id: number, stage: CrmOpportunity["stage"]) {
    startTransition(async () => {
      try {
        await updateOpportunity(id, { stage });
        router.refresh();
        ping(`Moved to ${STAGE_META[stage].label}`);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Move failed");
      }
    });
  }

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
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

      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
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
            Pipeline
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
            }}
          >
            Drag a card between columns to move it through stages. Click the
            account name to open the full Customer 360 record.
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

      <div
        style={{
          display: "flex",
          gap: 12,
          overflowX: "auto",
          paddingBottom: 8,
        }}
      >
        {STAGE_ORDER.map((stage) => {
          const meta = STAGE_META[stage];
          const list = byStage.get(stage) ?? [];
          const total = list.reduce((s, o) => s + Number(o.amountUsd), 0);
          const isDragOver = dragOverStage === stage;
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStage(stage);
              }}
              onDragLeave={() => {
                if (dragOverStage === stage) setDragOverStage(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverStage(null);
                if (draggedId !== null) {
                  const o = opportunities.find((x) => x.id === draggedId);
                  if (o && o.stage !== stage) moveTo(draggedId, stage);
                  setDraggedId(null);
                }
              }}
              style={{
                flex: "0 0 280px",
                minHeight: 400,
                padding: 10,
                borderRadius: 14,
                background: "var(--lb-bg-elev)",
                border: isDragOver
                  ? `2px dashed ${meta.color}`
                  : `1px solid var(--lb-border)`,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                transition: "border-color 140ms ease",
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: `${meta.color}15`,
                  borderBottom: `2px solid ${meta.color}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: meta.color,
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 800,
                    color: meta.color,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  {meta.label}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 11,
                    color: "var(--lb-text-3)",
                  }}
                >
                  {list.length} · {fmtUsd(total)}
                </span>
              </header>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  flex: 1,
                }}
              >
                {list.length === 0 ? (
                  <li
                    style={{
                      padding: "20px 12px",
                      borderRadius: 8,
                      border: "1px dashed var(--lb-border)",
                      textAlign: "center",
                      color: "var(--lb-text-3)",
                      fontSize: 12,
                    }}
                  >
                    Drop here to move
                  </li>
                ) : (
                  list.map((o) => (
                    <PipelineCard
                      key={o.id}
                      opp={o}
                      onDragStart={() => setDraggedId(o.id)}
                      onDragEnd={() => {
                        setDraggedId(null);
                        setDragOverStage(null);
                      }}
                      onMove={(s) => moveTo(o.id, s)}
                    />
                  ))
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineCard({
  opp,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  opp: PipelineOpp;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (s: CrmOpportunity["stage"]) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = STAGE_META[opp.stage];
  const amount = Number(opp.amountUsd);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      style={{
        padding: 10,
        borderRadius: 10,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${meta.color}`,
        cursor: "grab",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        position: "relative",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "var(--lb-text)",
          lineHeight: 1.3,
        }}
      >
        {opp.title}
      </div>
      <Link
        href={`/crm/accounts/${opp.accountId}`}
        style={{
          fontSize: 11.5,
          color: "var(--lb-text-3)",
          textDecoration: "none",
        }}
      >
        {opp.accountName}
      </Link>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          marginTop: 2,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "var(--lb-text)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtUsd(amount)}
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--lb-text-3)",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {opp.probability}%
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Move to stage"
          style={{
            padding: "2px 8px",
            borderRadius: 5,
            background: "transparent",
            color: "var(--lb-text-3)",
            border: "1px solid var(--lb-border)",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Move ▾
        </button>
      </div>
      {menuOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            padding: 6,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            zIndex: 10,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            minWidth: 160,
          }}
          onMouseLeave={() => setMenuOpen(false)}
        >
          {STAGE_ORDER.filter((s) => s !== opp.stage).map((s) => {
            const m = STAGE_META[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onMove(s);
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "transparent",
                  color: m.color,
                  border: "1px solid transparent",
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                → {m.label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}
