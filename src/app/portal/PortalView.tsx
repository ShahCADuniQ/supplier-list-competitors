"use client";

// Supplier dashboard — Clerk-authed version of /vendor/home/[token]. The
// signed-in supplier sees every RFQ they've been invited to, grouped by
// active vs closed, with quick-actions to open the per-RFQ submission
// form (which still lives under /vendor/[token], a magic-link route so
// it works for both signed-in and email-only suppliers).

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  PO_STATUS_META,
  QUOTE_STATUS_META,
  RFQ_STAGE_META,
  RFQ_STATUS_META,
  TRANSPORT_MODE_META,
  fmtMoney,
} from "@/app/suppliers/_orders-constants";
import { SupplierLogoUploader } from "@/app/suppliers/LogoUploader";
import SupplierChat from "@/app/suppliers/SupplierChat";
import { SupplierCatalogView } from "@/app/suppliers/SupplierInventoryTab";
import type { PurchaseOrder, Rfq, RfqRecipient, SupplierQuote } from "@/db/schema";

type Invite = {
  recipientId: number;
  rfqId: number;
  rfqNumber: string;
  rfqStatus: Rfq["status"];
  rfqStage: Rfq["stage"];
  projectNum: string;
  projectName: string | null;
  niche: string | null;
  transportMode: Rfq["transportMode"];
  currency: string;
  quoteDeadline: Date | null;
  invitedAt: Date;
  recipientStatus: RfqRecipient["status"];
  accessToken: string;
  tokenExpiresAt: Date | null;
  quoteStatus: SupplierQuote["status"] | null;
};

type PoSummary = {
  id: number;
  poNumber: string;
  projectNum: string;
  projectName: string | null;
  currency: string;
  totalAmount: number;
  status: PurchaseOrder["status"];
  createdAt: Date;
};

