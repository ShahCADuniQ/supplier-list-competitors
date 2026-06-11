"use client";

// CADuniQ HQ — the cross-tenant landing for @caduniq.com staff. Renders
// only when isCaduniqUser(profile) is true (see Home() in src/app/page.tsx).
//
// Layout:
//   1. Hero greeting + KPI strip (active tenants, pending signups,
//      cross-tenant user count, cross-tenant supplier count).
//   2. Segmented tabs:
//        Companies   — every clients row (designer/engineering tenants)
//                      with sector chip + per-module access toggles.
//        Suppliers   — every suppliers row across every client, tagged
//                      with the client tenant name + onboarding status.
//        Retailers   — every user_profiles row where is_retailer=true,
//                      enriched with the matching crm_accounts row.
//        Users       — every user_profiles row that isn't a supplier or
//                      retailer (i.e. internal client staff + admins).
//   3. Pending signups (engineering signups still mid-wizard).
//
// All sub-views render under the same brand-neutral CADuniQ chrome so
// no tenant name ever leaks into the cross-tenant view.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  deleteClient,
  setClientModuleAccess,
  type ClientModule,
} from "@/app/admin/caduniq-actions";

// ─────────────────────────────────────────────────────────────────────
// Public row types — populated by Home() and passed down here.
// ─────────────────────────────────────────────────────────────────────

export type HQClientRow = {
  id: number;
  name: string;
  industry: string | null;
  userCount: number;
  supplierCount: number;
  isActive: boolean;
  canUseSuppliers: boolean;
  canUseCompetitors: boolean;
  canUseHandbook: boolean;
  canUseEngineering: boolean;
  canUseDesignEngineering: boolean;
  canUseCrm: boolean;
  canUseOee: boolean;
};

export type HQSupplierRow = {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  category: string | null;
  origin: string | null;
  onboardingStatus: "pending" | "submitted" | "approved" | "rejected";
  isDistributor: boolean;
  clientId: number | null;
  clientName: string | null;
  createdAt: Date;
};

export type HQUserRow = {
  clerkUserId: string;
  email: string;
  displayName: string | null;
  role: string;
  jobRole: string | null;
  clientId: number | null;
  clientName: string | null;
  createdAt: Date;
};

export type HQRetailerRow = {
  clerkUserId: string;
  email: string;
  displayName: string | null;
  companyName: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  tier: string | null;
  clientId: number | null;
  clientName: string | null;
  createdAt: Date;
};

export type HQPendingSignup = {
  clerkUserId: string;
  email: string;
  displayName: string | null;
  pendingSignupRole: string | null;
  createdAt: Date;
};

const MODULE_DEFS: { key: ClientModule; label: string; sub: string }[] = [
  { key: "suppliers", label: "ERP / Suppliers", sub: "supplier database, inventory, POs, BOMs" },
  { key: "competitors", label: "Competitors", sub: "market research + competitor tracking" },
  { key: "handbook", label: "Process Handbook", sub: "design briefs + spec workflows" },
  { key: "engineering", label: "Engineering Handbook", sub: "mech / electrical / optical reference" },
  { key: "designEngineering", label: "Design & Engineering", sub: "CAD project workspace" },
  { key: "crm", label: "CRM", sub: "customer pipeline + retailers" },
  { key: "oee", label: "OEE / Floor Ops", sub: "real-time machine telemetry" },
];

const PANEL: React.CSSProperties = {
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
  borderRadius: "var(--lb-radius-lg)",
  padding: 24,
  marginBottom: 16,
};

type Tab = "companies" | "suppliers" | "retailers" | "users";

