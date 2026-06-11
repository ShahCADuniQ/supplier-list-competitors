// Manage Account hub.
//
// One page lands the user on everything they can self-serve:
//   • Profile summary (name, email, role/tenant)
//   • Email integration — connect Outlook / Gmail, see connected
//     mailboxes, disconnect
//   • (Future) notifications, security, API keys
//
// Reachable from the bottom-left Sidebar gear; every signed-in user
// can open it, no tenant or module gate. The OAuth env-var setup is
// surfaced in-page so non-technical users see exactly what's blocking
// them when the Connect buttons are disabled.

import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getOrCreateProfile, isAdmin } from "@/lib/permissions";
import { listMyEmailConnections } from "./email/actions";
import { DisconnectButton } from "./email/DisconnectButton";
import {
  getEmailSetupStatus,
  isProviderReady,
} from "./email/setup-status";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL = {
  microsoft: "Outlook / Microsoft 365",
  google: "Gmail / Google Workspace",
} as const;

export default async function ManageAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  const params = await searchParams;
  const connections = await listMyEmailConnections();
  const setup = await getEmailSetupStatus();
  const userIsAdmin = isAdmin(profile);
  const ready = isProviderReady(setup);
  // With Nylas, both providers go through the same client/key, so they
  // light up or stay dark together.
  const microsoftReady = ready;
  const googleReady = ready;
  const setupIncomplete = !ready;
  const missing: string[] = [];
  if (!setup.encryptionKey) missing.push("EMAIL_TOKEN_ENCRYPTION_KEY");
  if (!setup.nylas.clientId) missing.push("NYLAS_CLIENT_ID");
  if (!setup.nylas.apiKey) missing.push("NYLAS_API_KEY");

  let tenantName: string | null = null;
  if (profile.clientId != null) {
    const [row] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, profile.clientId))
      .limit(1);
    tenantName = row?.name ?? null;
  }

  const initial = (profile.displayName ?? profile.email ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "32px 24px 64px",
        color: "var(--lb-text)",
      }}
    >
      <nav style={{ marginBottom: 16, fontSize: 13 }}>
        <Link href="/" style={{ color: "var(--lb-text-3)" }}>
          ← Home
        </Link>
      </nav>

      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>
        Manage Account
      </h1>
      <p style={{ marginTop: 6, color: "var(--lb-text-3)", fontSize: 14 }}>
        Your profile, mailbox connections, and personal preferences.
      </p>

      {/* ──── Profile card ──── */}
      <section
        style={{
          marginTop: 24,
          padding: 20,
          border: "1px solid var(--lb-border)",
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: 9999,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>
            {profile.displayName ?? profile.email ?? "(unnamed)"}
          </div>
          <div style={{ fontSize: 13, color: "var(--lb-text-3)", marginTop: 2 }}>
            {profile.email}
          </div>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {tenantName && <Chip>{tenantName}</Chip>}
            {profile.role && profile.role !== "member" && (
              <Chip>{profile.role}</Chip>
            )}
            {profile.jobRole && <Chip tone="muted">{profile.jobRole}</Chip>}
          </div>
        </div>
      </section>

      {/* ──── Email integration ──── */}
      <section
        id="email"
        style={{
          marginTop: 24,
          padding: 20,
          border: "1px solid var(--lb-border)",
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
        }}
      >
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span aria-hidden>✉</span> Email integration
        </h2>
        <p
          style={{
            marginTop: 4,
            marginBottom: 0,
            fontSize: 13,
            color: "var(--lb-text-3)",
          }}
        >
          Connect your work mailbox so RFQs go out from your real address
          and supplier replies can be summarised on your home page.
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
            {userIsAdmin ? (
              <>
                <strong>One-time Nylas setup needed.</strong> Email is
                routed through Nylas, which handles the Outlook + Gmail
                OAuth dance for us. To finish setup, grab your client id
                and an API key from the Nylas dashboard and add them
                to <code>.env</code> on the server.
                <div style={{ marginTop: 10, fontWeight: 600 }}>Steps:</div>
                <ol style={{ margin: "4px 0 8px 20px", padding: 0 }}>
                  <li>
                    Create a free Nylas account at{" "}
                    <a
                      href="https://dashboard-v3.nylas.com/"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#ea580c", textDecoration: "underline" }}
                    >
                      dashboard-v3.nylas.com
                    </a>
                    .
                  </li>
                  <li>
                    Whitelist this app&apos;s callback as a redirect URI:{" "}
                    <code>
                      {(process.env.APP_BASE_URL ||
                        process.env.NEXT_PUBLIC_APP_URL ||
                        "http://localhost:3000"
                      ).replace(/\/$/, "")}
                      /api/email/oauth/callback
                    </code>
                  </li>
                  <li>
                    Fill these values in <code>.env</code>:
                    <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                      {missing.map((m) => (
                        <li key={m}>
                          <code>{m}</code>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    Restart <code>next dev</code> (or redeploy in production).
                  </li>
                </ol>
                <div style={{ marginTop: 8 }}>
                  Once configured, every user — including you — can click
                  Connect below to link their own Outlook or Gmail
                  account through Nylas&apos;s hosted consent flow.
                </div>
              </>
            ) : (
              <>
                <strong>Mailbox connection isn&apos;t available yet.</strong>{" "}
                Your administrator needs to finish a one-time OAuth setup
                before anyone can connect their Outlook or Gmail account.
                Check back once they&apos;ve completed it.
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <h3
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--lb-text-3)",
              margin: "0 0 8px 0",
            }}
          >
            Connected mailboxes
          </h3>
          {connections.length === 0 ? (
            <p style={{ color: "var(--lb-text-3)", fontSize: 13, margin: 0 }}>
              No mailbox connected yet — pick a provider below.
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
                    border: "1px solid var(--lb-border)",
                    borderRadius: 10,
                    marginBottom: 8,
                    background: "var(--lb-bg)",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>
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
        </div>

        <div style={{ marginTop: 20 }}>
          <h3
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--lb-text-3)",
              margin: "0 0 8px 0",
            }}
          >
            Connect a mailbox
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <ProviderTile
              href="/api/email/oauth/microsoft/start"
              brand="Outlook / Microsoft 365"
              hint="Microsoft Graph · Mail.Read + Mail.Send"
              ready={microsoftReady}
              color="#0078D4"
            />
            <ProviderTile
              href="/api/email/oauth/google/start"
              brand="Gmail / Google Workspace"
              hint="Gmail API · readonly + send"
              ready={googleReady}
              color="#EA4335"
            />
          </div>
          <p style={{ marginTop: 12, fontSize: 12, color: "var(--lb-text-3)" }}>
            We request read + send permission on your mailbox. Access and
            refresh tokens are encrypted at rest with AES-256-GCM. You can
            disconnect at any time.
          </p>
        </div>
      </section>
    </main>
  );
}

function Chip({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "muted";
}) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 8px",
        borderRadius: 6,
        background:
          tone === "muted" ? "var(--lb-bg)" : "rgba(37,99,235,0.10)",
        color: tone === "muted" ? "var(--lb-text-3)" : "#2563eb",
        border:
          tone === "muted"
            ? "1px solid var(--lb-border)"
            : "1px solid rgba(37,99,235,0.30)",
      }}
    >
      {children}
    </span>
  );
}

function ProviderTile({
  href,
  brand,
  hint,
  ready,
  color,
}: {
  href: string;
  brand: string;
  hint: string;
  ready: boolean;
  color: string;
}) {
  const inner = (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: color,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{brand}</div>
          <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 2 }}>
            {ready ? hint : "OAuth credentials not set"}
          </div>
        </div>
      </div>
      <span
        style={{
          fontSize: 12,
          color: ready ? "var(--lb-text-2)" : "var(--lb-text-3)",
          fontWeight: 600,
        }}
      >
        {ready ? "Connect →" : "—"}
      </span>
    </>
  );
  const baseStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "14px 16px",
    borderRadius: 10,
    background: "var(--lb-bg)",
    textDecoration: "none",
    color: "var(--lb-text)",
  };
  if (!ready) {
    return (
      <span
        aria-disabled
        style={{
          ...baseStyle,
          border: "1px dashed var(--lb-border)",
          cursor: "not-allowed",
          opacity: 0.7,
        }}
      >
        {inner}
      </span>
    );
  }
  return (
    <a
      href={href}
      style={{
        ...baseStyle,
        border: "1px solid var(--lb-border)",
      }}
    >
      {inner}
    </a>
  );
}
