"use client";

// Compose + route an RFQ email. Two send modes:
//   • direct_to_supplier — fires immediately through the transport
//   • via_procurement    — saves as 'pending_procurement_review' for Imen
//
// The dialog auto-fills the subject + body from the RFQ on first open
// (suggestRfqEmailBody), shows the inferred reply-to (current user's
// email), and lets the user toggle the AI plain-language summary +
// magic-link block before sending.

import { useEffect, useState } from "react";
import {
  saveRfqEmailDraft,
  submitRfqEmailDraft,
  suggestRfqEmailBody,
  buildAiSummary,
  getEmailTransportStatus,
} from "./rfq-email-actions";

type Props = {
  open: boolean;
  rfqId: number;
  recipientId: number | null;
  supplierId: number | null;
  defaultToEmail: string;
  defaultToName?: string | null;
  // The magic-link URL for the recipient (when applicable). When empty
  // the "include magic link" checkbox is disabled.
  magicLinkUrl?: string | null;
  // Whether this recipient is already a registered supplier (we still
  // include the magic-link block by default for them; checkbox lets the
  // user opt out). Used only to set the default value of the AI-summary
  // checkbox: ON for unregistered, OFF for registered.
  isRegistered: boolean;
  onClose: () => void;
  onSent: (status: string) => void;
};

export default function RfqEmailDraftDialog({
  open,
  rfqId,
  recipientId,
  supplierId,
  defaultToEmail,
  defaultToName,
  magicLinkUrl,
  isRegistered,
  onClose,
  onSent,
}: Props) {
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [includeMagicLink, setIncludeMagicLink] = useState(true);
  const [includeAiSummary, setIncludeAiSummary] = useState(!isRegistered);
  const [route, setRoute] = useState<"direct_to_supplier" | "via_procurement">(
    "direct_to_supplier",
  );
  const [transport, setTransport] = useState<{
    configured: boolean;
    fromAddress: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr(null);
    Promise.all([
      suggestRfqEmailBody({
        rfqId,
        toName: defaultToName,
        includeMagicLink: !!magicLinkUrl,
        magicLinkUrl,
      }),
      getEmailTransportStatus(),
    ])
      .then(([draft, status]) => {
        setSubject(draft.subject);
        setBodyText(draft.body);
        setTransport(status);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [open, rfqId, defaultToName, magicLinkUrl]);

  useEffect(() => {
    if (!open || !includeAiSummary || aiSummary || generatingSummary) return;
    setGeneratingSummary(true);
    buildAiSummary({ rfqId })
      .then((s) => setAiSummary(s))
      .catch(() => undefined)
      .finally(() => setGeneratingSummary(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, includeAiSummary, rfqId]);

  if (!open) return null;

  async function handleSend() {
    setBusy(true);
    setErr(null);
    try {
      const save = await saveRfqEmailDraft({
        rfqId,
        recipientId,
        supplierId,
        toEmail: defaultToEmail,
        toName: defaultToName,
        subject,
        bodyText,
        aiSummary: includeAiSummary ? aiSummary : null,
        includeMagicLink: includeMagicLink && !!magicLinkUrl,
        route,
      });
      const submit = await submitRfqEmailDraft({ draftId: save.id });
      onSent(submit.status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 80,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          width: "min(720px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          color: "var(--lb-text)",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2
            style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}
          >
            ✉ Send RFQ to {defaultToName || defaultToEmail}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--lb-text-3)", fontSize: 20, cursor: "pointer" }}
          >
            ×
          </button>
        </header>

        {transport && !transport.configured && (
          <div
            style={{
              padding: 10,
              marginBottom: 10,
              borderRadius: 8,
              background: "rgba(234,88,12,0.10)",
              border: "1px solid rgba(234,88,12,0.40)",
              color: "#ea580c",
              fontSize: 12,
            }}
          >
            ⚠ <strong>Dev mode:</strong> RESEND_API_KEY isn&apos;t set. The
            email will be logged to the server console instead of going out.
            Set the env var (Resend) + EMAIL_FROM_ADDRESS to deliver for real.
          </div>
        )}

        {err && (
          <div
            style={{
              padding: 10,
              marginBottom: 10,
              borderRadius: 8,
              background: "rgba(220,38,38,0.10)",
              border: "1px solid rgba(220,38,38,0.40)",
              color: "#dc2626",
              fontSize: 12.5,
            }}
          >
            {err}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--lb-text-3)", fontSize: 13 }}>
            Drafting…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="To">
              <input value={defaultToEmail} readOnly style={{ ...input, opacity: 0.7 }} />
            </Field>
            <Field label="From">
              <input value={transport?.fromAddress ?? "rfq@caduniq.com"} readOnly style={{ ...input, opacity: 0.7 }} />
            </Field>
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} style={input} />
            </Field>
            <Field label="Body">
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                style={{ ...input, minHeight: 180, fontFamily: "inherit", resize: "vertical" }}
              />
            </Field>

            <div
              style={{
                padding: 10,
                borderRadius: 8,
                background: "var(--lb-bg)",
                border: "1px dashed var(--lb-border)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={includeMagicLink && !!magicLinkUrl}
                  disabled={!magicLinkUrl}
                  onChange={(e) => setIncludeMagicLink(e.target.checked)}
                />
                Include vendor-portal link
                {!magicLinkUrl && (
                  <span style={{ color: "var(--lb-text-3)" }}>
                    (no recipient token — won&apos;t be included)
                  </span>
                )}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={includeAiSummary}
                  onChange={(e) => setIncludeAiSummary(e.target.checked)}
                />
                Append AI plain-language summary
                {generatingSummary && (
                  <span style={{ color: "var(--lb-text-3)" }}>generating…</span>
                )}
                {!generatingSummary && includeAiSummary && aiSummary == null && (
                  <span style={{ color: "var(--lb-text-3)" }}>
                    (Claude API key not configured)
                  </span>
                )}
              </label>
              {includeAiSummary && aiSummary && (
                <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", paddingLeft: 24, whiteSpace: "pre-wrap" }}>
                  {aiSummary}
                </div>
              )}
            </div>

            <Field label="Routing">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5 }}>
                  <input
                    type="radio"
                    name="route"
                    checked={route === "direct_to_supplier"}
                    onChange={() => setRoute("direct_to_supplier")}
                  />
                  <div>
                    <div style={{ fontWeight: 700 }}>Send direct to the supplier</div>
                    <div style={{ color: "var(--lb-text-3)" }}>
                      Email goes out now to {defaultToEmail}. Their reply lands in your inbox.
                    </div>
                  </div>
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5 }}>
                  <input
                    type="radio"
                    name="route"
                    checked={route === "via_procurement"}
                    onChange={() => setRoute("via_procurement")}
                  />
                  <div>
                    <div style={{ fontWeight: 700 }}>Route through Procurement (Imen)</div>
                    <div style={{ color: "var(--lb-text-3)" }}>
                      Imen reviews and approves before the email goes to the supplier. You&apos;ll get a notification on her decision.
                    </div>
                  </div>
                </label>
              </div>
            </Field>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button type="button" onClick={onClose} style={miniBtn} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={busy || !subject.trim() || !bodyText.trim()}
                style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
              >
                {busy
                  ? "Sending…"
                  : route === "via_procurement"
                    ? "Send for review"
                    : "Send now"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
};

const miniBtn: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12.5,
  fontWeight: 600,
  borderRadius: 999,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text-2)",
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  border: "1px solid var(--lb-accent)",
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  cursor: "pointer",
};
