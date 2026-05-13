"use client";

// Visual map of the CADuniQ six-stage platform, rendered as a compact flow of
// stage cards above a shared event-bus spine. Stage data lives in
// ./platform-stages.ts so server components can read it without crossing
// the client/server boundary.

import Link from "next/link";
import {
  STAGES,
  type PlatformStageId,
  type Stage,
} from "./platform-stages";

function StatusPill({ status }: { status: Stage["status"] }) {
  const label =
    status === "live"
      ? "Live"
      : status === "coming-soon"
        ? "Coming soon"
        : "Future";
  const bg =
    status === "live"
      ? "rgba(34,197,94,0.16)"
      : status === "coming-soon"
        ? "rgba(234,88,12,0.14)"
        : "rgba(120,113,108,0.16)";
  const color =
    status === "live"
      ? "rgb(22,163,74)"
      : status === "coming-soon"
        ? "rgb(234,88,12)"
        : "rgb(120,113,108)";
  return (
    <span
      style={{
        background: bg,
        color,
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.8,
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

export default function PlatformMap({
  highlight,
  compact = false,
}: {
  highlight?: PlatformStageId;
  /** Smaller variant for embedding inside other pages. */
  compact?: boolean;
}) {
  return (
    <section
      aria-label="CADuniQ platform map"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: compact ? 16 : 24,
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
            }}
          >
            CADuniQ Platform Map
          </div>
          <h2
            style={{
              fontSize: compact ? 16 : 18,
              fontWeight: 700,
              margin: "4px 0 0",
              color: "var(--lb-text)",
              letterSpacing: "-0.01em",
            }}
          >
            Six stages, one event bus. Every module subscribes to the same stream.
          </h2>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--lb-text-3)",
            fontStyle: "italic",
          }}
        >
          Highlighted stage is what you&apos;re viewing now.
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: compact
            ? "repeat(auto-fit, minmax(180px, 1fr))"
            : "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {STAGES.map((s) => {
          const isHighlighted = highlight === s.id;
          const card = (
            <article
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: compact ? "12px 14px" : "14px 16px",
                borderRadius: 12,
                background: s.accentBg,
                border: `2px solid ${isHighlighted ? s.accent : s.accentBorder}`,
                boxShadow: isHighlighted ? `0 0 0 3px ${s.accent}22` : "none",
                transition: "border-color 160ms ease, box-shadow 160ms ease",
                height: "100%",
                color: "#1a1f36",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    background: s.accent,
                    color: "#fff",
                    fontSize: 9.5,
                    fontWeight: 800,
                    letterSpacing: 1,
                    padding: "3px 8px",
                    borderRadius: 5,
                    textTransform: "uppercase",
                  }}
                >
                  {s.badge}
                </span>
                <StatusPill status={s.status} />
              </div>
              <h3
                style={{
                  fontSize: compact ? 13 : 14.5,
                  fontWeight: 800,
                  margin: 0,
                  letterSpacing: "-0.01em",
                  color: "#1a1f36",
                }}
              >
                {s.title}
              </h3>
              <p
                style={{
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  color: "#3d4663",
                  margin: 0,
                }}
              >
                {s.summary}
              </p>
            </article>
          );
          return s.href ? (
            <Link
              key={s.id}
              href={s.href}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              {card}
            </Link>
          ) : (
            <div key={s.id}>{card}</div>
          );
        })}
      </div>

      <div
        aria-hidden
        style={{
          padding: "10px 14px",
          borderRadius: 10,
          background:
            "linear-gradient(90deg, #2563eb 0%, #7c3aed 20%, #16a34a 40%, #db2777 60%, #ea580c 80%, #0891b2 100%)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: 0.4 }}>
          ⚡ Typed Event Bus
        </span>
        <span style={{ fontSize: 11, opacity: 0.92 }}>
          cad.uploaded · bom.line.added · design.approved · quote.accepted ·
          order.shipped · hub.qc.pass · pdm.eco_approved · crm.health.dropped ·
          oee.alert.raised · …
        </span>
      </div>
      <p
        style={{
          fontSize: 11.5,
          color: "var(--lb-text-3)",
          margin: 0,
          fontStyle: "italic",
        }}
      >
        Every box publishes events to the bus. Every box subscribes to events
        from other boxes. No manual sync, no double entry, no integration
        project.
      </p>
    </section>
  );
}
