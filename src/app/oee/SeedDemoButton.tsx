"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { seedOeeDemoData } from "./actions";

// Seeds 4 demo machines + 24h of runs / downtime / quality so the dashboard
// renders something meaningful out of the box. Idempotent: no-op if the user
// already owns any machines.

export default function SeedDemoButton() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function go() {
    setBusy(true);
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await seedOeeDemoData();
        setMsg(
          res.seeded
            ? `Seeded ${res.machineIds.length} demo machines.`
            : "You already have machines — seed skipped.",
        );
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Seed failed");
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        style={{
          padding: "8px 14px",
          borderRadius: 999,
          background: "var(--lb-accent)",
          color: "var(--lb-accent-fg)",
          border: "1px solid var(--lb-accent)",
          fontSize: 12.5,
          fontWeight: 700,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Seeding…" : "Seed demo data"}
      </button>
      {msg && (
        <span style={{ fontSize: 12, color: "var(--lb-text-2)" }}>{msg}</span>
      )}
    </div>
  );
}