export default function PortalView({
  clientName,
  supplier,
  invites,
  pos,
  isAdminPreview,
}: {
  clientName: string;
  supplier: {
    id: number;
    name: string;
    email: string | null;
    contactName: string | null;
    logoUrl: string | null;
    logoName: string | null;
  };
  invites: Invite[];
  pos: PoSummary[];
  isAdminPreview: boolean;
}) {
  // Three top-level tabs the supplier sees: their product catalogue (their
  // own listings), incoming order requests (RFQs + awarded POs), and live
  // chat with the buyer. Defaults to the catalogue so a fresh supplier
  // with no RFQs yet still lands on something they can interact with.
  const [tab, setTab] = useState<"catalogue" | "orders" | "chat">(
    invites.length > 0 || pos.length > 0 ? "orders" : "catalogue",
  );
  // Project filter + free-text search across both invites and POs. "all" =
  // every project; specific value = restrict to one project number. Search
  // matches RFQ/PO numbers, project names, niches.
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const projectOptions = useMemo(() => {
    const seen = new Map<string, { num: string; name: string | null; count: number }>();
    function add(num: string, name: string | null) {
      const existing = seen.get(num);
      if (existing) existing.count += 1;
      else seen.set(num, { num, name, count: 1 });
    }
    for (const i of invites) add(i.projectNum, i.projectName);
    for (const p of pos) add(p.projectNum, p.projectName);
    return Array.from(seen.values()).sort((a, b) => a.num.localeCompare(b.num));
  }, [invites, pos]);

  const filteredInvites = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invites.filter((i) => {
      if (projectFilter !== "all" && i.projectNum !== projectFilter) return false;
      if (!q) return true;
      const hay = [i.projectNum, i.projectName ?? "", i.rfqNumber, i.niche ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [invites, projectFilter, search]);

  const filteredPos = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pos.filter((p) => {
      if (projectFilter !== "all" && p.projectNum !== projectFilter) return false;
      if (!q) return true;
      const hay = [p.projectNum, p.projectName ?? "", p.poNumber].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [pos, projectFilter, search]);

  const active = filteredInvites.filter(
    (i) =>
      i.rfqStatus !== "closed" &&
      i.rfqStatus !== "cancelled" &&
      i.recipientStatus !== "expired",
  );
  const closed = filteredInvites.filter(
    (i) =>
      i.rfqStatus === "closed" ||
      i.rfqStatus === "cancelled" ||
      i.recipientStatus === "expired",
  );

  return (
    <div
      style={{
        padding: 24,
        background: "var(--lb-bg)",
        minHeight: "100%",
        color: "var(--lb-text)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {isAdminPreview && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(124, 58, 237, 0.15)",
            border: "1px solid rgba(124, 58, 237, 0.45)",
            color: "var(--lb-text)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          🛠 Admin preview — viewing the supplier portal as it would render for{" "}
          <b>{supplier.name}</b>.
        </div>
      )}

      <header
        style={{
          padding: 22,
          borderRadius: 14,
          background:
            "linear-gradient(135deg, rgba(234,88,12,0.12), rgba(8,145,178,0.08))",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          {clientName} · Vendor Portal
        </div>
        <h1
          style={{
            fontSize: "clamp(22px, 2.6vw, 28px)",
            fontWeight: 800,
            margin: "6px 0 4px",
            letterSpacing: "-0.02em",
          }}
        >
          Welcome, {supplier.name}
        </h1>
        <div style={{ fontSize: 13, color: "var(--lb-text-2)" }}>
          {supplier.contactName ? `${supplier.contactName} · ` : ""}
          {supplier.email ?? ""}
        </div>
        <p
          style={{
            marginTop: 12,
            fontSize: 12.5,
            color: "var(--lb-text-2)",
            maxWidth: 720,
          }}
        >
          Every Request for Quotation {clientName} sends you appears here.
          Click into an RFQ to submit or update your quotation, upload
          datasheets or certifications, and post status updates. You're
          signed in — bookmark this page and the link stays valid as long
          as your account does.
        </p>
      </header>

      {/* Company logo — appears as letterhead on every quote / PO printed
          for this supplier, so they're encouraged to upload one. */}
      <SupplierLogoUploader
        supplierId={supplier.id}
        currentUrl={supplier.logoUrl}
        currentName={supplier.logoName}
        label="Your company logo"
        hint={`Used as the letterhead on every quotation you submit to ${clientName}, plus the supplier name strip on POs. PNG / JPG / SVG.`}
      />

      {/* KPI tiles */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        <Kpi label="Active RFQs" value={String(active.length)} color="#0891b2" />
        <Kpi
          label="Submitted"
          value={String(filteredInvites.filter((i) => i.recipientStatus === "submitted").length)}
          color="#16a34a"
        />
        <Kpi
          label="Draft in progress"
          value={String(filteredInvites.filter((i) => i.recipientStatus === "draft").length)}
          color="#ca8a04"
        />
        <Kpi label="Closed / past" value={String(closed.length)} color="#475569" />
        <Kpi label="Awarded POs" value={String(filteredPos.length)} color="#7c3aed" />
      </section>

      {/* Tab nav — three top-level views the supplier toggles between. */}
      {/* Catalogue: their own products + categorised attachments. */}
      {/* Order requests: every RFQ they've been invited to + awarded POs. */}
      {/* Chat: live conversation with the buyer. */}
      <nav
        role="tablist"
        aria-label="Supplier portal sections"
        style={{
          display: "flex",
          gap: 6,
          padding: 4,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 999,
          alignSelf: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {(
          [
            { key: "catalogue", label: "Catalogue", count: undefined as number | undefined },
            { key: "orders", label: "Order requests", count: invites.length + pos.length },
            { key: "chat", label: "Chat", count: undefined as number | undefined },
          ] as const
        ).map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: isActive ? 700 : 600,
                borderRadius: 999,
                background: isActive ? "var(--lb-accent)" : "transparent",
                color: isActive ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                border: isActive
                  ? "1px solid var(--lb-accent)"
                  : "1px solid transparent",
                cursor: "pointer",
                transition: "background 160ms ease, color 160ms ease",
              }}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: isActive
                      ? "rgba(255,255,255,0.22)"
                      : "var(--lb-bg)",
                    color: isActive ? "var(--lb-accent-fg)" : "var(--lb-text-3)",
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "catalogue" && (
        <Panel
          title="My catalog"
          subtitle={`Add the products you offer to ${clientName}. Drop datasheets, IES files, drawings, quotes, contracts, certifications, QC reports, photos, or any other files under each product — every upload is timestamped and visible to ${clientName}'s buyers.`}
        >
          <SupplierCatalogView
            supplierId={supplier.id}
            canEdit
            showHeader={false}
          />
        </Panel>
      )}

      {tab === "orders" && (
        <>
          {/* Project filter + search bar — scoped to the orders view since */}
          {/* it only filters RFQs and POs, not the catalogue or chat. */}
          <section
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              padding: 14,
              borderRadius: 12,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
            }}
          >
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                color: "var(--lb-text)",
                border: "1px solid var(--lb-border)",
                fontSize: 12.5,
                fontWeight: 600,
                minWidth: 200,
              }}
            >
              <option value="all">All projects ({invites.length + pos.length})</option>
              {projectOptions.map((p) => (
                <option key={p.num} value={p.num}>
                  {p.name ? `${p.num} · ${p.name}` : p.num} ({p.count})
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder="Search project, RFQ #, PO #…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                flex: 1,
                minWidth: 200,
                padding: "8px 14px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                color: "var(--lb-text)",
                border: "1px solid var(--lb-border)",
                fontSize: 13,
              }}
            />
            {(projectFilter !== "all" || search) && (
              <button
                type="button"
                onClick={() => { setProjectFilter("all"); setSearch(""); }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "transparent",
                  color: "var(--lb-text-2)",
                  border: "1px solid var(--lb-border)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Clear filters
              </button>
            )}
            <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
              {filteredInvites.length} RFQ · {filteredPos.length} PO
            </span>
          </section>

          <Panel
            title={`Active requests (${active.length})`}
            subtitle="Open these to submit your quote, update prices, or upload supporting documents."
          >
            {active.length === 0 ? (
              <Empty>
                {projectFilter !== "all" || search
                  ? "No active RFQs match the current filter."
                  : `You have no active RFQs from ${clientName} right now.`}
              </Empty>
            ) : (
              <InviteList invites={active} />
            )}
          </Panel>

          {filteredPos.length > 0 && (
            <Panel
              title={`Purchase orders awarded to you (${filteredPos.length})`}
              subtitle={`Download as PDF (browser print) or Excel. ${clientName} will reach out with shipping instructions on each one.`}
            >
              <PoList pos={filteredPos} />
            </Panel>
          )}

          {closed.length > 0 && (
            <Panel title={`Past / closed (${closed.length})`}>
              <InviteList invites={closed} />
            </Panel>
          )}
        </>
      )}

      {tab === "chat" && (
        <Panel
          title={`💬 Chat with ${clientName}`}
          subtitle="Real-time messages between your team and the buyer. Pick a channel on the left or stay in General."
        >
          <SupplierChat
            supplierId={supplier.id}
            supplierName={supplier.name}
            viewerRole="supplier"
            height={560}
          />
        </Panel>
      )}
    </div>
  );
}

function PoList({ pos }: { pos: PoSummary[] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {pos.map((po) => {
        const meta = PO_STATUS_META[po.status];
        return (
          <li
            key={po.id}
            style={{
              padding: 14,
              borderRadius: 12,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              borderLeft: "4px solid #7c3aed",
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14 }}>{po.poNumber}</strong>
                <Pill label={meta.label} color={meta.color} />
              </div>
              <div style={{ marginTop: 4, color: "var(--lb-text-2)", fontSize: 13 }}>
                {po.projectName ?? po.projectNum}
              </div>
              <div style={{ marginTop: 4, color: "var(--lb-text-3)", fontSize: 11 }}>
                {new Date(po.createdAt).toLocaleDateString()} · {fmtMoney(po.totalAmount, po.currency)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <a
                href={`/api/po/${po.id}/xlsx`}
                download
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text)",
                  textDecoration: "none",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                📊 Excel
              </a>
              <Link
                href={`/suppliers/po/${po.id}`}
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "var(--lb-accent)",
                  color: "var(--lb-accent-fg)",
                  border: "1px solid var(--lb-accent)",
                  textDecoration: "none",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                🖨 View / Print PDF
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InviteList({ invites }: { invites: Invite[] }) {
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
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14 }}>{inv.rfqNumber}</strong>
                <Pill label={rfqStatus.label} color={rfqStatus.color} />
                <Pill label={stage.label} color={stage.color} />
                {quoteStatus && <Pill label={quoteStatus.label} color={quoteStatus.color} />}
              </div>
              <div style={{ marginTop: 4, color: "var(--lb-text-2)", fontSize: 13 }}>
                {inv.projectName ?? inv.projectNum}
                {inv.niche && (
                  <span style={{ color: "var(--lb-text-3)" }}> · {inv.niche}</span>
                )}
              </div>
              <div
                style={{
                  marginTop: 4,
                  color: "var(--lb-text-3)",
                  fontSize: 11,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <span>Invited {new Date(inv.invitedAt).toLocaleDateString()}</span>
                <span>
                  {tm.icon} {tm.label}
                </span>
                <span>{inv.currency}</span>
                {inv.quoteDeadline && (
                  <span
                    style={{
                      color: deadlineSoon ? "#facc15" : "var(--lb-text-3)",
                      fontWeight: deadlineSoon ? 700 : 400,
                    }}
                  >
                    Deadline {new Date(inv.quoteDeadline).toLocaleDateString()}
                    {deadlineSoon ? " (soon)" : ""}
                  </span>
                )}
                {expired && (
                  <span style={{ color: "#dc2626", fontWeight: 700 }}>Link expired</span>
                )}
              </div>
            </div>
            {!expired ? (
              <Link
                href={`/vendor/${inv.accessToken}`}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  background:
                    inv.quoteStatus === "submitted" ? "transparent" : "var(--lb-accent)",
                  color:
                    inv.quoteStatus === "submitted"
                      ? "var(--lb-text-2)"
                      : "var(--lb-accent-fg)",
                  border:
                    inv.quoteStatus === "submitted"
                      ? "1px solid var(--lb-border)"
                      : "1px solid var(--lb-accent)",
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
            {/* Always-available "view RFQ as PDF" — Clerk-authed supplier
                so no token needed; the page auths via the supplier-on-this-
                RFQ check. */}
            <Link
              href={`/suppliers/rfq/${inv.rfqId}`}
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                background: "transparent",
                color: "var(--lb-text-2)",
                border: "1px solid var(--lb-border)",
                fontWeight: 600,
                fontSize: 12,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              📄 RFQ PDF
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// — primitives —

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        padding: 18,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{title}</h2>
        {subtitle && (
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${color}`,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: "var(--lb-text-3)",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "18px 12px",
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

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "2px 8px",
        borderRadius: 4,
        background: `${color}22`,
        color,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
