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

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserProfile } from "@/db/schema";
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

type Props = {
  users: UserProfile[];
  adminEmails: string[];
  adminDomains: string[];
  currentClerkId: string;
  clientName: string;
  clientIndustry: "manufacturing" | "construction";
  caduniqProductLabel: string;
};

export default function AdminPanel({
  users,
  adminEmails,
  adminDomains,
  currentClerkId,
  clientName,
  clientIndustry,
  caduniqProductLabel,
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

  const filtered = users.filter((u) => {
    if (filter === "pending") return u.role === "pending";
    if (filter === "members") return u.role === "member";
    if (filter === "admins") return u.role === "admin";
    return true;
  });

  const pendingCount = users.filter((u) => u.role === "pending").length;
  const memberCount = users.filter((u) => u.role === "member").length;
  const adminCount = users.filter((u) => u.role === "admin").length;

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
        <h1 className="text-2xl font-semibold tracking-tight">Admin · Access Control</h1>
        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">
          One toggle per sidebar surface, per user. Every module on the rail
          has its own column below — granting a user "Design & Eng." opens
          the Design & Engineering rail item; revoking "ERP System" hides
          the /suppliers route entirely. Admins always see everything.
        </p>
      </header>

      {/* Client / deployment context card */}
      <ClientContextCard
        clientName={clientName}
        clientIndustry={clientIndustry}
        caduniqProductLabel={caduniqProductLabel}
        userCount={users.length}
        modules={MODULES}
        adminEmails={adminEmails}
        adminDomains={adminDomains}
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
        <Stat
          label="Total"
          value={users.length}
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
                    colSpan={3 + MODULES.length}
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
    </div>
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
