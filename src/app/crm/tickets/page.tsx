import Link from "next/link";
import { redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listAllTickets } from "../actions";
import TicketsTable from "./TicketsTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Tickets — CRM — ${CLIENT_CONFIG.name}`,
};

export default async function CrmTicketsPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");
  const tickets = await listAllTickets();

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
            Support Tickets
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
            }}
          >
            Every open and resolved ticket across all accounts. Change status
            inline; click an account to open the full Customer 360.
          </p>
        </div>
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
      </header>
      <TicketsTable tickets={tickets} />
    </div>
  );
}
