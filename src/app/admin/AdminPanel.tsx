"use client";

// Admin matrix — one row per user, one column per sidebar surface plus the
// edit flag. The matrix definition (`MODULES`) is the single source of
// truth for which modules exist on this deployment; it must stay in lockstep
// with src/components/Sidebar.tsx (every sidebar rail item maps to one
// module key here). Adding a new top-level surface requires:
//   1. add a `can_view_*` column to user_profiles + migration
//   2. add a permission helper in src/lib/permissions.ts
//   3. plumb the flag through src/app/layout.tsx → AppShell → Sidebar
//   4. add a MODULES entry below
//   5. add the field to AccessUpdate in actions.ts
// That's the contract — see Sidebar.tsx for the matching note.

import { useMemo, useState, useTransition } from "react";
import { ClientLogoUploader } from "@/app/suppliers/LogoUploader";
import { useRouter } from "next/navigation";
import type { UserProfile } from "@/db/schema";
import {
  ensureSupplierPortalToken,
  reissueSupplierPortalToken,
  revokeSupplierPortalToken,
} from "@/app/suppliers/rfq-actions";
import {
  addSupplierContact,
  deleteSupplierContact,
  setPrimarySupplierContact,
  updateSupplierContact,
} from "@/app/suppliers/actions";
import {
  createClient as createClientAction,
  setSupplierClient,
  setUserClient,
  setUserJobRole,
} from "./actions";
import { JOB_ROLES } from "@/lib/job-roles";
import {
  approveUser,
  approveUserFullView,
  revokeUser,
  updateUserAccess,
  type AccessUpdate,
} from "./actions";

// Each module the admin can grant/revoke per user. The `field` is the
// userProfiles column name; the `apply` callback builds the AccessUpdate
// patch for a flip. The order here drives the column order in the table
// and matches the sidebar top-to-bottom.
type ModuleKey =
  | "designEngineering"
  | "suppliers"
  | "crm"
  | "oee"
  | "competitors"
  | "handbook"
  | "engineering"
  | "edit";

type ModuleDef = {
  key: ModuleKey;
  label: string;
  hint: string;
  field: keyof UserProfile;
  color: string;
  applyKey: keyof AccessUpdate;
};

const MODULES: ModuleDef[] = [
  {
    key: "designEngineering",
    label: "Design & Eng.",
    hint: "/design-engineering",
    field: "canViewDesignEngineering",
    color: "#7c3aed",
    applyKey: "canViewDesignEngineering",
  },
  {
    key: "suppliers",
    label: "ERP System",
    hint: "/suppliers",
    field: "canViewSuppliers",
    color: "#2563eb",
    applyKey: "canViewSuppliers",
  },
  {
    key: "crm",
    label: "CRM",
    hint: "/crm",
    field: "canViewCrm",
    color: "#db2777",
    applyKey: "canViewCrm",
  },
  {
    key: "oee",
    label: "OEE & Floor",
    hint: "/oee",
    field: "canViewOee",
    color: "#0891b2",
    applyKey: "canViewOee",
  },
  {
    key: "competitors",
    label: "Competitors",
    hint: "/competitors",
    field: "canViewCompetitors",
    color: "#ea580c",
    applyKey: "canViewCompetitors",
  },
  {
    key: "handbook",
    label: "Process",
    hint: "/handbook",
    field: "canViewHandbook",
    color: "#16a34a",
    applyKey: "canViewHandbook",
  },
  {
    key: "engineering",
    label: "Engineering",
    hint: "/engineering",
    field: "canViewEngineering",
    color: "#ca8a04",
    applyKey: "canViewEngineering",
  },
  {
    key: "edit",
    label: "Can edit",
    hint: "write access",
    field: "canEdit",
    color: "#dc2626",
    applyKey: "canEdit",
  },
];

const VIEW_KEYS: ModuleKey[] = MODULES.filter((m) => m.key !== "edit").map(
  (m) => m.key,
);

export type AdminSupplierRow = {
  id: number;
  name: string;
  email: string | null;
  contactName: string | null;
  category: string | null;
  origin: string | null;
  isStarred: boolean;
  portalToken: string | null;
  clientId: number | null;
  invitedCount: number;
  // Multi-email contacts so the admin can edit each one inline.
  contacts?: AdminContactRow[];
};

export type AdminContactRow = {
  id: number;
  supplierId: number;
  name: string | null;
  email: string;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
  notes: string | null;
};

