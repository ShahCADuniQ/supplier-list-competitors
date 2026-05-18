"use client";

// Shared payment + production-tracking panel embedded inside PoView. Both
// the buyer (Lightbase) and the supplier see the SAME data here — they
// just have different mutation entry points:
//
//   • Supplier posts: payment method, invoices, timeline updates
//   • Buyer posts:    invoice status flips, proof-of-payment, timeline updates
//
// Server actions enforce the real authz; this component only adapts the UI
// based on `viewerRole`. That way buyer staff editing on behalf of a
// supplier (debug case) can still see/use the supplier-side forms.

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addPoInvoice,
  addPoPayment,
  deletePoInvoice,
  deletePoPayment,
  deletePoTimelineEntry,
  postPoTimelineUpdate,
  setInvoiceStatus,
  setPoPaymentMethod,
} from "@/app/suppliers/po-tracking-actions";
import type {
  PoInvoice,
  PoPaymentMethod,
  PoPayment,
  PoTimelineEntry,
  PurchaseOrder,
} from "@/db/schema";
import { fmtMoney, PO_STATUS_META } from "@/app/suppliers/_orders-constants";

function safeFile(name: string): string {
  return (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "file";
}

const INVOICE_STATUS_META: Record<PoInvoice["status"], { label: string; color: string }> = {
  issued:    { label: "Issued by supplier",     color: "#6b7280" },
  received:  { label: "Received by AP",         color: "#0891b2" },
  approved:  { label: "Approved by AP",         color: "#16a34a" },
  scheduled: { label: "Scheduled for payment",  color: "#7c3aed" },
  paid:      { label: "Paid",                   color: "#059669" },
  disputed:  { label: "Disputed",               color: "#dc2626" },
  cancelled: { label: "Cancelled",              color: "#475569" },
};

// Buyer's AP transition graph — what's the next-allowed status from here?
const NEXT_STATUS_OPTIONS: Record<PoInvoice["status"], PoInvoice["status"][]> = {
  issued:    ["received", "approved", "scheduled", "paid", "disputed", "cancelled"],
  received:  ["approved", "scheduled", "paid", "disputed", "cancelled"],
  approved:  ["scheduled", "paid", "disputed"],
  scheduled: ["paid", "disputed"],
  paid:      [],
  disputed:  ["received", "approved", "cancelled"],
  cancelled: [],
};

const PHASE_OPTIONS: Array<{ value: PurchaseOrder["status"]; label: string; emoji: string }> = [
  { value: "acknowledged",   label: "Acknowledged",   emoji: "✅" },
  { value: "in-production",  label: "In Production",  emoji: "🏭" },
  { value: "shipped",        label: "Shipped",        emoji: "🚚" },
  { value: "received",       label: "Received",       emoji: "📦" },
  { value: "closed",         label: "Closed",         emoji: "🎉" },
  { value: "cancelled",      label: "Cancelled",      emoji: "✕" },
];

export default function PoTracker({
  po,
  viewerRole,
  paymentMethod,
  invoices,
  payments,
  timeline,
}: {
  po: PurchaseOrder;
  viewerRole: "buyer" | "supplier";
  paymentMethod: PoPaymentMethod | null;
  invoices: PoInvoice[];
  payments: PoPayment[];
  timeline: PoTimelineEntry[];
}) {
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reload() {
    window.location.reload();
  }

  function handle<T extends unknown[]>(fn: (...a: T) => Promise<unknown>, ...args: T) {
    setBusy(true);
    setErr(null);
    startTransition(async () => {
      try {
        await fn(...args);
        reload();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Action failed");
        setBusy(false);
      }
    });
  }

  return (
    <section
      style={{
        marginTop: 8,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "var(--lb-text)" }}>
            Payment & Delivery Tracker
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--lb-text-3)", maxWidth: 720 }}>
            Both parties see this view. The supplier posts banking instructions,
            invoices, and shipment updates; the buyer&rsquo;s AP team marks invoices
            received → approved → scheduled → paid and uploads proof of payment.
          </p>
        </div>
        <span
          style={{
            padding: "4px 12px",
            borderRadius: 999,
            background: viewerRole === "supplier" ? "rgba(8,145,178,0.15)" : "rgba(124,58,237,0.15)",
            border: `1px solid ${viewerRole === "supplier" ? "rgba(8,145,178,0.45)" : "rgba(124,58,237,0.45)"}`,
            color: "var(--lb-text)",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {viewerRole === "supplier" ? "Supplier view" : "Buyer view"}
        </span>
      </header>

      {err && (
        <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,0.12)", border: "1px solid #dc2626", color: "#fca5a5", fontSize: 12.5 }}>
          {err}
        </div>
      )}

      <PaymentMethodPanel
        po={po}
        viewerRole={viewerRole}
        method={paymentMethod}
        busy={busy}
        onSave={(input) => handle(setPoPaymentMethod, input)}
      />

      <InvoicesPanel
        po={po}
        viewerRole={viewerRole}
        invoices={invoices}
        payments={payments}
        busy={busy}
        onAdd={(input) => handle(addPoInvoice, input)}
        onDelete={(invoiceId) => handle(deletePoInvoice, { invoiceId })}
        onSetStatus={(input) => handle(setInvoiceStatus, input)}
      />

      <PaymentsPanel
        po={po}
        viewerRole={viewerRole}
        payments={payments}
        invoices={invoices}
        busy={busy}
        onAdd={(input) => handle(addPoPayment, input)}
        onDelete={(paymentId) => handle(deletePoPayment, { paymentId })}
      />

      <TimelinePanel
        po={po}
        viewerRole={viewerRole}
        timeline={timeline}
        busy={busy}
        onAdd={(input) => handle(postPoTimelineUpdate, input)}
        onDelete={(entryId) => handle(deletePoTimelineEntry, { entryId })}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT METHOD
// ─────────────────────────────────────────────────────────────────────────────

function PaymentMethodPanel({
  po,
  viewerRole,
  method,
  busy,
  onSave,
}: {
  po: PurchaseOrder;
  viewerRole: "buyer" | "supplier";
  method: PoPaymentMethod | null;
  busy: boolean;
  onSave: (input: Parameters<typeof setPoPaymentMethod>[0]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [bankName, setBankName] = useState(method?.bankName ?? "");
  const [accountHolder, setAccountHolder] = useState(method?.accountHolder ?? "");
  const [iban, setIban] = useState(method?.iban ?? "");
  const [swift, setSwift] = useState(method?.swiftBic ?? "");
  const [accountNumber, setAccountNumber] = useState(method?.accountNumber ?? "");
  const [routingNumber, setRoutingNumber] = useState(method?.routingNumber ?? "");
  const [paymentTerms, setPaymentTerms] = useState(method?.paymentTerms ?? "");
  const [acceptedCurrencies, setAcceptedCurrencies] = useState(method?.acceptedCurrencies ?? "");
  const [additionalNotes, setAdditionalNotes] = useState(method?.additionalNotes ?? "");
  const [additional, setAdditional] = useState<Array<{ kind: string; value: string }>>(
    method?.additionalMethods ?? [],
  );
  const [attachmentUrl, setAttachmentUrl] = useState<string | undefined>(method?.attachmentUrl ?? undefined);
  const [attachmentName, setAttachmentName] = useState<string | undefined>(method?.attachmentName ?? undefined);
  const [attachmentPathname, setAttachmentPathname] = useState<string | undefined>(method?.attachmentPathname ?? undefined);
  const [uploading, setUploading] = useState(false);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const pathname = `purchase-orders/${po.id}/payment-method/${crypto.randomUUID()}-${safeFile(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      setAttachmentUrl(blob.url);
      setAttachmentName(file.name);
      setAttachmentPathname(blob.pathname);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    onSave({
      poId: po.id,
      bankName,
      accountHolder,
      iban,
      swiftBic: swift,
      accountNumber,
      routingNumber,
      additionalMethods: additional.filter((m) => m.kind.trim() && m.value.trim()),
      acceptedCurrencies,
      paymentTerms,
      additionalNotes,
      attachmentUrl,
      attachmentName,
      attachmentPathname,
    });
  }

  const supplierCanEdit = viewerRole === "supplier" || viewerRole === "buyer";

  return (
    <Panel
      title="Payment Method"
      subtitle="Where to send the money. Posted by the supplier; the buyer's AP team uses this to pay invoices."
      headerRight={
        method && !editing && supplierCanEdit ? (
          <button type="button" onClick={() => setEditing(true)} style={btnGhost}>↻ Edit</button>
        ) : null
      }
    >
      {!method && !editing ? (
        <Empty>
          {viewerRole === "supplier"
            ? "You haven't posted payment instructions yet. Click below to add bank details / accepted methods so the buyer's AP team knows how to pay you."
            : "The supplier hasn't posted payment instructions yet. They'll appear here as soon as they do."}
          {supplierCanEdit && (
            <div style={{ marginTop: 10 }}>
              <button type="button" onClick={() => setEditing(true)} style={btnPrimary}>
                + Add payment instructions
              </button>
            </div>
          )}
        </Empty>
      ) : !editing && method ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <Field label="Bank">{method.bankName ?? "—"}</Field>
          <Field label="Account holder">{method.accountHolder ?? "—"}</Field>
          <Field label="IBAN">{method.iban ?? "—"}</Field>
          <Field label="SWIFT / BIC">{method.swiftBic ?? "—"}</Field>
          <Field label="Account #">{method.accountNumber ?? "—"}</Field>
          <Field label="Routing / ABA / Transit">{method.routingNumber ?? "—"}</Field>
          <Field label="Payment terms">{method.paymentTerms ?? "—"}</Field>
          <Field label="Accepted currencies">{method.acceptedCurrencies ?? "—"}</Field>
          {method.additionalMethods.length > 0 && (
            <Field label="Other methods" wide>
              {method.additionalMethods.map((m, i) => (
                <span key={i} style={{ marginRight: 12 }}>
                  <b>{m.kind}:</b> {m.value}
                </span>
              ))}
            </Field>
          )}
          {method.additionalNotes && (
            <Field label="Notes" wide>
              <span style={{ whiteSpace: "pre-wrap" }}>{method.additionalNotes}</span>
            </Field>
          )}
          {method.attachmentUrl && (
            <Field label="Attachment" wide>
              <a href={method.attachmentUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                📎 {method.attachmentName ?? "Download"}
              </a>
            </Field>
          )}
          <Field label="Posted" wide>
            <span style={{ color: "var(--lb-text-3)", fontSize: 11 }}>
              {new Date(method.postedAt).toLocaleString()}
            </span>
          </Field>
        </div>
      ) : (
        <div style={formGrid}>
          <Input label="Bank name" value={bankName} onChange={setBankName} />
          <Input label="Account holder" value={accountHolder} onChange={setAccountHolder} />
          <Input label="IBAN" value={iban} onChange={setIban} />
          <Input label="SWIFT / BIC" value={swift} onChange={setSwift} />
          <Input label="Account number" value={accountNumber} onChange={setAccountNumber} />
          <Input label="Routing / ABA / Transit" value={routingNumber} onChange={setRoutingNumber} />
          <Input label="Payment terms (e.g. NET 30)" value={paymentTerms} onChange={setPaymentTerms} />
          <Input label="Accepted currencies (e.g. USD, CAD)" value={acceptedCurrencies} onChange={setAcceptedCurrencies} />
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Other accepted methods (PayPal / Wise / etc.)</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {additional.map((m, i) => (
                <div key={i} style={{ display: "flex", gap: 6 }}>
                  <input
                    placeholder="Type (e.g. PayPal)"
                    value={m.kind}
                    onChange={(e) => setAdditional((a) => a.map((x, j) => (i === j ? { ...x, kind: e.target.value } : x)))}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <input
                    placeholder="Value (e.g. ap@supplier.com)"
                    value={m.value}
                    onChange={(e) => setAdditional((a) => a.map((x, j) => (i === j ? { ...x, value: e.target.value } : x)))}
                    style={{ ...inputStyle, flex: 2 }}
                  />
                  <button type="button" onClick={() => setAdditional((a) => a.filter((_, j) => j !== i))} style={miniBtn("#dc2626")}>✕</button>
                </div>
              ))}
              <button type="button" onClick={() => setAdditional((a) => [...a, { kind: "", value: "" }])} style={btnGhost}>
                + Add method
              </button>
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Notes (optional)</label>
            <textarea value={additionalNotes} onChange={(e) => setAdditionalNotes(e.target.value)} style={{ ...inputStyle, minHeight: 60, fontFamily: "inherit" }} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Attachment (e.g. signed banking form)</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...btnGhost, cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
                {uploading ? "Uploading…" : attachmentUrl ? "↺ Replace file" : "📤 Upload file"}
                <input
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) uploadFile(f);
                  }}
                />
              </label>
              {attachmentUrl && (
                <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                  📎 {attachmentName ?? "Attached file"}
                </a>
              )}
              {attachmentUrl && (
                <button type="button" onClick={() => { setAttachmentUrl(undefined); setAttachmentName(undefined); setAttachmentPathname(undefined); }} style={miniBtn("#dc2626")}>✕</button>
              )}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {method && (
              <button type="button" onClick={() => setEditing(false)} style={btnGhost}>Cancel</button>
            )}
            <button type="button" onClick={submit} disabled={busy} style={btnPrimary}>
              {busy ? "Saving…" : method ? "Save changes" : "Post payment instructions"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES
// ─────────────────────────────────────────────────────────────────────────────

function InvoicesPanel({
  po,
  viewerRole,
  invoices,
  payments,
  busy,
  onAdd,
  onDelete,
  onSetStatus,
}: {
  po: PurchaseOrder;
  viewerRole: "buyer" | "supplier";
  invoices: PoInvoice[];
  payments: PoPayment[];
  busy: boolean;
  onAdd: (input: Parameters<typeof addPoInvoice>[0]) => void;
  onDelete: (invoiceId: number) => void;
  onSetStatus: (input: Parameters<typeof setInvoiceStatus>[0]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState("");
  const [amount, setAmount] = useState<string>(String(Number(po.totalAmount).toFixed(2)));
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [fileUrl, setFileUrl] = useState<string | undefined>();
  const [fileName, setFileName] = useState<string | undefined>();
  const [filePathname, setFilePathname] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const pathname = `purchase-orders/${po.id}/invoices/${crypto.randomUUID()}-${safeFile(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      setFileUrl(blob.url);
      setFileName(file.name);
      setFilePathname(blob.pathname);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    if (!number.trim()) { alert("Invoice number is required"); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { alert("Amount must be positive"); return; }
    onAdd({
      poId: po.id,
      invoiceNumber: number.trim(),
      amount: amt,
      currency: po.currency,
      issueDate: issueDate || null,
      dueDate: dueDate || null,
      fileUrl,
      fileName,
      filePathname,
      notes: notes.trim() || undefined,
    });
  }

  const totalInvoiced = invoices.reduce((s, i) => s + Number(i.amount), 0);
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <Panel
      title="Invoices"
      subtitle={`Posted by the supplier. Buyer AP marks them received → approved → scheduled → paid as they progress. ${fmtMoney(totalInvoiced, po.currency)} invoiced · ${fmtMoney(totalPaid, po.currency)} paid.`}
      headerRight={
        viewerRole === "supplier" || viewerRole === "buyer" ? (
          <button type="button" onClick={() => setAdding((a) => !a)} style={btnPrimary}>
            {adding ? "Cancel" : "+ Issue invoice"}
          </button>
        ) : null
      }
    >
      {adding && (
        <div style={{ ...formGrid, padding: 12, borderRadius: 10, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }}>
          <Input label="Invoice #" value={number} onChange={setNumber} />
          <Input label={`Amount (${po.currency})`} value={amount} onChange={setAmount} />
          <Input label="Issue date" value={issueDate} onChange={setIssueDate} type="date" />
          <Input label="Due date (optional)" value={dueDate} onChange={setDueDate} type="date" />
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: 50, fontFamily: "inherit" }} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Invoice file (PDF / Excel)</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...btnGhost, cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
                {uploading ? "Uploading…" : fileUrl ? "↺ Replace file" : "📤 Upload invoice"}
                <input
                  type="file"
                  accept="application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) uploadFile(f);
                  }}
                />
              </label>
              {fileUrl && (
                <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                  📎 {fileName ?? "Attached file"}
                </a>
              )}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={submit} disabled={busy} style={btnPrimary}>
              {busy ? "Posting…" : "Issue invoice"}
            </button>
          </div>
        </div>
      )}

      {invoices.length === 0 && !adding ? (
        <Empty>No invoices yet.</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {invoices.map((inv) => {
            const meta = INVOICE_STATUS_META[inv.status];
            const next = NEXT_STATUS_OPTIONS[inv.status];
            return (
              <div
                key={inv.id}
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  borderLeft: `4px solid ${meta.color}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14 }}>Invoice {inv.invoiceNumber}</strong>
                  <Pill label={meta.label} color={meta.color} />
                  <span style={{ marginLeft: "auto", fontSize: 13, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                    {fmtMoney(Number(inv.amount), inv.currency)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--lb-text-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {inv.issueDate && <span>Issued {inv.issueDate}</span>}
                  {inv.dueDate && <span>Due {inv.dueDate}</span>}
                  {inv.receivedAt && <span>Received {new Date(inv.receivedAt).toLocaleDateString()}</span>}
                  {inv.approvedAt && <span>Approved {new Date(inv.approvedAt).toLocaleDateString()}</span>}
                  {inv.scheduledPaymentDate && <span>Scheduled for {inv.scheduledPaymentDate}</span>}
                  {inv.paidAt && <span>Paid {new Date(inv.paidAt).toLocaleDateString()}</span>}
                </div>
                {inv.notes && <div style={{ fontSize: 12.5, color: "var(--lb-text-2)", whiteSpace: "pre-wrap" }}>{inv.notes}</div>}
                {inv.disputeReason && (
                  <div style={{ fontSize: 12.5, color: "#fca5a5" }}>⚠ {inv.disputeReason}</div>
                )}
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {inv.fileUrl && (
                    <a href={inv.fileUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                      📎 {inv.fileName ?? "Download invoice"}
                    </a>
                  )}
                  {viewerRole === "buyer" && next.length > 0 && (
                    <BuyerStatusFlipper inv={inv} options={next} busy={busy} onSetStatus={onSetStatus} />
                  )}
                  {(viewerRole === "supplier" || viewerRole === "buyer") && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirm(`Delete invoice ${inv.invoiceNumber}?`)) return;
                        onDelete(inv.id);
                      }}
                      style={miniBtn("#dc2626")}
                    >
                      ✕ Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function BuyerStatusFlipper({
  inv,
  options,
  busy,
  onSetStatus,
}: {
  inv: PoInvoice;
  options: PoInvoice["status"][];
  busy: boolean;
  onSetStatus: (input: Parameters<typeof setInvoiceStatus>[0]) => void;
}) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");

  function go(status: PoInvoice["status"]) {
    if (status === "scheduled") { setShowSchedule(true); return; }
    if (status === "disputed") { setShowDispute(true); return; }
    onSetStatus({ invoiceId: inv.id, status });
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {options.map((s) => (
        <button key={s} type="button" disabled={busy} onClick={() => go(s)} style={miniBtn(INVOICE_STATUS_META[s].color)}>
          → {INVOICE_STATUS_META[s].label}
        </button>
      ))}
      {showSchedule && (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, padding: "4px 8px", fontSize: 12 }} />
          <button type="button" disabled={busy || !date} onClick={() => onSetStatus({ invoiceId: inv.id, status: "scheduled", scheduledPaymentDate: date })} style={miniBtn("#7c3aed")}>
            Confirm
          </button>
          <button type="button" onClick={() => setShowSchedule(false)} style={miniBtn("#475569")}>Cancel</button>
        </span>
      )}
      {showDispute && (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle, padding: "4px 8px", fontSize: 12, minWidth: 180 }} />
          <button type="button" disabled={busy || !reason.trim()} onClick={() => onSetStatus({ invoiceId: inv.id, status: "disputed", disputeReason: reason })} style={miniBtn("#dc2626")}>
            Submit
          </button>
          <button type="button" onClick={() => setShowDispute(false)} style={miniBtn("#475569")}>Cancel</button>
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS — proof of payment posted by the buyer
// ─────────────────────────────────────────────────────────────────────────────

function PaymentsPanel({
  po,
  viewerRole,
  payments,
  invoices,
  busy,
  onAdd,
  onDelete,
}: {
  po: PurchaseOrder;
  viewerRole: "buyer" | "supplier";
  payments: PoPayment[];
  invoices: PoInvoice[];
  busy: boolean;
  onAdd: (input: Parameters<typeof addPoPayment>[0]) => void;
  onDelete: (paymentId: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("Wire");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [invoiceId, setInvoiceId] = useState<number | "">("");
  const [fileUrl, setFileUrl] = useState<string | undefined>();
  const [fileName, setFileName] = useState<string | undefined>();
  const [filePathname, setFilePathname] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const pathname = `purchase-orders/${po.id}/payments/${crypto.randomUUID()}-${safeFile(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      setFileUrl(blob.url);
      setFileName(file.name);
      setFilePathname(blob.pathname);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { alert("Payment amount must be positive"); return; }
    if (!paidOn) { alert("Payment date is required"); return; }
    onAdd({
      poId: po.id,
      invoiceId: invoiceId === "" ? null : Number(invoiceId),
      amount: amt,
      currency: po.currency,
      paidOn,
      method: method || undefined,
      reference: reference || undefined,
      fileUrl,
      fileName,
      filePathname,
      notes: notes || undefined,
    });
  }

  return (
    <Panel
      title="Proof of Payment"
      subtitle="Posted by the buyer after the wire / check / ACH actually leaves AP. The supplier sees the receipt the moment it lands."
      headerRight={
        viewerRole === "buyer" ? (
          <button type="button" onClick={() => setAdding((a) => !a)} style={btnPrimary}>
            {adding ? "Cancel" : "+ Record payment"}
          </button>
        ) : null
      }
    >
      {adding && (
        <div style={{ ...formGrid, padding: 12, borderRadius: 10, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }}>
          <div>
            <label style={labelStyle}>Apply to invoice (optional)</label>
            <select
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value === "" ? "" : Number(e.target.value))}
              style={inputStyle}
            >
              <option value="">— Not tied to a specific invoice —</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoiceNumber} · {fmtMoney(Number(i.amount), i.currency)} · {INVOICE_STATUS_META[i.status].label}
                </option>
              ))}
            </select>
          </div>
          <Input label={`Amount (${po.currency})`} value={amount} onChange={setAmount} />
          <Input label="Paid on" value={paidOn} onChange={setPaidOn} type="date" />
          <Input label="Method (Wire / ACH / Check)" value={method} onChange={setMethod} />
          <Input label="Reference / confirmation #" value={reference} onChange={setReference} />
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: 50, fontFamily: "inherit" }} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Proof file (wire receipt, check image, etc.)</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...btnGhost, cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
                {uploading ? "Uploading…" : fileUrl ? "↺ Replace file" : "📤 Upload proof"}
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) uploadFile(f);
                  }}
                />
              </label>
              {fileUrl && (
                <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                  📎 {fileName ?? "Attached file"}
                </a>
              )}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={submit} disabled={busy} style={btnPrimary}>
              {busy ? "Posting…" : "Record payment"}
            </button>
          </div>
        </div>
      )}

      {payments.length === 0 && !adding ? (
        <Empty>No payments recorded yet.</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {payments.map((p) => {
            const inv = p.invoiceId ? invoices.find((i) => i.id === p.invoiceId) : null;
            return (
              <div
                key={p.id}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  borderLeft: "4px solid #059669",
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    💸 {fmtMoney(Number(p.amount), p.currency)} on {p.paidOn}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 4, display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {p.method && <span>via {p.method}</span>}
                    {p.reference && <span>ref {p.reference}</span>}
                    {inv && <span>↳ Invoice {inv.invoiceNumber}</span>}
                  </div>
                  {p.notes && <div style={{ marginTop: 4, fontSize: 12, color: "var(--lb-text-2)", whiteSpace: "pre-wrap" }}>{p.notes}</div>}
                </div>
                {p.fileUrl && (
                  <a href={p.fileUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                    📎 {p.fileName ?? "Proof"}
                  </a>
                )}
                {viewerRole === "buyer" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirm("Delete this payment record?")) return;
                      onDelete(p.id);
                    }}
                    style={miniBtn("#dc2626")}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMELINE — production / shipment updates from either side
// ─────────────────────────────────────────────────────────────────────────────

function TimelinePanel({
  po,
  viewerRole,
  timeline,
  busy,
  onAdd,
  onDelete,
}: {
  po: PurchaseOrder;
  viewerRole: "buyer" | "supplier";
  timeline: PoTimelineEntry[];
  busy: boolean;
  onAdd: (input: Parameters<typeof postPoTimelineUpdate>[0]) => void;
  onDelete: (entryId: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [phase, setPhase] = useState<PurchaseOrder["status"] | "">("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [eta, setEta] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState<string | undefined>();
  const [attachmentName, setAttachmentName] = useState<string | undefined>();
  const [attachmentPathname, setAttachmentPathname] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const pathname = `purchase-orders/${po.id}/timeline/${crypto.randomUUID()}-${safeFile(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      setAttachmentUrl(blob.url);
      setAttachmentName(file.name);
      setAttachmentPathname(blob.pathname);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    if (!title.trim()) { alert("Update title is required"); return; }
    onAdd({
      poId: po.id,
      phase: phase || undefined,
      title: title.trim(),
      note: note.trim() || undefined,
      trackingNumber: trackingNumber.trim() || undefined,
      carrier: carrier.trim() || undefined,
      eta: eta || null,
      attachmentUrl,
      attachmentName,
      attachmentPathname,
    });
  }

  const currentPhase = po.status;
  const currentMeta = PO_STATUS_META[currentPhase];

  return (
    <Panel
      title="Production & Delivery Timeline"
      subtitle={`Free-form updates from either side. Each entry can carry a phase change so the PO chip stays in sync. Currently: ${currentMeta.label}.`}
      headerRight={
        <button type="button" onClick={() => setAdding((a) => !a)} style={btnPrimary}>
          {adding ? "Cancel" : "+ Post update"}
        </button>
      }
    >
      {adding && (
        <div style={{ ...formGrid, padding: 12, borderRadius: 10, background: "var(--lb-bg)", border: "1px solid var(--lb-border)" }}>
          <div>
            <label style={labelStyle}>Phase change (optional)</label>
            <select value={phase} onChange={(e) => setPhase(e.target.value as PurchaseOrder["status"] | "")} style={inputStyle}>
              <option value="">— No phase change, just an update —</option>
              {PHASE_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.emoji} {p.label}</option>
              ))}
            </select>
          </div>
          <Input label="Headline" value={title} onChange={setTitle} placeholder="e.g. Production started, ETA 12 days" />
          <Input label="Carrier (optional)" value={carrier} onChange={setCarrier} placeholder="DHL, UPS, FedEx…" />
          <Input label="Tracking number (optional)" value={trackingNumber} onChange={setTrackingNumber} />
          <Input label="ETA (optional)" value={eta} onChange={setEta} type="date" />
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Details</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, minHeight: 70, fontFamily: "inherit" }} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Attachment (photo, packing list, BOL…)</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...btnGhost, cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
                {uploading ? "Uploading…" : attachmentUrl ? "↺ Replace file" : "📤 Upload file"}
                <input
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) uploadFile(f);
                  }}
                />
              </label>
              {attachmentUrl && (
                <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                  📎 {attachmentName ?? "Attached file"}
                </a>
              )}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={submit} disabled={busy} style={btnPrimary}>
              {busy ? "Posting…" : "Post update"}
            </button>
          </div>
        </div>
      )}

      {timeline.length === 0 && !adding ? (
        <Empty>No production updates yet.</Empty>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {timeline.map((t) => {
            const phaseMeta = t.phase
              ? PO_STATUS_META[t.phase as PurchaseOrder["status"]]
              : null;
            return (
              <li
                key={t.id}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  borderLeft: `4px solid ${phaseMeta?.color ?? "#0891b2"}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13.5 }}>{t.title}</strong>
                  {phaseMeta && <Pill label={phaseMeta.label} color={phaseMeta.color} />}
                  <Pill label={t.postedByRole === "supplier" ? "Supplier" : "Buyer"} color={t.postedByRole === "supplier" ? "#0891b2" : "#7c3aed"} />
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--lb-text-3)" }}>
                    {new Date(t.postedAt).toLocaleString()}
                  </span>
                </div>
                {t.note && <div style={{ fontSize: 12.5, color: "var(--lb-text-2)", whiteSpace: "pre-wrap" }}>{t.note}</div>}
                {(t.trackingNumber || t.carrier || t.eta) && (
                  <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {t.carrier && <span>🚚 {t.carrier}</span>}
                    {t.trackingNumber && <span>📋 {t.trackingNumber}</span>}
                    {t.eta && <span>📅 ETA {t.eta}</span>}
                  </div>
                )}
                {t.attachmentUrl && (
                  <a href={t.attachmentUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                    📎 {t.attachmentName ?? "Attached file"}
                  </a>
                )}
                {(viewerRole === "buyer" || (viewerRole === "supplier" && t.postedByRole === "supplier")) && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirm("Delete this update?")) return;
                        onDelete(t.id);
                      }}
                      style={miniBtn("#dc2626")}
                    >
                      ✕ Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  headerRight,
  children,
}: {
  title: string;
  subtitle?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 16,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 200 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--lb-text)" }}>{title}</h3>
          {subtitle && <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>{subtitle}</p>}
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 14, borderRadius: 10, border: "1px dashed var(--lb-border)", textAlign: "center", color: "var(--lb-text-3)", fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "2px 8px",
        borderRadius: 999,
        background: `${color}22`,
        color,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--lb-text-3)", letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 13, color: "var(--lb-text)" }}>{children}</div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}

const formGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10.5,
  fontWeight: 800,
  color: "var(--lb-text-3)",
  letterSpacing: 0.5,
  textTransform: "uppercase",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  border: "1px solid var(--lb-border)",
  fontSize: 13,
};

const btnGhost: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  background: "transparent",
  color: "var(--lb-text-2)",
  border: "1px solid var(--lb-border)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  border: "1px solid var(--lb-accent)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const linkStyle: React.CSSProperties = {
  color: "var(--lb-accent)",
  textDecoration: "none",
  fontSize: 12.5,
  fontWeight: 600,
};

function miniBtn(color: string): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    background: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}
