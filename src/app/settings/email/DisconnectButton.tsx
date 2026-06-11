"use client";

// Small client wrapper so we can call the disconnect server action with
// a confirm + transition state. Kept tiny to keep the bulk of the page
// rendering on the server.

import { useState, useTransition } from "react";
import { disconnectMyEmail } from "./actions";
import type { EmailProvider } from "@/lib/email/types";

export function DisconnectButton({ provider }: { provider: EmailProvider }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !confirm(
              "Disconnect this mailbox? Outbound RFQs will fall back to the dev log until you reconnect.",
            )
          ) {
            return;
          }
          setErr(null);
          start(async () => {
            try {
              await disconnectMyEmail(provider);
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Could not disconnect");
            }
          });
        }}
        style={{
          padding: "6px 10px",
          fontSize: 12,
          background: "transparent",
          border: "1px solid var(--lb-border-1)",
          borderRadius: 6,
          color: "var(--lb-text-2)",
          cursor: pending ? "default" : "pointer",
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      {err && (
        <span style={{ color: "#ef4444", fontSize: 11, marginTop: 4 }}>{err}</span>
      )}
    </div>
  );
}
