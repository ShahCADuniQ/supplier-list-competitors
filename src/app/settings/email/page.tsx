// Settings → Email. Per-user mailbox connection screen.
//
// • Microsoft (Outlook / 365) and Google (Gmail) buttons each kick off
//   the OAuth flow at /api/email/oauth/<provider>/start. After consent
//   the callback stores an encrypted access + refresh token and bounces
//   the user back here with ?connected=<provider>.
// • Connected accounts can be disconnected (revokes locally; the user
//   should also remove app access from their Microsoft/Google account
//   if they want to fully revoke the refresh token).
//
// The connected mailbox is what all outbound RFQ mail flows through, so
// suppliers see the buyer's real address — and we read the inbox for
// the home-page summariser.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrCreateProfile } from "@/lib/permissions";
import { listMyEmailConnections } from "./actions";
import { DisconnectButton } from "./DisconnectButton";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL = {
  microsoft: "Outlook / Microsoft 365",
  google: "Gmail / Google Workspace",
} as const;

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const connections = await listMyEmailConnections();
  const params = await searchParams;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 20px" }}>
      <nav style={{ marginBottom: 16, fontSize: 13 }}>
        <Link href="/" style={{ color: "var(--lb-text-3)" }}>
          ← Home
        </Link>
      </nav>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
        Email connection
      </h1>
      <p style={{ marginTop: 6, color: "var(--lb-text-3)", fontSize: 13 }}>
        Connect your work mailbox so RFQs go out from your own address and
        we can summarise supplier replies on your home page.
      </p>

      {params.connected && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "rgba(16,185,129,0.10)",
            border: "1px solid rgba(16,185,129,0.40)",
            color: "#10b981",
            fontSize: 13,
          }}
        >
          Connected{" "}
          {PROVIDER_LABEL[params.connected as keyof typeof PROVIDER_LABEL] ??
            params.connected}
          .
        </div>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>
          Connected accounts
        </h2>
        {connections.length === 0 ? (
          <p style={{ color: "var(--lb-text-3)", fontSize: 13 }}>
            No mailbox connected yet.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {connections.map((c) => (
              <li
                key={c.provider}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 14px",
                  border: "1px solid var(--lb-border-1)",
                  borderRadius: 8,
                  marginBottom: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {PROVIDER_LABEL[c.provider]}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
                    {c.emailAddress}
                  </div>
                </div>
                <DisconnectButton provider={c.provider} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>
          Connect a mailbox
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <a
            href="/api/email/oauth/microsoft/start"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "10px 14px",
              border: "1px solid var(--lb-border-1)",
              borderRadius: 8,
              textDecoration: "none",
              color: "var(--lb-text-1)",
              fontSize: 13,
            }}
          >
            Connect Outlook / Microsoft 365
          </a>
          <a
            href="/api/email/oauth/google/start"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "10px 14px",
              border: "1px solid var(--lb-border-1)",
              borderRadius: 8,
              textDecoration: "none",
              color: "var(--lb-text-1)",
              fontSize: 13,
            }}
          >
            Connect Gmail / Google Workspace
          </a>
        </div>
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--lb-text-3)" }}>
          We request read + send permission on your mailbox. Access and
          refresh tokens are encrypted at rest.
        </p>
      </section>
    </main>
  );
}
