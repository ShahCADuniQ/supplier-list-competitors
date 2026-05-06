"use client";

import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import SubNav from "./SubNav";

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
  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <Sidebar
        email={email}
        role={role}
        canViewSuppliers={canViewSuppliers}
        canViewCompetitors={canViewCompetitors}
        canViewHandbook={canViewHandbook}
        canViewEngineering={canViewEngineering}
        isAdmin={isAdmin}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <SubNav
          canViewCompetitors={canViewCompetitors}
          canViewHandbook={canViewHandbook}
          canViewEngineering={canViewEngineering}
        />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
