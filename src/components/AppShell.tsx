"use client";

import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import SubNav from "./SubNav";

type Props = {
  email: string | null;
  role: string | null;
  isSupplier: boolean;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  canViewDesignEngineering: boolean;
  canViewCrm: boolean;
  canViewOee: boolean;
  isAdmin: boolean;
  children: React.ReactNode;
};

export default function AppShell({
  email,
  role,
  isSupplier,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  canViewDesignEngineering,
  canViewCrm,
  canViewOee,
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
        isSupplier={isSupplier}
        canViewSuppliers={canViewSuppliers}
        canViewCompetitors={canViewCompetitors}
        canViewHandbook={canViewHandbook}
        canViewEngineering={canViewEngineering}
        canViewDesignEngineering={canViewDesignEngineering}
        canViewCrm={canViewCrm}
        canViewOee={canViewOee}
        isAdmin={isAdmin}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <SubNav
          canViewSuppliers={canViewSuppliers}
          canViewCompetitors={canViewCompetitors}
          canViewHandbook={canViewHandbook}
          canViewEngineering={canViewEngineering}
          isAdmin={isAdmin}
        />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
