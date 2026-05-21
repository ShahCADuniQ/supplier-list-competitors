"use client";

// RFQ print + download template. Matches the buyer's existing Excel
// (image 1) so the PDF/Excel that come out look like the document the
// team used to email by hand.

import { useState } from "react";
import { upload } from "@vercel/blob/client";
import type { Rfq, RfqItem, RfqItemAttachment, RfqRecipient } from "@/db/schema";
import {
  RFQ_STAGE_META,
  RFQ_STATUS_META,
  TRANSPORT_MODE_META,
} from "@/app/suppliers/_orders-constants";
import { clearRfqSourcePdf, setRfqSourcePdf } from "@/app/suppliers/rfq-actions";

function safeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";
}

// Subset of inventory_items used by the print template — passed through
// from the loader so the WEIGHT / SURFACE AREA / VOLUME columns can pull
// IFC-derived numbers without an extra round-trip.
type RfqViewInventory = {
  id: number;
  weightG: string | null;
  surfaceAreaMm2: string | null;
  volumeMm3: string | null;
  material: string | null;
  densityGCm3: string | null;
  thumbnailUrl: string | null;
};

function fmtNumber(v: string | number | null, opts?: { fractionDigits?: number }): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return "—";
  const d = opts?.fractionDigits ?? 2;
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export default function RfqView({
  rfq,
  items,
  attachmentsByItem = {},
  inventoryByItemId = {},
  clientLogoUrl = null,
  recipients,
  clientName,
  canEdit = false,
  showRecipients = true,
}: {
  rfq: Rfq;
  items: RfqItem[];
  attachmentsByItem?: Record<number, RfqItemAttachment[]>;
  inventoryByItemId?: Record<number, RfqViewInventory>;
  clientLogoUrl?: string | null;
  recipients: Array<RfqRecipient & { portalUrl: string }>;
  clientName: string;
  canEdit?: boolean;
  showRecipients?: boolean;
}) {
  const tm = TRANSPORT_MODE_META[rfq.transportMode];
  const sg = RFQ_STAGE_META[rfq.stage];
  const st = RFQ_STATUS_META[rfq.status];
  const hasSourcePdf = Boolean(rfq.sourcePdfUrl);
  const [uploading, setUploading] = useState(false);

  async function uploadSource(file: File) {
    setUploading(true);
    try {
      const pathname = `rfqs/${rfq.id}/source/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      await setRfqSourcePdf({
        rfqId: rfq.id,
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
    if (!confirm("Remove the uploaded RFQ PDF? The supplier will then see the platform-generated view.")) return;
    try {
      await clearRfqSourcePdf(rfq.id);
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Remove failed");
    }
  }

  return (
    <>
      {/* Toolbar — hidden when printing */}
      <div className="rfq-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hasSourcePdf ? (
          <a
            href={rfq.sourcePdfUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            style={btn}
          >
            📥 Download PDF{rfq.sourcePdfName ? ` · ${rfq.sourcePdfName}` : ""}
          </a>
        ) : (
          <button type="button" onClick={() => window.print()} style={btn}>
            🖨 Print / PDF
          </button>
        )}
        <a href={`/api/rfq/${rfq.id}/xlsx`} download style={btn}>
          📊 Download Excel
        </a>
        {canEdit && (
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
                ? "↺ Replace RFQ PDF"
                : "📤 Upload custom RFQ PDF"}
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
        {canEdit && hasSourcePdf && (
          <button type="button" onClick={clearSource} style={btn}>
            ✕ Remove custom PDF (use generated)
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
          📎 Showing the uploaded RFQ PDF below. The platform-generated view
          is still available — {canEdit ? "click \"Remove custom PDF\" above" : "ask your buyer to remove it"} to see it.
        </div>
      )}

      {hasSourcePdf ? (
        <iframe
          src={rfq.sourcePdfUrl ?? ""}
          title={rfq.sourcePdfName ?? "RFQ PDF"}
          style={{
            width: "100%",
            height: "85vh",
            border: "1px solid var(--lb-border)",
            borderRadius: 10,
            background: "#fff",
          }}
        />
      ) : (
      <div
        className="rfq-doc"
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
              REQUEST FOR QUOTATION{" "}
              <span style={{ fontWeight: 400, color: "#777", fontSize: 12 }}>(Demande de prix)</span>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <Row label="RFQ number" value={rfq.rfqNumber} />
              <Row label="Project number" value={rfq.projectNum} />
              {rfq.projectName && <Row label="Project name" value={rfq.projectName} highlight />}
              {rfq.niche && <Row label="Niche" value={rfq.niche} />}
              <Row label="Created" value={new Date(rfq.createdAt).toLocaleDateString()} />
            </div>
          </div>
        </div>

        {/* Header chips */}
        <div
          style={{
            marginTop: 22,
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            fontSize: 11.5,
            padding: "12px 14px",
            borderRadius: 6,
            background: "#f5f5f7",
            color: "#333",
          }}
        >
          <Chip label="Stage" value={sg.label} />
          <Chip label="Status" value={st.label} />
          <Chip label="Currency" value={rfq.targetCurrency} />
          <Chip label="Incoterms" value={rfq.incoterms ?? "—"} />
          <Chip label="Transport" value={`${tm.icon} ${tm.label}`} />
          {rfq.quoteDeadline && (
            <Chip label="Quote deadline" value={new Date(rfq.quoteDeadline).toLocaleDateString()} />
          )}
        </div>

        {/* Line items */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 22, fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: "#0f1115", color: "#fff" }}>
              <th style={th}>LIGHTBASE REF.</th>
              <th style={th}>CLIENT REF.</th>
              <th style={th}>PRODUCT PHOTO</th>
              <th style={{ ...th, textAlign: "left" }}>PART NUMBER</th>
              <th style={{ ...th, textAlign: "left" }}>DESCRIPTION</th>
              <th style={{ ...th, textAlign: "right" }}>QTY</th>
              <th style={{ ...th, textAlign: "right" }}>SECURITY STOCK</th>
              <th style={{ ...th, textAlign: "right" }}>TOTAL QTY</th>
              <th style={{ ...th, textAlign: "left" }}>MATERIAL</th>
              <th style={{ ...th, textAlign: "right" }}>WEIGHT (g)</th>
              <th style={{ ...th, textAlign: "right" }}>SURFACE AREA (mm²)</th>
              <th style={{ ...th, textAlign: "right" }}>VOLUME (mm³)</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={12} style={{ padding: 18, textAlign: "center", color: "#888" }}>
                  No line items.
                </td>
              </tr>
            ) : (
              items.map((it, rowIdx) => {
                const atts = attachmentsByItem[it.id] ?? [];
                const inv = it.inventoryItemId != null ? inventoryByItemId[it.inventoryItemId] : undefined;
                // Legacy single catalog_attachment_* is treated as a virtual
                // doc attachment so older RFQs still show their file chip.
                const legacy = it.catalogAttachmentUrl
                  ? [{
                      id: -1,
                      rfqItemId: it.id,
                      kind: "doc" as const,
                      name: it.catalogAttachmentName ?? "Catalog",
                      url: it.catalogAttachmentUrl,
                      blobPathname: null,
                      contentType: null,
                      size: 0,
                      createdAt: it.createdAt,
                    }]
                  : [];
                const photos = atts.filter((a) => a.kind === "photo");
                const docs = [...atts.filter((a) => a.kind === "doc"), ...legacy];
                return (
                  <tr key={it.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                    <td style={{ ...td, textAlign: "center", background: "#f0f9ff" }}>
                      <strong style={{ color: "#0a58ca", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 10.5 }}>
                        {it.lightbaseRef ?? "—"}
                      </strong>
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <strong>{it.clientRef ?? rowIdx + 1}</strong>
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {photos.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
                          {photos.slice(0, 3).map((p) => (
                            <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
                              <img
                                src={p.url}
                                alt={p.name}
                                style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 4, border: "1px solid #ddd" }}
                              />
                            </a>
                          ))}
                          {photos.length > 3 && (
                            <span style={{ fontSize: 10, color: "#777" }}>+{photos.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: "#bbb", fontSize: 10 }}>—</span>
                      )}
                    </td>
                    <td style={td}>{it.productCode ?? ""}</td>
                    <td style={td}>
                      {it.description}
                      {it.specifications && (
                        <div style={{ color: "#555", fontSize: 10.5, marginTop: 2 }}>{it.specifications}</div>
                      )}
                      {it.productUrl && (
                        <div style={{ fontSize: 10.5, marginTop: 2 }}>
                          <a href={it.productUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#0a58ca" }}>
                            {it.productUrl}
                          </a>
                        </div>
                      )}
                      {docs.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {docs.map((d) => (
                            <a
                              key={d.id}
                              href={d.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 10.5,
                                padding: "2px 8px",
                                borderRadius: 4,
                                background: "#f1f5f9",
                                color: "#0a58ca",
                                textDecoration: "none",
                                border: "1px solid #e2e8f0",
                              }}
                            >
                              📎 {d.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{it.qty}</td>
                    <td style={{ ...td, textAlign: "right" }}>{it.securityStock}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700, background: "#f5f5f7" }}>
                      {it.qty + it.securityStock}
                    </td>
                    <td style={{ ...td, textAlign: "left", color: "#222", fontSize: 10.5 }}>
                      {inv?.material ?? "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtNumber(inv?.weightG ?? null)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtNumber(inv?.surfaceAreaMm2 ?? null)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtNumber(inv?.volumeMm3 ?? null)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {rfq.notes && (
          <div style={{ marginTop: 18, padding: 12, borderRadius: 6, background: "#fff6d1", fontSize: 11.5 }}>
            <b>Notes:</b> {rfq.notes}
          </div>
        )}

        {showRecipients && recipients.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
              Sent to {recipients.length} supplier{recipients.length === 1 ? "" : "s"}:
            </div>
            <div style={{ fontSize: 11, color: "#555" }}>
              {recipients.map((r) => r.inviteEmail).join(" · ")}
            </div>
          </div>
        )}
      </div>
      )}

      <style>{`
        @media print {
          body { background: #fff !important; }
          .rfq-toolbar { display: none !important; }
          .rfq-doc { box-shadow: none !important; padding: 0 !important; }
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
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
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

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: "#888", fontWeight: 700 }}>
        {label}
      </span>
      <span style={{ fontWeight: 700, fontSize: 12 }}>{value}</span>
    </div>
  );
}
