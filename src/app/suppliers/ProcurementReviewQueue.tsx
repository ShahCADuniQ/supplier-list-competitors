"use client";

// Imen's review queue for RFQ emails routed through procurement.
// Each card lets her edit the subject + body, then Approve (which sends
// the email) or Reject with comment.

import { useEffect, useState } from "react";
import {
  listPendingProcurementDrafts,
  approveAndSendRfqEmailDraft,
  rejectRfqEmailDraft,
  type PendingProcurementDraft,
} from "./rfq-email-actions";

type Props =
  | { open: boolean; embedded?: false; onClose: () => void }
  | { embedded: true; onClose: () => void; open?: never };

export default function ProcurementReviewQueue(props: Props) {
  const { onClose } = props;
  const embedded = props.embedded === true;
  const open = embedded ? true : (props as { open: boolean }).open;

  const [drafts, setDrafts] = useState<PendingProcurementDraft[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function reload() {
    listPendingProcurementDrafts()
      .then(setDrafts)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }

  useEffect(() => {
    if (!open) return;
    reload();
  }, [open]);

  if (!open) return null;

  const inner = (
    <>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>
              {embedded ? "Procurement review" : "Procurement review queue"}
            </h2>
            <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>
              RFQ email drafts awaiting approval before they go to suppliers.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={
              embedded
                ? {
                    padding: "6px 12px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    border: "1px solid var(--lb-border)",
                    background: "var(--lb-bg)",
                    color: "var(--lb-text-2)",
                    cursor: "pointer",
                  }
                : {
                    background: "transparent",
                    border: "none",
                    color: "var(--lb-text-3)",
                    fontSize: 20,
                    cursor: "pointer",
                  }
            }
          >
            {embedded ? "← Back" : "×"}
          </button>
        </header>

        {err && (
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              background: "rgba(220,38,38,0.10)",
              border: "1px solid rgba(220,38,38,0.40)",
              color: "#dc2626",
              fontSize: 12.5,
              marginBottom: 10,
            }}
          >
            {err}
          </div>
        )}

        {drafts === null ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--lb-text-3)", fontSize: 13 }}>
            Loading…
          </div>
        ) : drafts.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              fontSize: 13,
              color: "var(--lb-text-3)",
              border: "1px dashed var(--lb-border)",
              borderRadius: 10,
            }}
          >
            Nothing in the queue. When a buyer routes an RFQ email through
            you for review, it&apos;ll show up here.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {drafts.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                onChanged={() => reload()}
                onError={(m) => setErr(m)}
              />
            ))}
          </ul>
        )}
    </>
  );

  if (embedded) {
    return (
      <section
        style={{
          padding: 20,
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {inner}
      </section>
    );
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
        zIndex: 70,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          width: "min(880px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          color: "var(--lb-text)",
        }}
      >
        {inner}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  onChanged,
  onError,
}: {
  draft: PendingProcurementDraft;
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.bodyText);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  // Imen picks how the supplier gets it on approve. Default to email so
  // the queue's behaviour matches what the buyer would have done with a
  // direct-to-supplier send.
  const [deliverEmail, setDeliverEmail] = useState(true);
  const [deliverPlatform, setDeliverPlatform] = useState(
    draft.supplierId != null,
  );

  async function approve() {
    if (!deliverEmail && !deliverPlatform) {
      onError("Pick at least one channel to send the supplier.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await approveAndSendRfqEmailDraft({
        draftId: draft.id,
        finalSubject: subject,
        finalBody: body,
        reviewerNotes: notes || undefined,
        deliverToSupplierEmail: deliverEmail,
        deliverToSupplierPlatform: deliverPlatform,
      });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!notes.trim()) {
      onError("Add a reviewer comment before rejecting.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await rejectRfqEmailDraft({
        draftId: draft.id,
        reviewerNotes: notes,
      });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 800 }}>
          {draft.rfqNumber}
        </span>
        <span style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
          {draft.rfqProjectName ?? draft.rfqProjectNum}
        </span>
        <span style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
          · to <strong>{draft.toEmail}</strong>
        </span>
        {draft.composedByName && (
          <span style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
            · drafted by {draft.composedByName}
          </span>
        )}
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
          Subject
        </span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={input}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
          Body
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ ...input, minHeight: 160, fontFamily: "inherit", resize: "vertical" }}
        />
      </label>
      {draft.aiSummary && (
        <details>
          <summary style={{ fontSize: 11.5, color: "var(--lb-text-3)", cursor: "pointer" }}>
            AI summary that will be appended
          </summary>
          <div style={{ fontSize: 12, color: "var(--lb-text-3)", whiteSpace: "pre-wrap", marginTop: 4, padding: 8, borderRadius: 6, background: "var(--lb-bg-elev)" }}>
            {draft.aiSummary}
          </div>
        </details>
      )}

      {rejecting && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
            Reviewer notes (required for reject)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ ...input, minHeight: 60, resize: "vertical" }}
            placeholder="Tell the buyer what to fix before resubmitting…"
          />
        </label>
      )}

      {!rejecting && (
        <div
          style={{
            padding: 8,
            borderRadius: 8,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              marginBottom: 4,
            }}
          >
            Deliver to the supplier
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={deliverPlatform}
              disabled={draft.supplierId == null}
              onChange={(e) => setDeliverPlatform(e.target.checked)}
            />
            Through the platform
            {draft.supplierId == null && (
              <span style={{ color: "var(--lb-text-3)", fontSize: 11.5 }}>
                (supplier not registered yet)
              </span>
            )}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={deliverEmail}
              onChange={(e) => setDeliverEmail(e.target.checked)}
            />
            By email to {draft.toEmail}
          </label>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        {!rejecting ? (
          <>
            <button type="button" onClick={() => setRejecting(true)} style={miniBtn} disabled={busy}>
              Reject
            </button>
            <button type="button" onClick={approve} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Sending…" : "Approve & send"}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => { setRejecting(false); setNotes(""); }} style={miniBtn} disabled={busy}>
              Cancel reject
            </button>
            <button type="button" onClick={reject} disabled={busy} style={{ ...rejectBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Rejecting…" : "Confirm reject"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg-elev)",
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
const rejectBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  border: "1px solid #dc2626",
  background: "#dc2626",
  color: "white",
  cursor: "pointer",
};