export type AdminClientRow = {
  id: number;
  name: string;
  industry: string | null;
  isActive: boolean;
  notes: string | null;
  logoUrl?: string | null;
  logoName?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Minimal slice of crm_accounts surfaced in the admin "Clients" tab for
// non-CADuniQ tenants (Lightbase admins see their own CRM accounts here;
// CADuniQ admins keep the multi-tenant directory under the same tab key).
type AdminCrmAccountRow = {
  id: number;
  name: string;
  website: string | null;
  industry: string | null;
  tier: string;
  country: string | null;
  healthScore: number;
  updatedAt: Date;
};

type Props = {
  users: UserProfile[];
  suppliers: AdminSupplierRow[];
  clients: AdminClientRow[];
  crmAccounts: AdminCrmAccountRow[];
  crmAccountTotal: number;
  isCaduniq: boolean;
  ownClientId: number | null;
  adminEmails: string[];
  adminDomains: string[];
  currentClerkId: string;
  clientName: string;
  clientIndustry: "manufacturing" | "construction";
  caduniqProductLabel: string;
  appBaseUrl: string;
};

export default function AdminPanel({
  users,
  suppliers,
  clients,
  crmAccounts,
  crmAccountTotal,
  isCaduniq,
  ownClientId,
  adminEmails,
  adminDomains,
  currentClerkId,
  clientName,
  clientIndustry,
  caduniqProductLabel,
  appBaseUrl,
}: Props) {
  const seededAdminSet = new Set(adminEmails.map((e) => e.toLowerCase()));
  const seededDomainSet = new Set(adminDomains.map((d) => d.toLowerCase()));
  function isSeeded(email: string): boolean {
    const lower = email.toLowerCase();
    if (seededAdminSet.has(lower)) return true;
    const at = lower.lastIndexOf("@");
    if (at === -1) return false;
    return seededDomainSet.has(lower.slice(at + 1));
  }
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Top-level segment — controls which list we render. Defaults to All so
  // returning admins land on the same place they always have. The breakdown:
  //   • All        — every user_profiles row (legacy behaviour)
  //   • Admins     — seeded admin accounts (@caduniq.com + named list)
  //   • Employees  — every non-admin user_profiles row (your team)
  //   • Suppliers  — every suppliers row (external, vendor-portal accounts)
  const [segment, setSegment] = useState<
    "all" | "admins" | "employees" | "suppliers" | "clients" | "crm-clients"
  >(isCaduniq ? "clients" : "all");
  // When the CADuniQ admin clicks into a client from the Clients segment,
  // we scope the other tabs (employees / suppliers) to that one client.
  // Null = no drill-down (cross-client view, only meaningful for caduniq).
  const [drillClientId, setDrillClientId] = useState<number | null>(null);
  // Non-caduniq admins are always scoped to their own client.
  const effectiveScopeClientId = isCaduniq ? drillClientId : ownClientId;
  const drilledClient = drillClientId != null ? clients.find((c) => c.id === drillClientId) : null;
  const [filter, setFilter] = useState<
    "all" | "pending" | "members" | "admins"
  >("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  function action<T>(id: string, fn: () => Promise<T>, success: string) {
    setBusy(id);
    startTransition(async () => {
      try {
        await fn();
        ping(success);
        router.refresh();
      } catch (e) {
        ping(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(null);
      }
    });
  }

  // Apply tenant scope FIRST — drilled-in client (caduniq) or own client
  // (non-caduniq). Non-caduniq users already have the data pre-filtered on
  // the server but we re-filter here so the count badges match the visible
  // rows. Caduniq with no drill-down sees everything.
  const tenantScopedUsers =
    effectiveScopeClientId != null
      ? users.filter((u) => u.clientId === effectiveScopeClientId)
      : users;
  const tenantScopedSuppliers =
    effectiveScopeClientId != null
      ? suppliers.filter((s) => s.clientId === effectiveScopeClientId)
      : suppliers;

  // Segment slicing of user_profiles — admins are anyone with a seeded
  // email; employees are everyone else (regardless of role pending/member).
  const adminUsers = tenantScopedUsers.filter((u) => isSeeded(u.email));
  const employeeUsers = tenantScopedUsers.filter((u) => !isSeeded(u.email));
  const segmentSource =
    segment === "admins" ? adminUsers : segment === "employees" ? employeeUsers : tenantScopedUsers;

  const filtered = segmentSource.filter((u) => {
    if (filter === "pending") return u.role === "pending";
    if (filter === "members") return u.role === "member";
    if (filter === "admins") return u.role === "admin";
    return true;
  });

  const pendingCount = segmentSource.filter((u) => u.role === "pending").length;
  const memberCount = segmentSource.filter((u) => u.role === "member").length;
  const adminCount = segmentSource.filter((u) => u.role === "admin").length;

  function userHasAllViews(u: UserProfile): boolean {
    if (u.role === "admin") return true;
    return VIEW_KEYS.every((k) => {
      const m = MODULES.find((x) => x.key === k);
      if (!m) return false;
      return Boolean(u[m.field]);
    });
  }

  function userHasNoViews(u: UserProfile): boolean {
    return VIEW_KEYS.every((k) => {
      const m = MODULES.find((x) => x.key === k);
      if (!m) return true;
      return !u[m.field];
    });
  }

  function grantAllViews(u: UserProfile) {
    const patch: AccessUpdate = { clerkUserId: u.clerkUserId };
    for (const m of MODULES) {
      if (m.key === "edit") continue;
      (patch[m.applyKey] as boolean | undefined) = true;
    }
    action(
      u.clerkUserId,
      () => updateUserAccess(patch),
      `Granted every section to ${u.email}`,
    );
  }

  function revokeAllViews(u: UserProfile) {
    const patch: AccessUpdate = { clerkUserId: u.clerkUserId };
    for (const m of MODULES) {
      if (m.key === "edit") continue;
      (patch[m.applyKey] as boolean | undefined) = false;
    }
    action(
      u.clerkUserId,
      () => updateUserAccess(patch),
      `Revoked every section for ${u.email}`,
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 w-full">
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2 rounded-md bg-zinc-900 text-white text-sm shadow-lg z-50">
          {toast}
        </div>
      )}

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {isCaduniq ? "Admin · Access Control" : "Admin"}
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">
          {isCaduniq
            ? "Manage every CADuniQ tenant. Pick a client below to drill into their team."
            : "Manage your team's accounts, job roles, and per-module access."}
        </p>
      </header>

      {/* CADuniQ-only deployment / multi-tenant context card. Client admins
          (e.g. hshah@lightbase.ca) don't see this — for them it's just
          noise that makes their admin feel like a sub-view of someone
          else's panel. They land on their own team's admin directly. */}
      {isCaduniq && (
        <ClientContextCard
          clientName={clientName}
          clientIndustry={clientIndustry}
          caduniqProductLabel={caduniqProductLabel}
          userCount={users.length}
          modules={MODULES}
          adminEmails={adminEmails}
          adminDomains={adminDomains}
        />
      )}

      {/* Breadcrumb — caduniq drilled into a client. Click the chip to go
          back to the Clients list. Non-caduniq admins don't see this since
          they're permanently scoped to their own client. */}
      {isCaduniq && drilledClient && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(124, 58, 237, 0.10)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: "var(--lb-text)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setDrillClientId(null);
              setSegment("clients");
              setFilter("all");
            }}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: "transparent",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ← All clients
          </button>
          <span style={{ color: "var(--lb-text-3)" }}>Viewing</span>
          <strong>{drilledClient.name}</strong>
          {drilledClient.industry && (
            <span style={{ color: "var(--lb-text-3)", textTransform: "capitalize" }}>
              · {drilledClient.industry}
            </span>
          )}
        </div>
      )}

      {/* Per-client brand mark — uploaded by an admin, appears as letterhead
          on every generated RFQ / PO PDF for this client. Only shown when
          drilled into a specific client. */}
      {isCaduniq && drilledClient && (
        <div style={{ marginBottom: 12 }}>
          <ClientLogoUploader
            clientId={drilledClient.id}
            currentUrl={drilledClient.logoUrl ?? null}
            currentName={drilledClient.logoName ?? null}
            label={`${drilledClient.name} brand mark`}
            hint="Used as letterhead on every generated RFQ / PO PDF for this client."
          />
        </div>
      )}
      {!isCaduniq && (
        <NonCaduniqOwnClientLogo
          clientId={ownClientId}
          clients={clients}
        />
      )}

      {/* Top-level segment strip. CADuniQ at the top level (no drill) sees
          only Clients; once drilled into a client they see the full set
          scoped to that client. Non-caduniq always sees the full set
          scoped to their own client. */}
      <nav
        role="tablist"
        aria-label="Admin sections"
        className="flex items-center gap-2 mb-4 overflow-x-auto"
      >
        {(!isCaduniq || drilledClient) && (
          <>
            <SegmentPill
              label={`All users (${tenantScopedUsers.length})`}
              active={segment === "all"}
              onClick={() => { setSegment("all"); setFilter("all"); }}
            />
            <SegmentPill
              label={`Admins (${adminUsers.length})`}
              active={segment === "admins"}
              onClick={() => { setSegment("admins"); setFilter("all"); }}
            />
            <SegmentPill
              label={`Employees (${employeeUsers.length})`}
              active={segment === "employees"}
              onClick={() => { setSegment("employees"); setFilter("all"); }}
            />
            <SegmentPill
              label={`Suppliers (${tenantScopedSuppliers.length})`}
              active={segment === "suppliers"}
              onClick={() => setSegment("suppliers")}
            />
            {/* CRM-linked Clients tab for non-CADuniQ tenants — surfaces */}
            {/* THIS tenant's own customers (crm_accounts), distinct from */}
            {/* the CADuniQ multi-tenant Clients directory above. */}
            {!isCaduniq && (
              <SegmentPill
                label={`Clients (${crmAccountTotal})`}
                active={segment === "crm-clients"}
                onClick={() => setSegment("crm-clients")}
              />
            )}
          </>
        )}
        {isCaduniq && (
          <SegmentPill
            label={`Clients (${clients.length})`}
            active={segment === "clients"}
            onClick={() => { setSegment("clients"); setDrillClientId(null); }}
          />
        )}
      </nav>

      {segment === "clients" ? (
        <ClientsSegment
          clients={clients}
          users={users}
          suppliers={suppliers}
          onOpen={(id) => {
            setDrillClientId(id);
            setSegment("all");
            setFilter("all");
          }}
        />
      ) : segment === "crm-clients" ? (
        <CrmClientsSegment
          accounts={crmAccounts}
          totalCount={crmAccountTotal}
        />
      ) : segment === "suppliers" ? (
        <SuppliersSegment
          suppliers={tenantScopedSuppliers}
          clients={clients}
          isCaduniq={isCaduniq}
          appBaseUrl={appBaseUrl}
        />
      ) : (
      <>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
        <Stat
          label="Total"
          value={segmentSource.length}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <Stat
          label="Pending"
          value={pendingCount}
          highlight={pendingCount > 0 ? "amber" : undefined}
          active={filter === "pending"}
          onClick={() => setFilter("pending")}
        />
        <Stat
          label="Members"
          value={memberCount}
          active={filter === "members"}
          onClick={() => setFilter("members")}
        />
        <Stat
          label="Admins"
          value={adminCount}
          active={filter === "admins"}
          onClick={() => setFilter("admins")}
        />
      </div>

      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-left px-4 py-3 font-medium">Job Role</th>
                {isCaduniq && (
                  <th className="text-left px-4 py-3 font-medium">Client</th>
                )}
                {MODULES.map((m) => (
                  <th
                    key={m.key}
                    className="text-center px-3 py-3 font-medium"
                    title={m.hint}
                  >
                    <span style={{ color: m.color }}>{m.label}</span>
                  </th>
                ))}
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={4 + (isCaduniq ? 1 : 0) + MODULES.length}
                    className="px-4 py-12 text-center text-zinc-500"
                  >
                    No users in this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((u) => {
                  const isSelf = u.clerkUserId === currentClerkId;
                  const isPrimary = isSeeded(u.email);
                  const isPending = u.role === "pending";
                  const hasAll = userHasAllViews(u);
                  const hasNone = userHasNoViews(u);
                  return (
                    <tr
                      key={u.clerkUserId}
                      className="border-t border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {u.displayName || u.email}
                        </div>
                        <div className="text-xs text-zinc-500">{u.email}</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          Joined {new Date(u.createdAt).toLocaleDateString()}
                          {u.approvedAt && (
                            <>
                              {" "}· approved{" "}
                              {new Date(u.approvedAt).toLocaleDateString()}
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadge role={u.role} />
                        {isPrimary && (
                          <span className="ml-1 text-[10px] text-amber-700 uppercase tracking-wider">
                            seeded
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={u.jobRole ?? ""}
                          disabled={busy === u.clerkUserId}
                          onChange={(e) => {
                            const next = e.target.value || null;
                            action(
                              u.clerkUserId,
                              () => setUserJobRole({ clerkUserId: u.clerkUserId, jobRole: next }),
                              next ? `Job role: ${next}` : "Job role cleared",
                            );
                          }}
                          className="px-2 py-1 rounded text-xs border bg-transparent border-zinc-300 dark:border-zinc-700"
                          style={{ minWidth: 140 }}
                        >
                          <option value="">— set job role —</option>
                          {JOB_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      {isCaduniq && (
                        <td className="px-4 py-3">
                          <select
                            value={u.clientId ?? ""}
                            disabled={busy === u.clerkUserId}
                            onChange={(e) => {
                              const next = e.target.value === "" ? null : Number(e.target.value);
                              action(
                                u.clerkUserId,
                                () => setUserClient({ clerkUserId: u.clerkUserId, clientId: next }),
                                next ? "Client updated" : "Cross-client (no tenant)",
                              );
                            }}
                            className="px-2 py-1 rounded text-xs border bg-transparent border-zinc-300 dark:border-zinc-700"
                            style={{ minWidth: 140 }}
                          >
                            <option value="">— CADuniQ (cross-client) —</option>
                            {clients.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      {MODULES.map((m) => {
                        const fieldVal = Boolean(u[m.field]);
                        const checked = u.role === "admin" || fieldVal;
                        return (
                          <td
                            key={m.key}
                            className="px-3 py-3 text-center"
                          >
                            <Toggle
                              color={m.color}
                              checked={checked}
                              disabled={
                                isPending ||
                                u.role === "admin" ||
                                busy === u.clerkUserId
                              }
                              onChange={(v) =>
                                action(
                                  u.clerkUserId,
                                  () =>
                                    updateUserAccess({
                                      clerkUserId: u.clerkUserId,
                                      [m.applyKey]: v,
                                    } as AccessUpdate),
                                  `${m.label}: ${v ? "granted" : "revoked"}`,
                                )
                              }
                            />
                          </td>
                        );
                      })}
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2 flex-wrap">
                          {isPending && (
                            <>
                              <Btn
                                onClick={() =>
                                  action(
                                    u.clerkUserId,
                                    () => approveUserFullView(u.clerkUserId),
                                    "Approved · all sections",
                                  )
                                }
                              >
                                Approve · all sections
                              </Btn>
                              <Btn
                                variant="ghost"
                                onClick={() =>
                                  action(
                                    u.clerkUserId,
                                    () =>
                                      approveUser(u.clerkUserId, {
                                        canViewSuppliers: true,
                                        canViewCompetitors: false,
                                        canViewHandbook: false,
                                        canViewEngineering: false,
                                        canViewDesignEngineering: false,
                                        canViewCrm: false,
                                        canViewOee: false,
                                        canEdit: false,
                                      }),
                                    "Approved · ERP only",
                                  )
                                }
                              >
                                ERP only
                              </Btn>
                            </>
                          )}
                          {!isPending && !hasAll && (
                            <Btn
                              variant="ghost"
                              disabled={busy === u.clerkUserId}
                              onClick={() => grantAllViews(u)}
                            >
                              Grant all
                            </Btn>
                          )}
                          {!isPending && !hasNone && u.role !== "admin" && (
                            <Btn
                              variant="ghost"
                              disabled={busy === u.clerkUserId}
                              onClick={() => revokeAllViews(u)}
                            >
                              Revoke all
                            </Btn>
                          )}
                          {u.role === "member" && (
                            <Btn
                              variant="ghost"
                              onClick={() =>
                                action(
                                  u.clerkUserId,
                                  () =>
                                    updateUserAccess({
                                      clerkUserId: u.clerkUserId,
                                      role: "admin",
                                    }),
                                  "Promoted to admin",
                                )
                              }
                            >
                              Promote to admin
                            </Btn>
                          )}
                          {!isPrimary && !isSelf && (
                            <Btn
                              variant="danger"
                              disabled={busy === u.clerkUserId}
                              onClick={() => {
                                if (!confirm(`Revoke all access for ${u.email}?`))
                                  return;
                                action(
                                  u.clerkUserId,
                                  () => revokeUser(u.clerkUserId),
                                  "Revoked",
                                );
                              }}
                            >
                              {u.role === "pending" ? "Reject" : "Revoke"}
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SegmentPill — top-of-page tab strip selector for Admin sections.
// ─────────────────────────────────────────────────────────────────────────────

function SegmentPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 16px",
        borderRadius: 999,
        background: active ? "var(--lb-accent)" : "var(--lb-bg-elev)",
        color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
        border: active ? "1px solid var(--lb-accent)" : "1px solid var(--lb-border)",
        fontSize: 12.5,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SuppliersSegment — admin view of every external supplier with vendor-portal
// access controls. Lists the supplier, their stable home portal URL (with
// copy / re-issue / revoke), and how many RFQs they've been invited to.
// Clicking a row drills into the supplier in the ERP directory.
// ─────────────────────────────────────────────────────────────────────────────

function SuppliersSegment({
  suppliers,
  clients,
  isCaduniq,
  appBaseUrl,
}: {
  suppliers: AdminSupplierRow[];
  clients: AdminClientRow[];
  isCaduniq: boolean;
  appBaseUrl: string;
}) {
  return (
    <AdminSuppliersTable
      suppliers={suppliers}
      clients={clients}
      isCaduniq={isCaduniq}
      appBaseUrl={appBaseUrl}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CrmClientsSegment — non-CADuniQ tenants' "Clients" tab. Surfaces THIS
// tenant's own CRM accounts (Lightbase's customers) with health, tier,
// and a deep link to the full /crm/accounts module. The admin panel
// shows a top-50 snapshot so the team can glance at who's in their CRM
// without leaving the admin; the "Open full CRM" link takes them to the
// real CRM workspace for filtering, editing, opportunities, etc.
// ─────────────────────────────────────────────────────────────────────────────

function CrmClientsSegment({
  accounts,
  totalCount,
}: {
  accounts: AdminCrmAccountRow[];
  totalCount: number;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) =>
      `${a.name} ${a.industry ?? ""} ${a.country ?? ""} ${a.website ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [accounts, query]);

  const tierStyle = (tier: string): React.CSSProperties => ({
    padding: "2px 9px",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    borderRadius: 999,
    border: "1px solid",
    ...(tier === "strategic"
      ? { borderColor: "#7c3aed", color: "#7c3aed", background: "rgba(124,58,237,0.08)" }
      : tier === "key"
        ? { borderColor: "#0891b2", color: "#0891b2", background: "rgba(8,145,178,0.08)" }
        : tier === "active"
          ? { borderColor: "#16a34a", color: "#16a34a", background: "rgba(22,163,74,0.08)" }
          : tier === "lead"
            ? { borderColor: "#ca8a04", color: "#ca8a04", background: "rgba(202,138,4,0.08)" }
            : { borderColor: "var(--lb-border)", color: "var(--lb-text-3)" }),
  });

  function healthColor(score: number): string {
    if (score >= 75) return "#16a34a";
    if (score >= 50) return "#ca8a04";
    return "#dc2626";
  }

  return (
    <section style={{
      background: "var(--lb-bg-elev)",
      border: "1px solid var(--lb-border)",
      borderRadius: 14,
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>Clients</h2>
          <p style={{ fontSize: 13, color: "var(--lb-text-3)", margin: "4px 0 0", maxWidth: 720 }}>
            Your customer accounts from the CRM module. This is a snapshot of the most
            recently updated {accounts.length} of {totalCount.toLocaleString()} total accounts —
            use the link below to manage pipelines, contacts, opportunities, and tickets.
          </p>
        </div>
        <a
          href="/crm/accounts"
          style={{
            padding: "8px 14px",
            fontSize: 12.5,
            fontWeight: 700,
            borderRadius: 999,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Open full CRM →
        </a>
      </header>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter the snapshot…"
        style={{
          padding: "8px 12px",
          fontSize: 13,
          borderRadius: 8,
          background: "var(--lb-bg)",
          color: "var(--lb-text)",
          border: "1px solid var(--lb-border)",
          outline: "none",
        }}
      />

      {accounts.length === 0 ? (
        <div style={{
          padding: 28,
          textAlign: "center",
          color: "var(--lb-text-3)",
          fontSize: 13,
          border: "1px dashed var(--lb-border)",
          borderRadius: 10,
        }}>
          No clients in your CRM yet. <a href="/crm/accounts" style={{ color: "var(--lb-accent)" }}>Add your first account in the CRM →</a>
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--lb-border)", borderRadius: 10, background: "var(--lb-bg)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--lb-border)", background: "var(--lb-bg-elev)" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Client</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Industry</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Country</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Tier</th>
                <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Health</th>
                <th style={{ width: 60 }} aria-hidden />
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid var(--lb-border)" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <a href={`/crm/accounts/${a.id}`} style={{ color: "var(--lb-text)", fontWeight: 600, textDecoration: "none" }}>
                      {a.name}
                    </a>
                    {a.website && (
                      <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 2 }}>
                        <a href={a.website.startsWith("http") ? a.website : `https://${a.website}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lb-text-3)" }}>
                          {a.website.replace(/^https?:\/\//, "")}
                        </a>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px", color: "var(--lb-text-2)" }}>{a.industry ?? "—"}</td>
                  <td style={{ padding: "10px 12px", color: "var(--lb-text-2)" }}>{a.country ?? "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={tierStyle(a.tier)}>{a.tier}</span>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    <span style={{
                      display: "inline-block",
                      minWidth: 36,
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: healthColor(a.healthScore),
                      border: `1px solid ${healthColor(a.healthScore)}`,
                    }}>
                      {a.healthScore}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    <a href={`/crm/accounts/${a.id}`} aria-label={`Open ${a.name} in CRM`} style={{ color: "var(--lb-accent)", textDecoration: "none", fontSize: 14 }}>→</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
        Showing {filtered.length} of {totalCount.toLocaleString()} client{totalCount === 1 ? "" : "s"}. Full search, pipeline, opportunities, and tickets live in the
        {" "}<a href="/crm/accounts" style={{ color: "var(--lb-accent)" }}>CRM workspace</a>.
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ClientsSegment — CADuniQ-only view that lists every tenant (Lightbase,
// other future clients) with quick counts and a + New client button.
// Click into a client name to scope the rest of the admin view to it (v2 —
// for now it's a flat list with counts so admins see what's there).
// ─────────────────────────────────────────────────────────────────────────────

function ClientsSegment({
  clients,
  users,
  suppliers,
  onOpen,
}: {
  clients: AdminClientRow[];
  users: UserProfile[];
  suppliers: AdminSupplierRow[];
  onOpen: (clientId: number) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIndustry, setNewIndustry] = useState("manufacturing");
  const [toast, setToast] = useState<string | null>(null);
  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  function create() {
    if (!newName.trim()) return;
    setCreating(true);
    startTransition(async () => {
      try {
        await createClientAction({ name: newName, industry: newIndustry });
        ping(`Client "${newName}" created`);
        setNewName("");
        router.refresh();
      } catch (e) {
        ping(e instanceof Error ? e.message : "Create failed");
      } finally {
        setCreating(false);
      }
    });
  }

  return (
    <section
      style={{
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
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
          }}
        >
          {toast}
        </div>
      )}
      <div>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Clients</h2>
        <p style={{ fontSize: 12, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
          Each row is one CADuniQ client tenant. <b>Click a row</b> to open
          that client's admin and see their employees + suppliers in
          isolation. CADuniQ staff (@caduniq.com) can browse every tenant;
          client-side admins only see their own.
        </p>
      </div>

      {/* New client form */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px dashed var(--lb-border)",
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.5, textTransform: "uppercase" }}>
            New client name
          </span>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Acme Builders"
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 180 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.5, textTransform: "uppercase" }}>
            Industry
          </span>
          <select
            value={newIndustry}
            onChange={(e) => setNewIndustry(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              fontSize: 13,
            }}
          >
            <option value="manufacturing">Manufacturing</option>
            <option value="construction">Construction</option>
          </select>
        </label>
        <button
          type="button"
          onClick={create}
          disabled={creating || !newName.trim()}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: creating ? "wait" : "pointer",
            opacity: creating || !newName.trim() ? 0.6 : 1,
          }}
        >
          + Create client
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--lb-border)" }}>
              <SupTh>Client</SupTh>
              <SupTh>Industry</SupTh>
              <SupTh style={{ textAlign: "right" }}>Employees</SupTh>
              <SupTh style={{ textAlign: "right" }}>Suppliers</SupTh>
              <SupTh>Status</SupTh>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--lb-text-3)" }}>
                  No clients yet. Create the first one above.
                </td>
              </tr>
            ) : (
              clients.map((c) => {
                const empCount = users.filter((u) => u.clientId === c.id).length;
                const supCount = suppliers.filter((s) => s.clientId === c.id).length;
                return (
                  <tr
                    key={c.id}
                    onClick={() => onOpen(c.id)}
                    style={{
                      borderBottom: "1px solid var(--lb-border)",
                      cursor: "pointer",
                    }}
                    title={`Open ${c.name}'s admin scope`}
                  >
                    <SupTd>
                      <strong style={{ color: "var(--lb-accent)" }}>{c.name}</strong>
                      {c.notes && (
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{c.notes}</div>
                      )}
                    </SupTd>
                    <SupTd style={{ color: "var(--lb-text-2)", textTransform: "capitalize" }}>
                      {c.industry ?? "—"}
                    </SupTd>
                    <SupTd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{empCount}</SupTd>
                    <SupTd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{supCount}</SupTd>
                    <SupTd>
                      {c.isActive ? (
                        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 5, background: "rgba(22,163,74,0.18)", color: "#16a34a", fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                          Active
                        </span>
                      ) : (
                        <span style={{ color: "var(--lb-text-3)" }}>Inactive</span>
                      )}
                      <span style={{ marginLeft: 8, color: "var(--lb-text-3)", fontSize: 12 }}>→</span>
                    </SupTd>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "var(--lb-text-3)", margin: 0 }}>
        Clicking a client row above opens that client's scoped admin —
        breadcrumb at the top lets you jump back to this list. Suppliers
        shown anywhere in the admin are only those with active vendor-portal
        accounts (Clerk sign-in or magic-link engagement); the long-tail
        directory rows that never engaged are excluded.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CONTEXT — surfaces "which client / industry / module set is this
// deployment serving" so the admin sees the scope of their changes.
// ─────────────────────────────────────────────────────────────────────────────

function ClientContextCard({
  clientName,
  clientIndustry,
  caduniqProductLabel,
  userCount,
  modules,
  adminEmails,
  adminDomains,
}: {
  clientName: string;
  clientIndustry: "manufacturing" | "construction";
  caduniqProductLabel: string;
  userCount: number;
  modules: ModuleDef[];
  adminEmails: string[];
  adminDomains: string[];
}) {
  return (
    <section className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
      <div
        className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-900"
        style={{
          background:
            "linear-gradient(120deg, rgba(234, 88, 12, 0.07), transparent)",
        }}
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-bold">
              Client deployment
            </div>
            <div className="text-xl font-semibold tracking-tight mt-1">
              {clientName}
              <span className="ml-2 text-xs font-medium text-zinc-500 capitalize">
                · {clientIndustry}
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              Product line: <b>{caduniqProductLabel}</b> · {userCount} user
              {userCount === 1 ? "" : "s"} on this deployment
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 max-w-md text-right">
            Each CADuniQ client runs on its own deployment. The toggles below
            only affect users on the <b>{clientName}</b> dashboard — other
            client deployments are managed independently from their own
            admin pages.
          </div>
        </div>
      </div>

      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-bold mb-2">
            Modules on this deployment
          </div>
          <div className="flex flex-wrap gap-2">
            {modules.map((m) => (
              <span
                key={m.key}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium"
                style={{
                  background: `${m.color}18`,
                  color: m.color,
                  border: `1px solid ${m.color}33`,
                }}
                title={m.hint}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: m.color,
                  }}
                />
                {m.label}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-bold mb-2">
            Auto-admin policy
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            Any mailbox on{" "}
            {adminDomains.map((d, i) => (
              <span key={d}>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  @{d}
                </span>
                {i < adminDomains.length - 1 ? ", " : ""}
              </span>
            ))}{" "}
            is auto-promoted to admin (CADuniQ staff). Named admin
            {adminEmails.length === 1 ? "" : "s"}:{" "}
            {adminEmails.map((email, i) => (
              <span key={email}>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {email}
                </span>
                {i < adminEmails.length - 1 ? ", " : ""}
              </span>
            ))}
            . Seeded admins cannot be demoted via this panel.
          </p>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  active,
  highlight,
  onClick,
}: {
  label: string;
  value: number;
  active?: boolean;
  highlight?: "amber";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-xl border px-4 py-3 text-left transition-colors " +
        (active
          ? "border-zinc-900 bg-zinc-900 text-white dark:bg-white dark:text-black dark:border-white"
          : "border-zinc-200 bg-white dark:bg-zinc-950 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-700")
      }
    >
      <div
        className={
          "text-xs uppercase tracking-wide " +
          (active ? "opacity-80" : "text-zinc-500")
        }
      >
        {label}
      </div>
      <div
        className={
          "text-2xl font-semibold mt-1 " +
          (highlight === "amber" && !active ? "text-amber-600" : "")
        }
      >
        {value}
      </div>
    </button>
  );
}

function RoleBadge({ role }: { role: "admin" | "member" | "pending" }) {
  const cls =
    role === "admin"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
      : role === "member"
        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${cls}`}
    >
      {role}
    </span>
  );
}

function Toggle({
  checked,
  disabled,
  color,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  color?: string;
  onChange: (v: boolean) => void;
}) {
  const onBg = color ?? "#16a34a";
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={
        "inline-flex h-5 w-9 rounded-full transition-colors " +
        (disabled ? "opacity-40 cursor-not-allowed " : "cursor-pointer ")
      }
      style={{
        background: checked ? onBg : "var(--lb-border)",
      }}
    >
      <span
        className={
          "inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transform transition-transform " +
          (checked ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function Btn({
  children,
  variant = "primary",
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const cls =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      : variant === "danger"
        ? "border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
        : "border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-md text-xs font-medium ${cls} disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AdminSuppliersTable — searchable supplier directory with per-row portal
// controls. The admin can:
//   • copy the supplier's home portal URL (one place, all their RFQs)
//   • generate the URL if missing (idempotent)
//   • re-issue the token (old URL stops working — for when a contact leaves)
//   • revoke the token entirely (suspends supplier portal access)
// ─────────────────────────────────────────────────────────────────────────────

function AdminSuppliersTable({
  suppliers,
  clients,
  isCaduniq,
  appBaseUrl,
}: {
  suppliers: AdminSupplierRow[];
  clients: AdminClientRow[];
  isCaduniq: boolean;
  appBaseUrl: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Per-row expanded state — clicking ▸ opens the inline contacts editor.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) => {
      const contactEmails = (s.contacts ?? []).map((c) => c.email).join(" ");
      return `${s.name} ${s.email ?? ""} ${contactEmails} ${s.category ?? ""} ${s.origin ?? ""} ${s.contactName ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [suppliers, query]);

  function run<T>(id: number, label: string, fn: () => Promise<T>, onResult?: (r: T) => void) {
    setBusyId(id);
    startTransition(async () => {
      try {
        const r = await fn();
        ping(label);
        if (onResult) onResult(r);
        router.refresh();
      } catch (e) {
        ping(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <section
      style={{
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
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
          }}
        >
          {toast}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Suppliers · Vendor Portal Access</h2>
          <p style={{ fontSize: 12, color: "var(--lb-text-3)", margin: "4px 0 0" }}>
            External vendors (separate from your team). Each supplier has a
            stable home portal listing every RFQ they've been invited to.
            Copy the URL to email it. Re-issue if a contact leaves. Revoke
            to suspend access entirely.
          </p>
        </div>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${suppliers.length} suppliers by name, email, category…`}
        style={{
          padding: "10px 14px",
          borderRadius: 999,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 13,
        }}
      />

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--lb-border)" }}>
              <SupTh>Supplier</SupTh>
              <SupTh>Email</SupTh>
              <SupTh>Category</SupTh>
              {isCaduniq && <SupTh>Client</SupTh>}
              <SupTh style={{ textAlign: "right" }}>RFQs invited</SupTh>
              <SupTh>Portal access</SupTh>
              <SupTh style={{ textAlign: "right" }}>Actions</SupTh>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={isCaduniq ? 7 : 6} style={{ padding: 24, textAlign: "center", color: "var(--lb-text-3)" }}>
                  No suppliers match.
                </td>
              </tr>
            ) : (
              filtered.flatMap((s) => {
                const busy = busyId === s.id;
                const hasToken = !!s.portalToken;
                const portalUrl = hasToken ? `${appBaseUrl}/vendor/home/${s.portalToken}` : "";
                const contacts = s.contacts ?? [];
                const isExpanded = expandedId === s.id;
                const mainRow = (
                  <tr
                    key={`r-${s.id}`}
                    style={{ borderBottom: "1px solid var(--lb-border)", opacity: busy ? 0.55 : 1 }}
                  >
                    <SupTd>
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : s.id)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          background: "transparent",
                          border: 0,
                          color: "var(--lb-text)",
                          fontWeight: 700,
                          cursor: "pointer",
                          padding: 0,
                          textAlign: "left",
                        }}
                        title="Click to manage contact emails"
                      >
                        <span style={{ color: "var(--lb-text-3)", fontSize: 10 }}>{isExpanded ? "▾" : "▸"}</span>
                        {s.isStarred && <span style={{ color: "#facc15" }}>★</span>}
                        <strong>{s.name}</strong>
                      </button>
                      {s.contactName && (
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{s.contactName}</div>
                      )}
                    </SupTd>
                    <SupTd style={{ color: "var(--lb-text-2)", fontVariantNumeric: "tabular-nums" }}>
                      {s.email ?? <span style={{ color: "var(--lb-text-3)" }}>— no email</span>}
                      {contacts.length > 1 && (
                        <div style={{ fontSize: 10.5, color: "var(--lb-text-3)", marginTop: 2 }}>
                          + {contacts.length - 1} more
                        </div>
                      )}
                    </SupTd>
                    <SupTd style={{ color: "var(--lb-text-3)" }}>
                      {s.category ?? "—"}
                      {s.origin && <div style={{ fontSize: 10.5 }}>{s.origin}</div>}
                    </SupTd>
                    {isCaduniq && (
                      <SupTd>
                        <select
                          value={s.clientId ?? ""}
                          disabled={busy}
                          onChange={(e) => {
                            const next = e.target.value === "" ? null : Number(e.target.value);
                            run(
                              s.id,
                              "Client assignment updated",
                              () => setSupplierClient({ supplierId: s.id, clientId: next }),
                            );
                          }}
                          style={{
                            padding: "3px 8px",
                            borderRadius: 5,
                            background: "var(--lb-bg)",
                            border: "1px solid var(--lb-border)",
                            color: "var(--lb-text)",
                            fontSize: 11,
                          }}
                        >
                          <option value="">— Cross-client</option>
                          {clients.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </SupTd>
                    )}
                    <SupTd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {s.invitedCount}
                    </SupTd>
                    <SupTd>
                      {hasToken ? (
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(portalUrl);
                            ping("Portal URL copied to clipboard");
                          }}
                          title={portalUrl}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 6,
                            background: "rgba(8,145,178,0.15)",
                            color: "#0891b2",
                            border: "1px solid rgba(8,145,178,0.4)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            maxWidth: 320,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            textAlign: "left",
                          }}
                        >
                          📋 {portalUrl.replace(/^https?:\/\//, "")}
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontStyle: "italic" }}>
                          No portal token yet — click Generate →
                        </span>
                      )}
                    </SupTd>
                    <SupTd style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        {!hasToken && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(
                              s.id,
                              "Portal URL generated · copied",
                              () => ensureSupplierPortalToken({ supplierId: s.id }),
                              async (res) => { try { await navigator.clipboard.writeText(res.portalUrl); } catch {} },
                            )}
                            style={tinyBtn("#16a34a")}
                          >
                            + Generate
                          </button>
                        )}
                        {hasToken && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => run(
                                s.id,
                                "New portal URL · old link disabled",
                                () => reissueSupplierPortalToken({ supplierId: s.id }),
                                async (res) => { try { await navigator.clipboard.writeText(res.portalUrl); } catch {} },
                              )}
                              style={tinyBtn("#7c3aed")}
                              title="Generate a new portal token; the old URL stops working."
                            >
                              ↻ Re-issue
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                if (!confirm(`Revoke ${s.name}'s vendor portal access? The URL stops working immediately. You can re-generate one later.`)) return;
                                run(
                                  s.id,
                                  "Portal access revoked",
                                  () => revokeSupplierPortalToken({ supplierId: s.id }),
                                );
                              }}
                              style={tinyBtn("#dc2626")}
                              title="Disable the supplier's home portal entirely."
                            >
                              🚫 Revoke
                            </button>
                          </>
                        )}
                      </div>
                    </SupTd>
                  </tr>
                );
                const expandedRow = isExpanded ? (
                  <tr key={`x-${s.id}`} style={{ borderBottom: "1px solid var(--lb-border)" }}>
                    <td colSpan={isCaduniq ? 7 : 6} style={{ padding: "0 10px 12px 30px", background: "var(--lb-bg)" }}>
                      <SupplierContactsEditor
                        supplierId={s.id}
                        supplierName={s.name}
                        contacts={contacts}
                        busy={busy}
                        onAction={(label, fn) => run(s.id, label, fn)}
                      />
                    </td>
                  </tr>
                ) : null;
                return expandedRow ? [mainRow, expandedRow] : [mainRow];
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Inline contacts editor used inside the admin supplier table's expandable
// row. Lists every email on file for a supplier and lets the admin add,
// rename, edit-email, mark-primary, or delete each one. All actions
// round-trip to the existing supplier-contacts server actions.
function SupplierContactsEditor({
  supplierId,
  supplierName,
  contacts,
  busy,
  onAction,
}: {
  supplierId: number;
  supplierName: string;
  contacts: AdminContactRow[];
  busy: boolean;
  onAction: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [draftRole, setDraftRole] = useState("");
  // Per-row inline-edit state. null = nothing being edited.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");

  function add() {
    const email = draftEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      alert("Valid email required");
      return;
    }
    onAction(
      `Added ${email} to ${supplierName}`,
      () => addSupplierContact({
        supplierId,
        email,
        name: draftName.trim() || undefined,
        role: draftRole.trim() || undefined,
      }),
    );
    setDraftName("");
    setDraftEmail("");
    setDraftRole("");
  }

  function beginEdit(c: AdminContactRow) {
    setEditingId(c.id);
    setEditEmail(c.email);
    setEditName(c.name ?? "");
    setEditRole(c.role ?? "");
  }
  function saveEdit() {
    if (editingId == null) return;
    onAction(
      "Contact updated",
      () => updateSupplierContact({
        id: editingId,
        email: editEmail,
        name: editName,
        role: editRole,
      }),
    );
    setEditingId(null);
  }
  function cancelEdit() {
    setEditingId(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 10, borderRadius: 8, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase" }}>
        Contact emails ({contacts.length}) · {supplierName}
      </div>

      {contacts.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--lb-text-3)", fontStyle: "italic" }}>
          No contacts on file yet — add one below.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {contacts.map((c) => (
            <div
              key={c.id}
              style={{
                padding: 8,
                borderRadius: 6,
                background: "var(--lb-bg)",
                border: `1px solid ${c.isPrimary ? "rgba(8,145,178,0.45)" : "var(--lb-border)"}`,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {editingId === c.id ? (
                <>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name" style={tinyInputStyle} />
                  <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="email@x.com" type="email" style={tinyInputStyle} />
                  <input value={editRole} onChange={(e) => setEditRole(e.target.value)} placeholder="Role (Sales / AP / …)" style={tinyInputStyle} />
                  <button type="button" disabled={busy} onClick={saveEdit} style={tinyBtn("#16a34a")}>✓ Save</button>
                  <button type="button" onClick={cancelEdit} style={tinyBtn("#475569")}>Cancel</button>
                </>
              ) : (
                <>
                  {c.isPrimary && (
                    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, background: "rgba(8,145,178,0.18)", color: "#0891b2" }}>
                      Primary
                    </span>
                  )}
                  <strong style={{ fontSize: 12.5 }}>{c.email}</strong>
                  {c.name && <span style={{ fontSize: 11.5, color: "var(--lb-text-2)" }}>· {c.name}</span>}
                  {c.role && <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>· {c.role}</span>}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <button type="button" disabled={busy} onClick={() => beginEdit(c)} style={tinyBtn("#7c3aed")}>✎ Edit</button>
                    {!c.isPrimary && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onAction("Primary contact changed", () => setPrimarySupplierContact(c.id))}
                        style={tinyBtn("#0891b2")}
                        title="Mirror this email back to suppliers.email"
                      >
                        ★ Primary
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`Remove ${c.email} from ${supplierName}?`)) return;
                        onAction("Contact removed", () => deleteSupplierContact(c.id));
                      }}
                      style={tinyBtn("#dc2626")}
                    >
                      ✕ Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add a new contact email */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingTop: 6, borderTop: "1px dashed var(--lb-border)" }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase" }}>
          + Add email
        </span>
        <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name (optional)" style={tinyInputStyle} />
        <input value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} placeholder="email@supplier.com" type="email" style={tinyInputStyle} />
        <input value={draftRole} onChange={(e) => setDraftRole(e.target.value)} placeholder="Role (optional)" style={tinyInputStyle} />
        <button
          type="button"
          disabled={busy || !draftEmail.includes("@")}
          onClick={add}
          style={tinyBtn("#16a34a")}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

const tinyInputStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 5,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 11.5,
  minWidth: 120,
};

function SupTh({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
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
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function SupTd({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 10px", verticalAlign: "top", ...style }}>{children}</td>;
}

function tinyBtn(color: string): React.CSSProperties {
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


// Non-CADuniQ admins are locked to their own client tenant — show the logo
// uploader for that single client at the top of the admin panel so they
// can manage their brand mark without having to drill anywhere.
function NonCaduniqOwnClientLogo({
  clientId,
  clients,
}: {
  clientId: number | null;
  clients: AdminClientRow[];
}) {
  if (clientId == null) return null;
  const c = clients.find((x) => x.id === clientId);
  if (!c) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <ClientLogoUploader
        clientId={c.id}
        currentUrl={c.logoUrl ?? null}
        currentName={c.logoName ?? null}
        label={`${c.name} brand mark`}
        hint="Used as the letterhead on every generated RFQ / PO PDF for your company."
      />
    </div>
  );
}
