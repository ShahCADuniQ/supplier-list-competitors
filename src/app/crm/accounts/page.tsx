import Link from "next/link";
import { redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listMyAccounts } from "../actions";
import NewAccountButton from "../NewAccountButton";
import AccountsTable from "./AccountsTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Accounts — ${CLIENT_CONFIG.name}`,
};

export default async function AccountsListPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");
  const accounts = await listMyAccounts();

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "clamp(24px, 3vw, 32px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            Accounts
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
            }}
          >
            One row per company. Click in for the full Customer 360 view —
            contacts, opportunities, activity timeline, tickets.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link
            href="/crm"
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "transparent",
              color: "var(--lb-text-2)",
              border: "1px solid var(--lb-border)",
              fontSize: 12.5,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ← Overview
          </Link>
          <NewAccountButton />
        </div>
      </header>
      <AccountsTable accounts={accounts} />
    </div>
  );
}
