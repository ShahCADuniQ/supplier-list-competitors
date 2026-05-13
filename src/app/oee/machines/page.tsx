import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewOee } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listMyMachines } from "../actions";
import MachinesGrid from "./MachinesGrid";
import NewMachineButton from "./NewMachineButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Machines — OEE — ${CLIENT_CONFIG.name}`,
};

export default async function MachinesPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewOee(profile)) redirect("/");

  const machines = await listMyMachines();

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
            Machines
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--lb-text-2)",
              margin: "6px 0 0",
            }}
          >
            Every asset that contributes to OEE. Click in for live status,
            run logging, downtime ledger, and quality events.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link
            href="/oee"
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
          <NewMachineButton />
        </div>
      </header>
      <MachinesGrid machines={machines} />
    </div>
  );
}
