"use client";

// Purchase Order view + print template. Styled to mirror the user's
// existing PO PDF (image 3) — Lightbase letterhead, bilingual labels,
// line-items table, totals block. `window.print()` produces a clean PDF
// because of the @media print rules at the bottom.

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import type {
  PoInvoice,
  PoPaymentMethod,
  PoPayment,
  PoTimelineEntry,
  PurchaseOrder,
  PurchaseOrderLine,
} from "@/db/schema";
import { PO_STATUS_META, fmtMoney } from "@/app/suppliers/_orders-constants";
import {
  clearPoSourcePdf,
  sendPo,
  setPoSourcePdf,
  updatePoStatus,
} from "@/app/suppliers/rfq-actions";
import PoTracker from "./PoTracker";

function safeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";
}

export default function PoView({
  po,
  lines,
  clientName,
  viewerRole = "buyer",
  clientLogoUrl = null,
  supplierLogoUrl = null,
  tracker,
}: {
  po: PurchaseOrder;
  lines: PurchaseOrderLine[];
  clientName: string;
  viewerRole?: "buyer" | "supplier";
  clientLogoUrl?: string | null;
  supplierLogoUrl?: string | null;
  tracker: {
    paymentMethod: PoPaymentMethod | null;
    invoices: PoInvoice[];
    payments: PoPayment[];
    timeline: PoTimelineEntry[];
  };
}) {
  // Letterhead-side note: the printable PO header uses the BUYER's brand
  // mark by convention (the buyer is issuing the PO). The supplier's mark
  // is shown as a small chip in the "Supplier's name" address block so
  // both parties' identities are visible on the printed page.
  void supplierLogoUrl;
  // `readOnly` used to gate buyer-only PO toolbar actions (send / acknowledge /
  // mark shipped, source-PDF upload). For the supplier viewer role those
  // actions need to stay locked to the buyer side, so we derive readOnly from
  // role here. The new tracker panel below handles its own per-action authz.
  const readOnly = viewerRole === "supplier";
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  function flip(action: "send" | PurchaseOrder["status"]) {
    setBusy(true);
    startTransition(async () => {
      try {
        if (action === "send") {
          await sendPo(po.id);
        } else {
          await updatePoStatus({ poId: po.id, status: action });
        }
      } finally {
        setBusy(false);
        window.location.reload();
      }
    });
  }

  const sub = Number(po.subtotal);
  const ship = Number(po.taxAmount);
  const total = Number(po.totalAmount);
  const statusMeta = PO_STATUS_META[po.status];
  const hasSourcePdf = Boolean(po.sourcePdfUrl);
  const [uploading, setUploading] = useState(false);

  async function uploadSource(file: File) {
    setUploading(true);
    try {
      const pathname = `purchase-orders/${po.id}/source/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      await setPoSourcePdf({
        poId: po.id,
        url: blob.url,
        name: file.name,
        blobPathname: blob.pathname,
      });
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function clearSource() {
    if (!confirm("Remove the uploaded PO PDF? The supplier will then see the platform-generated view.")) return;
    try {
      await clearPoSourcePdf(po.id);
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Remove failed");
    }
  }

  return (
    <>
      {/* Toolbar (hidden when printing) */}
      <div className="po-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            background: `${statusMeta.color}22`,
            color: statusMeta.color,
            fontWeight: 800,
            fontSize: 11,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {statusMeta.label}
        </span>
        {hasSourcePdf ? (
          <a
            href={po.sourcePdfUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            📥 Download PDF{po.sourcePdfName ? ` · ${po.sourcePdfName}` : ""}
          </a>
        ) : (
          <button type="button" onClick={() => window.print()} style={btn}>🖨 Print / PDF</button>
        )}
        <a href={`/api/po/${po.id}/xlsx`} download style={{ ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
          📊 Download Excel
        </a>
        {!readOnly && (
          <label
            style={{
              ...btn,
              cursor: uploading ? "wait" : "pointer",
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading
              ? "Uploading…"
              : hasSourcePdf
                ? "↺ Replace PO PDF"
                : "📤 Upload custom PO PDF"}
            <input
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) uploadSource(f);
              }}
            />
          </label>
        )}
        {!readOnly && hasSourcePdf && (
          <button type="button" onClick={clearSource} style={btn}>
            ✕ Remove custom PDF (use generated)
          </button>
        )}
        {!readOnly && po.status === "draft" && (
          <button type="button" disabled={busy} onClick={() => flip("send")} style={btnPrimary}>
            {busy ? "Sending…" : "📨 Mark as sent"}
          </button>
        )}
        {!readOnly && (po.status === "sent" || po.status === "draft") && (
          <button type="button" disabled={busy} onClick={() => flip("acknowledged")} style={btn}>
            ✅ Mark acknowledged
          </button>
        )}
        {!readOnly && po.status !== "shipped" && po.status !== "received" && po.status !== "cancelled" && (
          <button type="button" disabled={busy} onClick={() => flip("shipped")} style={btn}>
            🚚 Mark shipped
          </button>
        )}
        {!readOnly && po.status === "shipped" && (
          <button type="button" disabled={busy} onClick={() => flip("received")} style={btn}>
            📦 Mark received
          </button>
        )}
      </div>

      {hasSourcePdf && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(124,58,237,0.08)",
            border: "1px solid rgba(124,58,237,0.4)",
            color: "var(--lb-text)",
            fontSize: 12,
          }}
        >
          📎 Showing the uploaded PDF below. The platform-generated view is
          still available — click <b>Remove custom PDF</b> above to swap back.
        </div>
      )}

      {hasSourcePdf ? (
        <iframe
          src={po.sourcePdfUrl ?? ""}
          title={po.sourcePdfName ?? "PO PDF"}
          style={{
            width: "100%",
            height: "85vh",
            border: "1px solid var(--lb-border)",
            borderRadius: 10,
            background: "#fff",
          }}
        />
      ) : (
      <>
      {/* The printed page */}
      <div
        className="po-doc"
        style={{
          background: "#fff",
          color: "#111",
          padding: 36,
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          fontFamily: "Inter, Helvetica, Arial, sans-serif",
        }}
      >
        {/* Letterhead */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            {clientLogoUrl ? (
              <img
                src={clientLogoUrl}
                alt={`${clientName} logo`}
                style={{ width: 80, height: 80, objectFit: "contain", borderRadius: 4 }}
              />
            ) : (
              <div
                aria-hidden
                style={{
                  width: 56,
                  height: 56,
                  display: "grid",
                  placeItems: "center",
                  background: "#0f1115",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 18,
                  borderRadius: 6,
                }}
              >
                L
              </div>
            )}
            <div>
              <div style={{ fontWeight: 800, fontSize: 14, color: "#111" }}>{clientName.toUpperCase()}</div>
              <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>
                10871 Avenue Salk, Montreal (QC) Canada, H1G 6M7<br />
                Tel +1.514.600.5140 · info@lightbase.ca · www.lightbase.ca<br />
                GST/HST Registration No.: 737875302RT0001<br />
                QST Registration No.: 1228299711TQ0001
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#111" }}>
              PURCHASE ORDER <span style={{ fontWeight: 400, color: "#777", fontSize: 12 }}>(Bon de commande)</span>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <Row label="PO number" value={po.poNumber} />
              <Row label="Project reference (Référence de projet)" value={po.projectNum} />
              {po.propositionReference && (
                <Row label="Proposition reference (Référence de proposition)" value={po.propositionReference} highlight />
              )}
              <Row label="Creation date (Date de création)" value={new Date(po.createdAt).toLocaleDateString()} />
            </div>
          </div>
        </div>

        {/* Address blocks */}
        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, fontSize: 11.5 }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Supplier's name <span style={{ color: "#999", fontWeight: 400 }}>(Nom du fournisseur)</span></div>
            <div style={{ whiteSpace: "pre-line" }}>{po.supplierName}</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Billing Address <span style={{ color: "#999", fontWeight: 400 }}>(Adresse de facturation)</span></div>
            <div style={{ whiteSpace: "pre-line" }}>{po.billingAddress ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Shipping Address <span style={{ color: "#999", fontWeight: 400 }}>(Adresse de livraison)</span></div>
            <div style={{ whiteSpace: "pre-line" }}>{po.shippingAddress ?? "—"}</div>
          </div>
        </div>

        {/* Line items */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24, fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: "#0f1115", color: "#fff" }}>
              <th style={th}>LIGHTBASE REF.</th>
              <th style={th}>REF</th>
              <th style={{ ...th, textAlign: "left" }}>Description</th>
              <th style={{ ...th, textAlign: "right" }}>Quantité (QTY)</th>
              <th style={{ ...th, textAlign: "right" }}>Unit price (prix unitaire)</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#888" }}>No line items.</td></tr>
            ) : lines.map((l) => (
              <tr key={l.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={{ ...td, textAlign: "center", background: "#f0f9ff" }}>
                  <strong style={{ color: "#0a58ca", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 10.5 }}>
                    {l.lightbaseRef ?? "—"}
                  </strong>
                </td>
                <td style={td}><strong>{l.ref ?? ""}</strong></td>
                <td style={td}>{l.description}</td>
                <td style={{ ...td, textAlign: "right" }}>{l.qty}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtMoney(Number(l.unitPrice), po.currency)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtMoney(Number(l.totalPrice), po.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <div style={{ minWidth: 360, fontSize: 12 }}>
            <Total label="PO amount (Montant du PO)" value={fmtMoney(sub, po.currency)} />
            <Total label="Discount amount (Montant du rabais)" value={fmtMoney(Number(po.discountAmount), po.currency)} />
            <Total label="Amount after discount (Montant après rabais)" value={fmtMoney(sub - Number(po.discountAmount), po.currency)} />
            <Total label="Shipping / tax (Frais d'expédition)" value={fmtMoney(ship, po.currency)} />
            <Total label="Amount with taxes (Montant avec taxes)" value={fmtMoney(total, po.currency)} bold />
          </div>
        </div>

        {/* Commercial terms */}
        <div style={{ marginTop: 22, padding: 12, borderRadius: 6, background: "#f5f5f7", fontSize: 11.5 }}>
          <div><b>Incoterms:</b> {po.incoterms ?? "—"} · <b>Transport:</b> {po.transportMode}</div>
          {po.notes && <div style={{ marginTop: 6, whiteSpace: "pre-line" }}>{po.notes}</div>}
        </div>
      </div>
      </>
      )}

      {/* Payment & Delivery Tracker — both parties see this. The tracker
          panel handles its own forms / authz and is hidden on print. */}
      <div className="po-tracker-wrap">
        <PoTracker
          po={po}
          viewerRole={viewerRole}
          paymentMethod={tracker.paymentMethod}
          invoices={tracker.invoices}
          payments={tracker.payments}
          timeline={tracker.timeline}
        />
      </div>

      {/* Print stylesheet */}
      <style>{`
        @media print {
          body { background: #fff !important; }
          .po-toolbar { display: none !important; }
          .po-tracker-wrap { display: none !important; }
          .po-doc { box-shadow: none !important; padding: 0 !important; }
        }
      `}</style>
    </>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  background: "var(--lb-bg-elev)",
  color: "var(--lb-text)",
  border: "1px solid var(--lb-border)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  border: "1px solid var(--lb-accent)",
};

const th: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "center",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
};

const td: React.CSSProperties = {
  padding: "8px 10px",
  verticalAlign: "top",
  color: "#222",
};

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#555" }}>{label}</span>
      <span style={{
        fontWeight: 700,
        background: highlight ? "#fff6d1" : "transparent",
        padding: highlight ? "1px 6px" : 0,
        borderRadius: highlight ? 4 : 0,
      }}>{value}</span>
    </div>
  );
}

function Total({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "6px 0",
      borderTop: "1px solid #e5e7eb",
      fontWeight: bold ? 800 : 500,
      background: bold ? "#f5f5f7" : "transparent",
      paddingLeft: bold ? 8 : 0,
      paddingRight: bold ? 8 : 0,
    }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
