"use client";

// Supplier home dashboard. Public, no Clerk login — the URL token gates
// everything. Shows every RFQ the supplier was ever invited to, grouped
// by status (active vs closed), with a click-through to the per-RFQ
// portal where they actually submit / edit their quote.

import Link from "next/link";
import {
  PO_STATUS_META,
  QUOTE_STATUS_META,
  RFQ_STAGE_META,
  RFQ_STATUS_META,
  TRANSPORT_MODE_META,
} from "@/app/suppliers/_orders-constants";
import type { SupplierHomePayload } from "@/app/suppliers/rfq-actions";

export default function SupplierHome({
  home,
  clientName,
}: {
  home: SupplierHomePayload;
  clientName: string;
}) {
  const active = home.invites.filter(
    (i) =>
      i.rfqStatus !== "closed" &&
      i.rfqStatus !== "cancelled" &&
      i.recipientStatus !== "expired",
  );
  const closed = home.invites.filter(
    (i) =>
      i.rfqStatus === "closed" ||
      i.rfqStatus === "cancelled" ||
      i.recipientStatus === "expired",
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        padding: "32px 20px 64px",
      }}
    >
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Hero */}
        <header
          style={{
            padding: 22,
            borderRadius: 14,
            background: "linear-gradient(135deg, rgba(234,88,12,0.12), rgba(8,145,178,0.08))",
            border: "1px solid var(--lb-border)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
            {clientName} · Vendor Portal
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 4px", color: "var(--lb-text)" }}>
            Welcome, {home.supplier.name}
          </h1>
          <div style={{ fontSize: 13, color: "var(--lb-text-2)" }}>
            {home.supplier.contactName ? `${home.supplier.contactName} · ` : ""}
            {home.supplier.email ?? ""}
          </div>
          <p style={{ marginTop: 12, fontSize: 12.5, color: "var(--lb-text-2)", maxWidth: 720 }}>
            This is your home dashboard. Every Request for Quotation
            {` ${clientName} `}sends you appears here. Click into an RFQ to
            submit or update your quotation, upload datasheets / certifications,
            or check the status. Bookmark this page — the link stays valid
            as long as your account does.
          </p>
        </header>

        {/* KPIs */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          <Kpi label="Active RFQs" value={String(active.length)} color="#0891b2" />
          <Kpi label="Submitted" value={String(home.invites.filter((i) => i.recipientStatus === "submitted").length)} color="#16a34a" />
          <Kpi label="In progress (draft)" value={String(home.invites.filter((i) => i.recipientStatus === "draft").length)} color="#ca8a04" />
          <Kpi label="Closed / archived" value={String(closed.length)} color="#475569" />
        </section>

        {/* Active RFQs */}
        <Section
          title={`Active requests (${active.length})`}
          subtitle="Open these to submit your quote, update prices, or upload supporting documents."
        >
          {active.length === 0 ? (
            <Empty>You have no active RFQs from {clientName} right now.</Empty>
          ) : (
            <RfqList invites={active} />
          )}
        </Section>

        {/* Closed / past */}
        {closed.length > 0 && (
          <Section title={`Past / closed (${closed.length})`}>
            <RfqList invites={closed} />
          </Section>
        )}

        <footer
          style={{
            padding: "16px 0",
            fontSize: 11,
            color: "var(--lb-text-3)",
            textAlign: "center",
            borderTop: "1px solid var(--lb-border)",
            marginTop: 8,
          }}
        >
          Powered by {clientName} · This page is private — keep your link safe.
        </footer>
      </div>
    </div>
  );
}

function RfqList({ invites }: { invites: SupplierHomePayload["invites"] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {invites.map((inv) => {
        const rfqStatus = RFQ_STATUS_META[inv.rfqStatus];
        const quoteStatus = inv.quoteStatus ? QUOTE_STATUS_META[inv.quoteStatus] : null;
        const stage = RFQ_STAGE_META[inv.rfqStage];
        const tm = TRANSPORT_MODE_META[inv.transportMode];
        const expired = inv.tokenExpiresAt && new Date(inv.tokenExpiresAt) < new Date();
        const deadlineSoon =
          inv.quoteDeadline &&
          new Date(inv.quoteDeadline).getTime() - Date.now() < 3 * 24 * 3600 * 1000;
        return (
          <li
            key={inv.recipientId}
            style={{
              padding: 14,
              borderRadius: 12,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ color: "var(--lb-text)", fontSize: 14 }}>{inv.rfqNumber}</strong>
                <Pill label={rfqStatus.label} color={rfqStatus.color} />
                <Pill label={stage.label} color={stage.color} />
                {quoteStatus && <Pill label={quoteStatus.label} color={quoteStatus.color} />}
              </div>
              <div style={{ marginTop: 4, color: "var(--lb-text-2)", fontSize: 13 }}>
                {inv.projectName ?? inv.projectNum}
                {inv.niche && <span style={{ color: "var(--lb-text-3)" }}> · {inv.niche}</span>}
              </div>
              <div style={{ marginTop: 4, color: "var(--lb-text-3)", fontSize: 11, display: "flex", flexWrap: "wrap", gap: 10 }}>
                <span>Invited {new Date(inv.invitedAt).toLocaleDateString()}</span>
                <span>{tm.icon} {tm.label}</span>
                <span>{inv.currency}</span>
                {inv.quoteDeadline && (
                  <span style={{ color: deadlineSoon ? "#facc15" : "var(--lb-text-3)", fontWeight: deadlineSoon ? 700 : 400 }}>
                    Deadline {new Date(inv.quoteDeadline).toLocaleDateString()}
                    {deadlineSoon ? " (soon)" : ""}
                  </span>
                )}
                {expired && <span style={{ color: "#dc2626", fontWeight: 700 }}>Link expired</span>}
              </div>
            </div>
            {!expired ? (
              <Link
                href={`/vendor/${inv.accessToken}`}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  background: inv.quoteStatus === "submitted" ? "transparent" : "#ea580c",
                  color: inv.quoteStatus === "submitted" ? "var(--lb-text-2)" : "#fff",
                  border: inv.quoteStatus === "submitted" ? "1px solid var(--lb-border)" : "1px solid #ea580c",
                  fontWeight: 700,
                  fontSize: 12.5,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {inv.quoteStatus === "submitted"
                  ? "View submitted quote"
                  : inv.quoteStatus === "draft"
                    ? "Continue your draft →"
                    : "Open RFQ →"}
              </Link>
            ) : (
              <span
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  background: "transparent",
                  color: "var(--lb-text-3)",
                  border: "1px solid var(--lb-border)",
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                Link expired
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── small primitives ──

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 18, borderRadius: 12, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--lb-text)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 14, borderRadius: 12, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)", borderLeft: `4px solid ${color}` }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 22, fontWeight: 800, color: "var(--lb-text)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "18px 12px", borderRadius: 10, border: "1px dashed var(--lb-border)", textAlign: "center", color: "var(--lb-text-3)", fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10,
      padding: "2px 8px",
      borderRadius: 4,
      background: `${color}22`,
      color,
      fontWeight: 800,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

void PO_STATUS_META; // reserved for future "Your POs" section