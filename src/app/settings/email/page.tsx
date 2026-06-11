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
import { getEmailSetupStatus, isProviderReady } from "./setup-status";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL = {
  microsoft: "Outlook / Microsoft 365",
  google: "Gmail / Google Workspace",
} as const;

function ConnectButton({
  href,
  label,
  ready,
}: {
  href: string;
  label: string;
  ready: boolean;
}) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "10px 14px",
    borderRadius: 8,
    textDecoration: "none",
    fontSize: 13,
  } as const;
  if (!ready) {
    return (
      <span
        aria-disabled
        style={{
          ...base,
          border: "1px dashed var(--lb-border-1)",
          color: "var(--lb-text-3)",
          background: "transparent",
          cursor: "not-allowed",
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 11 }}>OAuth credentials not set</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      style={{
        ...base,
        border: "1px solid var(--lb-border-1)",
        color: "var(--lb-text-1)",
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>→</span>
    </a>
  );
}

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const connections = await listMyEmailConnections();
  const params = await searchParams;
  const setup = await getEmailSetupStatus();
  const microsoftReady = isProviderReady(setup, "microsoft");
  const googleReady = isProviderReady(setup, "google");
  const setupIncomplete = !microsoftReady && !googleReady;
  const missing: string[] = [];
  if (!setup.encryptionKey) missing.push("EMAIL_TOKEN_ENCRYPTION_KEY");
  if (!setup.microsoft.clientId) missing.push("MICROSOFT_OAUTH_CLIENT_ID");
  if (!setup.microsoft.clientSecret) missing.push("MICROSOFT_OAUTH_CLIENT_SECRET");
  if (!setup.google.clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!setup.google.clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");

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

      {setupIncomplete && (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 8,
            background: "rgba(234,88,12,0.10)",
            border: "1px solid rgba(234,88,12,0.40)",
            color: "#ea580c",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong>Setup incomplete.</strong> The OAuth app credentials
          aren&apos;t configured yet, so the Connect buttons won&apos;t
          work. The following <code>.env</code> variables are still blank:
          <ul style={{ margin: "8px 0 8px 18px", padding: 0 }}>
            {missing.map((m) => (
              <li key={m}>
                <code>{m}</code>
              </li>
            ))}
          </ul>
          See <code>docs/rfq-email.md</code> for the Azure / Google Cloud
          setup steps. After updating <code>.env</code>, restart{" "}
          <code>next dev</code>.
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
          <ConnectButton
            href="/api/email/oauth/microsoft/start"
            label="Connect Outlook / Microsoft 365"
            ready={microsoftReady}
          />
          <ConnectButton
            href="/api/email/oauth/google/start"
            label="Connect Gmail / Google Workspace"
            ready={googleReady}
          />
        </div>
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--lb-text-3)" }}>
          We request read + send permission on your mailbox. Access and
          refresh tokens are encrypted at rest.
        </p>
      </section>
    </main>
  );
}