export default function CaduniqHQDashboard({
  displayName,
  emailStatus,
  clients,
  suppliersAcrossTenants,
  usersAcrossTenants,
  retailersAcrossTenants,
  pendingSignups,
}: {
  displayName: string;
  emailStatus: {
    configured: boolean;
    provider: "microsoft" | "google" | null;
    fromAddress: string | null;
  };
  clients: HQClientRow[];
  suppliersAcrossTenants: HQSupplierRow[];
  usersAcrossTenants: HQUserRow[];
  retailersAcrossTenants: HQRetailerRow[];
  pendingSignups: HQPendingSignup[];
}) {
  const [tab, setTab] = useState<Tab>("companies");

  const totalUsers = usersAcrossTenants.length;
  const totalSuppliers = suppliersAcrossTenants.length;

  return (
    <div
      className="min-h-full"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <div
        className="px-6 pt-6 pb-10"
        style={{ maxWidth: 1400, margin: "0 auto" }}
      >
        {/* HERO */}
        <section
          style={{
            padding: 32,
            borderRadius: "var(--lb-radius-xl)",
            background:
              "linear-gradient(135deg, #1a1f36 0%, #2563eb 55%, #7c3aed 100%)",
            color: "#fff",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Top-right controls: email-connection chip + settings link.
              Sits above the gradient so it's always visible on the HQ
              dashboard, which renders without the global TopBar. */}
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              display: "flex",
              gap: 8,
              alignItems: "center",
              zIndex: 2,
            }}
          >
            {emailStatus.configured ? (
              <Link
                href="/settings#email"
                title={`Email connected: ${emailStatus.fromAddress ?? ""}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  borderRadius: 999,
                  background: "rgba(16,185,129,0.18)",
                  border: "1px solid rgba(16,185,129,0.55)",
                  color: "#d1fae5",
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                ● {emailStatus.provider === "google" ? "Gmail" : "Outlook"}{" "}
                connected
              </Link>
            ) : (
              <Link
                href="/settings#email"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.16)",
                  border: "1px solid rgba(255,255,255,0.40)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                ✉ Connect email
              </Link>
            )}
            <Link
              href="/settings#email"
              title="Settings"
              aria-label="Settings"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                borderRadius: 999,
                background: "rgba(255,255,255,0.10)",
                border: "1px solid rgba(255,255,255,0.28)",
                color: "#fff",
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              ⚙
            </Link>
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.80)",
            }}
          >
            CADuniQ HQ · cross-tenant view
          </span>
          <h1
            style={{
              fontFamily: "var(--lb-font-display)",
              fontSize: "clamp(28px, 3.6vw, 44px)",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1.05,
              margin: "10px 0 8px",
            }}
          >
            Welcome back, {firstName(displayName)}.
          </h1>
          <p
            style={{
              maxWidth: 720,
              fontSize: 15,
              lineHeight: 1.55,
              color: "rgba(255,255,255,0.86)",
              margin: 0,
            }}
          >
            Every CADuniQ tenant you operate is below, plus every supplier,
            retailer and user across all of them. Switch tabs to filter; click
            into a client to manage their module access or jump to their admin
            panel.
          </p>
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: -100,
              top: -100,
              width: 360,
              height: 360,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.18)",
              pointerEvents: "none",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: -50,
              top: -50,
              width: 240,
              height: 240,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.22)",
              pointerEvents: "none",
            }}
          />
        </section>

        {/* KPIs */}
        <section
          className="mt-6 grid gap-5"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          }}
          aria-label="HQ summary"
        >
          <Kpi
            label="Designer / engineering tenants"
            value={clients.filter((c) => c.isActive).length}
            sub={`${clients.length} total`}
          />
          <Kpi
            label="Pending signups"
            value={pendingSignups.length}
            sub="engineering signups not finished"
          />
          <Kpi
            label="Suppliers (all tenants)"
            value={totalSuppliers}
            sub="approved + pending"
          />
          <Kpi
            label="Retailers (all tenants)"
            value={retailersAcrossTenants.length}
            sub="signed up via /get-started"
          />
          <Kpi
            label="Users (all tenants)"
            value={totalUsers}
            sub="excludes suppliers + retailers"
          />
        </section>

        {/* Tabs */}
        <section style={{ ...PANEL, marginTop: 32, padding: 0, overflow: "hidden" }}>
          <div
            role="tablist"
            aria-label="Cross-tenant data"
            style={{
              display: "flex",
              gap: 4,
              padding: 8,
              borderBottom: "1px solid var(--lb-border)",
              background: "var(--lb-bg)",
              flexWrap: "wrap",
            }}
          >
            <TabBtn
              active={tab === "companies"}
              onClick={() => setTab("companies")}
              label="Companies"
              count={clients.length}
            />
            <TabBtn
              active={tab === "suppliers"}
              onClick={() => setTab("suppliers")}
              label="Suppliers"
              count={suppliersAcrossTenants.length}
            />
            <TabBtn
              active={tab === "retailers"}
              onClick={() => setTab("retailers")}
              label="Retailers"
              count={retailersAcrossTenants.length}
            />
            <TabBtn
              active={tab === "users"}
              onClick={() => setTab("users")}
              label="Users"
              count={usersAcrossTenants.length}
            />
          </div>

          <div style={{ padding: 24 }}>
            {tab === "companies" && <CompaniesTab clients={clients} />}
            {tab === "suppliers" && (
              <SuppliersTab suppliers={suppliersAcrossTenants} clients={clients} />
            )}
            {tab === "retailers" && (
              <RetailersTab retailers={retailersAcrossTenants} clients={clients} />
            )}
            {tab === "users" && (
              <UsersTab users={usersAcrossTenants} clients={clients} />
            )}
          </div>
        </section>

        {/* Pending signups */}
        <section style={PANEL}>
          <h2 className="lb-section-title" style={{ marginBottom: 4 }}>
            Pending signups
          </h2>
          <p
            style={{
              margin: "0 0 16px",
              fontSize: 13,
              color: "var(--lb-text-3)",
            }}
          >
            Accounts that picked &ldquo;designer/engineering company&rdquo; on{" "}
            <code style={codeStyle}>/get-started</code> but haven&apos;t
            completed the wizard yet.
          </p>

          {pendingSignups.length === 0 ? (
            <Empty message="No pending signups in flight." />
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {pendingSignups.map((p) => (
                <li
                  key={p.clerkUserId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 14px",
                    background: "var(--lb-bg-sunken)",
                    border: "1px solid var(--lb-border)",
                    borderRadius: "var(--lb-radius)",
                    marginBottom: 8,
                    fontSize: 13,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--lb-text)" }}>
                      {p.displayName || p.email}
                    </div>
                    <div
                      style={{
                        color: "var(--lb-text-3)",
                        fontSize: 12,
                        marginTop: 2,
                      }}
                    >
                      {p.email} · started{" "}
                      {new Date(p.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      color: "var(--lb-accent)",
                      padding: "3px 10px",
                      borderRadius: 999,
                      background:
                        "color-mix(in srgb, var(--lb-accent) 12%, transparent)",
                      border: "1px solid var(--lb-border)",
                    }}
                  >
                    {prettyRoleLabel(p.pendingSignupRole)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Companies tab
// ─────────────────────────────────────────────────────────────────────

function CompaniesTab({ clients }: { clients: HQClientRow[] }) {
  if (clients.length === 0) {
    return (
      <Empty message="No clients yet. New designer/engineering signups will appear here." />
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--lb-text-3)" }}>
        Every client is a designer/engineering company. Toggle a module off to
        revoke access for every user on that tenant at once. Click{" "}
        <strong>Open admin</strong> to drill into the tenant&apos;s own admin
        panel.
      </p>
      {clients.map((c) => (
        <ClientCard key={c.id} row={c} />
      ))}
    </div>
  );
}

function ClientCard({ row }: { row: HQClientRow }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article
      style={{
        padding: 18,
        borderRadius: "var(--lb-radius)",
        background: "var(--lb-bg-sunken)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--lb-font-display)",
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: "-0.018em",
              color: "var(--lb-text)",
            }}
          >
            {row.name}
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            <Chip color="#2563eb">Designer / Engineering Company</Chip>
            {row.industry && (
              <Chip color="#7c3aed">Sector: {prettyIndustry(row.industry)}</Chip>
            )}
            {!row.isActive && <Chip color="#dc2626">Inactive</Chip>}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--lb-text-3)",
              marginTop: 6,
            }}
          >
            {row.userCount} user{row.userCount === 1 ? "" : "s"} ·{" "}
            {row.supplierCount} supplier{row.supplierCount === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link
            href={`/admin?clientId=${row.id}`}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              textDecoration: "none",
            }}
          >
            Open admin →
          </Link>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              background: "transparent",
              border: "1px solid rgba(220,38,38,0.4)",
              color: "#dc2626",
              cursor: "pointer",
            }}
          >
            🗑 Delete tenant
          </button>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        {MODULE_DEFS.map((m) => (
          <ModuleToggle
            key={m.key}
            clientId={row.id}
            module={m.key}
            label={m.label}
            sub={m.sub}
            initial={Boolean(row[gateColumnFor(m.key)])}
          />
        ))}
      </div>

      {confirming && (
        <DeleteTenantDialog
          row={row}
          onClose={() => setConfirming(false)}
        />
      )}
    </article>
  );
}

function DeleteTenantDialog({
  row,
  onClose,
}: {
  row: HQClientRow;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = typed.trim().toLowerCase() === row.name.trim().toLowerCase();

  function submit() {
    if (!matches || pending) return;
    setErr(null);
    startTransition(async () => {
      try {
        await deleteClient({ clientId: row.id, confirmName: typed });
        // Page-level refresh: the parent HQ component re-fetches its
        // client list from the server on the next render. Easiest is a
        // hard reload since the data flows top-down.
        window.location.reload();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 120,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--lb-bg-elev)",
          color: "var(--lb-text)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "var(--lb-shadow-lg)",
        }}
      >
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "#dc2626" }}>
            Permanent delete
          </div>
          <h3 style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 800 }}>
            Remove {row.name}?
          </h3>
        </div>
        <div style={{ fontSize: 13, color: "var(--lb-text-2)", lineHeight: 1.5 }}>
          This deletes the tenant and every supplier scoped to it
          ({row.supplierCount} supplier{row.supplierCount === 1 ? "" : "s"}),
          and unlinks every user on the tenant
          ({row.userCount} user{row.userCount === 1 ? "" : "s"}). Their Clerk
          accounts stay, but they lose access and will need to re-register.
          This cannot be undone.
        </div>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", marginBottom: 4 }}>
            Type the tenant name to confirm
          </div>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={row.name}
            autoFocus
            style={{
              width: "100%",
              padding: "9px 12px",
              fontSize: 14,
              border: "1px solid var(--lb-border)",
              borderRadius: 8,
              background: "var(--lb-bg)",
              color: "var(--lb-text)",
              outline: "none",
            }}
          />
        </label>
        {err && (
          <div style={{
            padding: 10,
            borderRadius: 8,
            background: "rgba(220,38,38,0.1)",
            border: "1px solid rgba(220,38,38,0.4)",
            color: "#dc2626",
            fontSize: 12.5,
          }}>
            {err}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 999,
              background: "transparent",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              cursor: pending ? "wait" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!matches || pending}
            style={{
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 999,
              background: matches ? "#dc2626" : "var(--lb-bg)",
              border: `1px solid ${matches ? "#dc2626" : "var(--lb-border)"}`,
              color: matches ? "#fff" : "var(--lb-text-3)",
              cursor: matches && !pending ? "pointer" : "not-allowed",
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

function gateColumnFor(m: ClientModule): keyof HQClientRow {
  switch (m) {
    case "suppliers":
      return "canUseSuppliers";
    case "competitors":
      return "canUseCompetitors";
    case "handbook":
      return "canUseHandbook";
    case "engineering":
      return "canUseEngineering";
    case "designEngineering":
      return "canUseDesignEngineering";
    case "crm":
      return "canUseCrm";
    case "oee":
      return "canUseOee";
  }
}

function ModuleToggle({
  clientId,
  module,
  label,
  sub,
  initial,
}: {
  clientId: number;
  module: ClientModule;
  label: string;
  sub: string;
  initial: boolean;
}) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function flip() {
    if (pending) return;
    const next = !enabled;
    setEnabled(next);
    setErr(null);
    startTransition(async () => {
      try {
        await setClientModuleAccess({ clientId, module, enabled: next });
      } catch (e) {
        setEnabled(!next);
        setErr(e instanceof Error ? e.message : "Couldn't save");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={flip}
      disabled={pending}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        textAlign: "left",
        borderRadius: "var(--lb-radius)",
        border: enabled
          ? "1px solid var(--lb-accent)"
          : "1px solid var(--lb-border)",
        background: enabled
          ? "color-mix(in srgb, var(--lb-accent) 8%, var(--lb-bg-elev))"
          : "var(--lb-bg-elev)",
        cursor: pending ? "wait" : "pointer",
        color: "var(--lb-text)",
        opacity: pending ? 0.7 : 1,
        width: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 18,
          borderRadius: 999,
          background: enabled ? "var(--lb-accent)" : "var(--lb-border)",
          position: "relative",
          flexShrink: 0,
          transition: "background 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 120ms ease",
          }}
        />
      </span>
      <span style={{ flex: 1 }}>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 700,
            color: "var(--lb-text)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: "var(--lb-text-3)",
            marginTop: 2,
          }}
        >
          {err ?? sub}
        </span>
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Suppliers tab
// ─────────────────────────────────────────────────────────────────────

function SuppliersTab({
  suppliers,
  clients,
}: {
  suppliers: HQSupplierRow[];
  clients: HQClientRow[];
}) {
  const [tenantFilter, setTenantFilter] = useState<"all" | number>("all");
  const filtered = useMemo(
    () =>
      tenantFilter === "all"
        ? suppliers
        : suppliers.filter((s) => s.clientId === tenantFilter),
    [tenantFilter, suppliers],
  );

  if (suppliers.length === 0) {
    return <Empty message="No suppliers across any tenant yet." />;
  }

  return (
    <div>
      <FilterBar clients={clients} value={tenantFilter} onChange={setTenantFilter} />
      <Table
        columns={["Supplier", "Tenant", "Category", "Country", "Status", "Type"]}
        rows={filtered.map((s) => [
          <TwoLine key="n" top={s.name} bottom={s.email ?? s.contactName ?? "—"} />,
          s.clientName ?? "—",
          s.category ?? "—",
          s.origin ?? "—",
          <StatusBadge key="st" status={s.onboardingStatus} />,
          s.isDistributor ? "Buy & sell" : "Manufacturer",
        ])}
        emptyMessage="No suppliers match the current filter."
      />
    </div>
  );
}

function StatusBadge({ status }: { status: HQSupplierRow["onboardingStatus"] }) {
  const color =
    status === "approved"
      ? "#16a34a"
      : status === "submitted"
        ? "#2563eb"
        : status === "rejected"
          ? "#dc2626"
          : "#ea580c";
  return <Chip color={color}>{status}</Chip>;
}

// ─────────────────────────────────────────────────────────────────────
// Retailers tab
// ─────────────────────────────────────────────────────────────────────

function RetailersTab({
  retailers,
  clients,
}: {
  retailers: HQRetailerRow[];
  clients: HQClientRow[];
}) {
  const [tenantFilter, setTenantFilter] = useState<"all" | number>("all");
  const filtered = useMemo(
    () =>
      tenantFilter === "all"
        ? retailers
        : retailers.filter((r) => r.clientId === tenantFilter),
    [tenantFilter, retailers],
  );

  if (retailers.length === 0) {
    return <Empty message="No retailers across any tenant yet." />;
  }

  return (
    <div>
      <FilterBar clients={clients} value={tenantFilter} onChange={setTenantFilter} />
      <Table
        columns={["Retailer", "Buys from (tenant)", "Industry", "Country", "Signed up"]}
        rows={filtered.map((r) => [
          <TwoLine key="n" top={r.companyName} bottom={r.email} />,
          r.clientName ?? "—",
          r.industry ?? "—",
          r.country ?? "—",
          new Date(r.createdAt).toLocaleDateString(),
        ])}
        emptyMessage="No retailers match the current filter."
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Users tab
// ─────────────────────────────────────────────────────────────────────

function UsersTab({
  users,
  clients,
}: {
  users: HQUserRow[];
  clients: HQClientRow[];
}) {
  const [tenantFilter, setTenantFilter] = useState<"all" | number>("all");
  const filtered = useMemo(
    () =>
      tenantFilter === "all"
        ? users
        : users.filter((u) => u.clientId === tenantFilter),
    [tenantFilter, users],
  );

  if (users.length === 0) {
    return <Empty message="No users across any tenant yet." />;
  }

  return (
    <div>
      <FilterBar clients={clients} value={tenantFilter} onChange={setTenantFilter} />
      <Table
        columns={["User", "Tenant", "Role", "Job role", "Joined"]}
        rows={filtered.map((u) => [
          <TwoLine key="n" top={u.displayName ?? u.email} bottom={u.displayName ? u.email : ""} />,
          u.clientName ?? "—",
          <Chip
            key="r"
            color={u.role === "admin" ? "#2563eb" : u.role === "member" ? "#16a34a" : "#ea580c"}
          >
            {u.role}
          </Chip>,
          u.jobRole ?? "—",
          new Date(u.createdAt).toLocaleDateString(),
        ])}
        emptyMessage="No users match the current filter."
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  padding: "1px 6px",
  background: "var(--lb-bg-sunken)",
  border: "1px solid var(--lb-border)",
  borderRadius: 4,
};

function firstName(s: string): string {
  if (!s) return "team";
  if (s.includes("@")) return s.split("@")[0].split(".")[0];
  return s.split(/\s+/)[0];
}

function prettyRoleLabel(value: string | null): string {
  switch (value) {
    case "engineering":
      return "Designer/Engineering";
    case "supplier":
      return "Supplier";
    case "retailer":
      return "Retailer";
    default:
      return "Unknown";
  }
}

function prettyIndustry(value: string): string {
  // The industry column is free-text from the engineering signup wizard
  // (Manufacturing / Lighting / Aerospace / …). Title-case for display.
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub: string;
}) {
  return (
    <div
      style={{
        padding: 22,
        borderRadius: "var(--lb-radius-lg)",
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        boxShadow: "var(--lb-shadow)",
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: "-0.022em",
          lineHeight: 1,
          marginTop: 8,
          color: "var(--lb-text)",
        }}
      >
        {value.toLocaleString()}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--lb-text-3)" }}>
        {sub}
      </div>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "18px 16px",
        textAlign: "center",
        color: "var(--lb-text-3)",
        fontSize: 13,
        border: "1px dashed var(--lb-border)",
        borderRadius: "var(--lb-radius)",
      }}
    >
      {message}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: 700,
        borderRadius: 999,
        border: "1px solid",
        borderColor: active ? "var(--lb-accent)" : "transparent",
        background: active
          ? "color-mix(in srgb, var(--lb-accent) 12%, var(--lb-bg-elev))"
          : "transparent",
        color: active ? "var(--lb-accent)" : "var(--lb-text-2)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          padding: "1px 8px",
          borderRadius: 999,
          background: active
            ? "var(--lb-accent)"
            : "var(--lb-bg-sunken)",
          color: active ? "var(--lb-accent-fg)" : "var(--lb-text-3)",
        }}
      >
        {count}
      </span>
    </button>
  );
}

function FilterBar({
  clients,
  value,
  onChange,
}: {
  clients: HQClientRow[];
  value: "all" | number;
  onChange: (next: "all" | number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 14,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        Filter by tenant
      </span>
      <select
        value={value === "all" ? "all" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "all" ? "all" : Number(e.target.value))
        }
        style={{
          padding: "6px 12px",
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 999,
          border: "1px solid var(--lb-border)",
          background: "var(--lb-bg-elev)",
          color: "var(--lb-text)",
          cursor: "pointer",
        }}
      >
        <option value="all">All tenants</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Table({
  columns,
  rows,
  emptyMessage,
}: {
  columns: string[];
  rows: React.ReactNode[][];
  emptyMessage: string;
}) {
  if (rows.length === 0) return <Empty message={emptyMessage} />;
  return (
    <div
      style={{
        overflow: "auto",
        border: "1px solid var(--lb-border)",
        borderRadius: "var(--lb-radius)",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
          minWidth: 720,
        }}
      >
        <thead>
          <tr style={{ background: "var(--lb-bg)" }}>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  padding: "10px 14px",
                  textAlign: "left",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--lb-text-3)",
                  borderBottom: "1px solid var(--lb-border)",
                  whiteSpace: "nowrap",
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr
              key={i}
              style={{
                borderBottom:
                  i === rows.length - 1
                    ? "none"
                    : "1px solid var(--lb-border)",
              }}
            >
              {cells.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "10px 14px",
                    color: "var(--lb-text)",
                    verticalAlign: "top",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TwoLine({ top, bottom }: { top: string; bottom: string }) {
  return (
    <div>
      <div style={{ fontWeight: 600, color: "var(--lb-text)" }}>{top}</div>
      {bottom && (
        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
          {bottom}
        </div>
      )}
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.2,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
