"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserProfile } from "@/db/schema";
import { updateUserAccess, approveUser, revokeUser } from "./actions";

export default function AdminPanel({
  users, adminEmail, currentClerkId,
}: {
  users: UserProfile[];
  adminEmail: string;
  currentClerkId: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<"all" | "pending" | "members" | "admins">("all");
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

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 w-full">
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2 rounded-md bg-zinc-900 text-white text-sm shadow-lg z-50">
          {toast}
        </div>
      )}

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">User Access</h1>
        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">
          Approve sign-ups and control which areas each member can see. Primary admin: <span className="font-medium">{adminEmail}</span>.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Total" value={users.length} active={filter === "all"} onClick={() => setFilter("all")} />
        <Stat label="Pending" value={pendingCount} highlight={pendingCount > 0 ? "amber" : undefined} active={filter === "pending"} onClick={() => setFilter("pending")} />
        <Stat label="Members" value={memberCount} active={filter === "members"} onClick={() => setFilter("members")} />
        <Stat label="Admins" value={adminCount} active={filter === "admins"} onClick={() => setFilter("admins")} />
      </div>

      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-center px-4 py-3 font-medium">Suppliers</th>
                <th className="text-center px-4 py-3 font-medium">Competitors</th>
                <th className="text-center px-4 py-3 font-medium">Edit</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-zinc-500">No users in this filter.</td></tr>
              ) : filtered.map((u) => {
                const isSelf = u.clerkUserId === currentClerkId;
                const isPrimary = u.email === adminEmail.toLowerCase();
                const isPending = u.role === "pending";
                return (
                  <tr key={u.clerkUserId} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.displayName || u.email}</div>
                      <div className="text-xs text-zinc-500">{u.email}</div>
                      <div className="text-[11px] text-zinc-400 mt-0.5">
                        Joined {new Date(u.createdAt).toLocaleDateString()}
                        {u.approvedAt && <> · approved {new Date(u.approvedAt).toLocaleDateString()}</>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={u.role} />
                      {isPrimary && <span className="ml-1 text-[10px] text-amber-700 uppercase tracking-wider">primary</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Toggle
                        checked={u.role === "admin" || u.canViewSuppliers}
                        disabled={isPending || u.role === "admin" || busy === u.clerkUserId}
                        onChange={(v) => action(u.clerkUserId, () => updateUserAccess({ clerkUserId: u.clerkUserId, canViewSuppliers: v }), "Updated")}
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Toggle
                        checked={u.role === "admin" || u.canViewCompetitors}
                        disabled={isPending || u.role === "admin" || busy === u.clerkUserId}
                        onChange={(v) => action(u.clerkUserId, () => updateUserAccess({ clerkUserId: u.clerkUserId, canViewCompetitors: v }), "Updated")}
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Toggle
                        checked={u.role === "admin" || u.canEdit}
                        disabled={isPending || u.role === "admin" || busy === u.clerkUserId}
                        onChange={(v) => action(u.clerkUserId, () => updateUserAccess({ clerkUserId: u.clerkUserId, canEdit: v }), "Updated")}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2 flex-wrap">
                        {isPending && (
                          <>
                            <Btn onClick={() => action(u.clerkUserId, () => approveUser(u.clerkUserId, { canViewSuppliers: true, canViewCompetitors: true, canEdit: false }), "Approved with full view access")}>
                              Approve · view both
                            </Btn>
                            <Btn variant="ghost" onClick={() => action(u.clerkUserId, () => approveUser(u.clerkUserId, { canViewSuppliers: true, canViewCompetitors: false, canEdit: false }), "Approved · suppliers only")}>
                              Suppliers only
                            </Btn>
                            <Btn variant="ghost" onClick={() => action(u.clerkUserId, () => approveUser(u.clerkUserId, { canViewSuppliers: false, canViewCompetitors: true, canEdit: false }), "Approved · competitors only")}>
                              Competitors only
                            </Btn>
                          </>
                        )}
                        {u.role === "member" && (
                          <Btn variant="ghost" onClick={() => action(u.clerkUserId, () => updateUserAccess({ clerkUserId: u.clerkUserId, role: "admin" }), "Promoted to admin")}>
                            Promote to admin
                          </Btn>
                        )}
                        {!isPrimary && !isSelf && (
                          <Btn variant="danger" disabled={busy === u.clerkUserId} onClick={() => {
                            if (!confirm(`Revoke all access for ${u.email}?`)) return;
                            action(u.clerkUserId, () => revokeUser(u.clerkUserId), "Revoked");
                          }}>
                            {u.role === "pending" ? "Reject" : "Revoke"}
                          </Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, active, highlight, onClick }: { label: string; value: number; active?: boolean; highlight?: "amber"; onClick: () => void }) {
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
      <div className={"text-xs uppercase tracking-wide " + (active ? "opacity-80" : "text-zinc-500")}>{label}</div>
      <div className={"text-2xl font-semibold mt-1 " + (highlight === "amber" && !active ? "text-amber-600" : "")}>
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
  return <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${cls}`}>{role}</span>;
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={
        "inline-flex h-5 w-9 rounded-full transition-colors " +
        (disabled ? "opacity-40 cursor-not-allowed " : "cursor-pointer ") +
        (checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700")
      }
    >
      <span className={"inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transform transition-transform " + (checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function Btn({ children, variant = "primary", disabled, onClick }: { children: React.ReactNode; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; onClick: () => void }) {
  const cls =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      : variant === "danger"
      ? "border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
      : "border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900";
  return (
    <button onClick={onClick} disabled={disabled} className={`px-3 py-1.5 rounded-md text-xs font-medium ${cls} disabled:opacity-50 disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
}
