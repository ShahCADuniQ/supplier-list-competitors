"use client";

import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

const COLLAPSE_STORAGE_KEY = "lb-sidebar-collapsed";

type Props = {
  email: string | null;
  role: string | null;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
  children: React.ReactNode;
};

export default function AppShell({
  email,
  role,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // One-shot read of persisted UI preference after mount. Reading during
    // render or via useState initializer would touch localStorage on the
    // server, and useSyncExternalStore is overkill for a single read.
    const v = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (v === "1") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <Sidebar
        collapsed={collapsed}
        email={email}
        role={role}
        canViewSuppliers={canViewSuppliers}
        canViewCompetitors={canViewCompetitors}
        canViewHandbook={canViewHandbook}
        canViewEngineering={canViewEngineering}
        isAdmin={isAdmin}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
