"use client";

// Home-page "Connect your work email" card.
//
// Drives the per-tenant approval workflow:
//   • status === 'none'      → tenant admin sees Request button
//   • status === 'requested' → both admins and members see "Awaiting CADuniQ"
//   • status === 'rejected'  → admin can re-request; members see the rejection note
//   • status === 'approved'  → users see Connect Outlook / Connect Gmail buttons.
//                               When the user already has a connection, the card
//                               renders a green "Connected as <address>" state
//                               so the home page also acts as a live status pill.

import { useState, useTransition } from "react";
import { requestEmailIntegration } from "@/app/settings/email/integration-actions";
import { detectEmailProvider } from "@/lib/email/detect-provider";

type Status = "none" | "requested" | "approved" | "rejected";

export default function EmailIntegrationCard(props: {
  status: Status;
  userIsTenantAdmin: boolean;
  userEmail: string | null;
  myConnection: {
    provider: "microsoft" | "google";
    emailAddress: string;
  } | null;
  decisionNotes: string | null;
  nylasConfigured: boolean;
}) {
  const {
    status,
    userIsTenantAdmin,
    userEmail,
    myConnection,
    decisionNotes,
    nylasConfigured,
  } = props;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<Status>(status);

  const detected = detectEmailProvider(userEmail);
  const emailQs = userEmail ? `?email=${encodeURIComponent(userEmail)}` : "";

  function doRequest() {
    setErr(null);
    start(async () => {
      try {
        const r = await requestEmailIntegration({});
        if (!r.ok) {
          setErr(r.error || "Could not submit request");
          return;
        }
        setLocalStatus(r.status as Status);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not submit request");
      }
    });
  }

  return (
    <section style={CARD}>
      <div style={HEADER}>
        <span aria-hidden style={ICON}>✉</span>
        <div>
          <h2 style={TITLE}>Connect your work email</h2>
          <p style={SUB}>
            Send RFQs from your real address and get supplier replies
            summarised on this page.
          </p>
        </div>
        <StatusPill status={localStatus} hasConnection={!!myConnection} />
      </div>

      <div style={{ marginTop: 16 }}>
        {/* APPROVED + already connected → green status, no buttons */}
        {localStatus === "approved" && myConnection ? (
          <div style={CONNECTED_BOX}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {myConnection.provider === "google"
                  ? "Gmail connected"
                  : "Outlook connected"}
              </div>
              <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>
                {myConnection.emailAddress}
              </div>
            </div>
            <a href="/settings#email" style={SECONDARY_LINK}>
              Manage →
            </a>
          </div>
        ) : null}

        {/* APPROVED, not yet connected → show Connect buttons */}
        {localStatus === "approved" && !myConnection ? (
          <>
            {!nylasConfigured && (
              <Banner tone="warn">
                Email connection isn&apos;t available yet — an
                administrator still needs to finish a one-time Nylas
                setup. Connect buttons will activate once that&apos;s
                done.
              </Banner>
            )}
            <div style={CONNECT_GRID}>
              <ConnectTile
                href={`/api/email/oauth/microsoft/start${emailQs}`}
                brand="Connect Outlook / Microsoft 365"
                hint={
                  detected === "microsoft"
                    ? `We detected ${userEmail} is a Microsoft account`
                    : "Microsoft 365, Outlook.com, Live.com"
                }
                color="#0078D4"
                primary={detected === "microsoft"}
                ready={nylasConfigured}
              />
              <ConnectTile
                href={`/api/email/oauth/google/start${emailQs}`}
                brand="Connect Gmail / Google Workspace"
                hint={
                  detected === "google"
                    ? `We detected ${userEmail} is a Google account`
                    : "Google Workspace, @gmail.com"
                }
                color="#EA4335"
                primary={detected === "google"}
                ready={nylasConfigured}
              />
            </div>
          </>
        ) : null}

        {/* NONE → Request button (admin only) */}
        {localStatus === "none" && (
          <>
            {userIsTenantAdmin ? (
              <>
                <p style={BODY_TEXT}>
                  Email integration is opt-in. Click below to ask CADuniQ
                  HQ to enable it for your company; once approved every
                  user can connect their own Outlook or Gmail account.
                </p>
                <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={doRequest}
                    disabled={pending}
                    style={PRIMARY_BTN}
                  >
                    {pending ? "Submitting…" : "Request email integration"}
                  </button>
                  <a href="/settings#email" style={SECONDARY_LINK}>
                    Learn more →
                  </a>
                </div>
                {err && <div style={ERR_BOX}>{err}</div>}
              </>
            ) : (
              <Banner tone="info">
                Ask your company administrator to request email
                integration from their home page.
              </Banner>
            )}
          </>
        )}

        {/* REQUESTED → waiting on CADuniQ */}
        {localStatus === "requested" && (
          <Banner tone="info">
            Your company&apos;s email integration is pending CADuniQ
            HQ approval. We&apos;ll email you once it&apos;s
            decided — typically within a business day.
          </Banner>
        )}

        {/* REJECTED → admin can re-request, members see the note */}
        {localStatus === "rejected" && (
          <>
            <Banner tone="warn">
              <strong>Email integration was not approved.</strong>
              {decisionNotes ? (
                <>
                  {" "}
                  CADuniQ HQ note: <em>{decisionNotes}</em>
                </>
              ) : null}
            </Banner>
            {userIsTenantAdmin && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={doRequest}
                  disabled={pending}
                  style={PRIMARY_BTN}
                >
                  {pending ? "Submitting…" : "Submit again"}
                </button>
                {err && <div style={ERR_BOX}>{err}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function StatusPill({
  status,
  hasConnection,
}: {
  status: Status;
  hasConnection: boolean;
}) {
  if (status === "approved" && hasConnection) {
    return (
      <span style={{ ...PILL, background: "rgba(16,185,129,0.10)", color: "#10b981", border: "1px solid rgba(16,185,129,0.35)" }}>
        ● Connected
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span style={{ ...PILL, background: "rgba(37,99,235,0.10)", color: "#2563eb", border: "1px solid rgba(37,99,235,0.30)" }}>
        Approved
      </span>
    );
  }
  if (status === "requested") {
    return (
      <span style={{ ...PILL, background: "rgba(234,179,8,0.10)", color: "#a16207", border: "1px solid rgba(234,179,8,0.30)" }}>
        Awaiting CADuniQ
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span style={{ ...PILL, background: "rgba(239,68,68,0.10)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.30)" }}>
        Rejected
      </span>
    );
  }
  return (
    <span style={{ ...PILL, background: "var(--lb-bg)", color: "var(--lb-text-3)", border: "1px solid var(--lb-border)" }}>
      Not requested
    </span>
  );
}

function ConnectTile({
  href,
  brand,
  hint,
  color,
  primary,
  ready,
}: {
  href: string;
  brand: string;
  hint: string;
  color: string;
  primary: boolean;
  ready: boolean;
}) {
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    borderRadius: 10,
    background: "var(--lb-bg)",
    textDecoration: "none",
    color: "var(--lb-text)",
    border: primary
      ? "1px solid var(--lb-accent)"
      : "1px solid var(--lb-border)",
  };
  const inner = (
    <>
      <span
        aria-hidden
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: color,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{brand}</div>
        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
          {ready ? hint : "Not configured yet"}
        </div>
      </div>
      <span style={{ fontSize: 13, color: "var(--lb-text-2)" }}>
        {ready ? "→" : "—"}
      </span>
    </>
  );
  if (!ready) {
    return <span aria-disabled style={{ ...base, opacity: 0.6, cursor: "not-allowed" }}>{inner}</span>;
  }
  return (
    <a href={href} style={base}>
      {inner}
    </a>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  const palette =
    tone === "warn"
      ? {
          bg: "rgba(234,88,12,0.10)",
          border: "rgba(234,88,12,0.35)",
          color: "#c2410c",
        }
      : {
          bg: "rgba(37,99,235,0.08)",
          border: "rgba(37,99,235,0.30)",
          color: "#1d4ed8",
        };
  return (
    <div
      style={{
        marginTop: 8,
        padding: 12,
        borderRadius: 8,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  padding: 20,
  borderRadius: 14,
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
};
const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
};
const ICON: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 12,
  background: "rgba(37,99,235,0.12)",
  color: "#2563eb",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 20,
  flexShrink: 0,
};
const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};
const SUB: React.CSSProperties = {
  margin: "2px 0 0 0",
  fontSize: 12.5,
  color: "var(--lb-text-3)",
  lineHeight: 1.5,
};
const PILL: React.CSSProperties = {
  marginLeft: "auto",
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const CONNECT_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
  marginTop: 10,
};
const CONNECTED_BOX: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "12px 14px",
  borderRadius: 10,
  background: "rgba(16,185,129,0.06)",
  border: "1px solid rgba(16,185,129,0.30)",
};
const PRIMARY_BTN: React.CSSProperties = {
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  color: "#fff",
  border: "none",
  background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
  cursor: "pointer",
  boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
};
const SECONDARY_LINK: React.CSSProperties = {
  alignSelf: "center",
  fontSize: 13,
  color: "var(--lb-text-2)",
  textDecoration: "none",
};
const BODY_TEXT: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  fontSize: 13,
  color: "var(--lb-text-2)",
  lineHeight: 1.55,
};
const ERR_BOX: React.CSSProperties = {
  marginTop: 8,
  padding: 10,
  borderRadius: 8,
  background: "rgba(239,68,68,0.08)",
  color: "#dc2626",
  border: "1px solid rgba(239,68,68,0.30)",
  fontSize: 12.5,
};
