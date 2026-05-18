"use client";

// Quote view + print template. When the supplier uploaded a quote PDF, we
// embed it here as the canonical record. Otherwise we render the
// structured fields as a formal "QUOTATION" document mirroring image 2 so
// the buyer always has a printable PDF + the supplier always has a copy.

import type {
  Rfq,
  RfqItem,
  RfqItemAttachment,
  SupplierQuote,
  SupplierQuoteLine,
} from "@/db/schema";
import { TRANSPORT_MODE_META, fmtMoney } from "@/app/suppliers/_orders-constants";

export default function QuoteView({
  quote,
  rfq,
  items,
  lines,
  attachmentsByItem = {},
  supplierLogoUrl = null,
  clientLogoUrl = null,
  clientName,
}: {
  quote: SupplierQuote;
  rfq: Rfq;
  items: RfqItem[];
  lines: SupplierQuoteLine[];
  attachmentsByItem?: Record<number, RfqItemAttachment[]>;
  supplierLogoUrl?: string | null;
  clientLogoUrl?: string | null;
  clientName: string;
}) {
  const hasSourcePdf = Boolean(quote.sourcePdfUrl);
  const tm = TRANSPORT_MODE_META[quote.transportMode];

  // Match each RFQ item with its quoted line
  const lineByItem = new Map(lines.map((l) => [l.rfqItemId, l]));
  let subtotal = 0;
  const rows = items.map((it) => {
    const l = lineByItem.get(it.id);
    const unit = l ? Number(l.unitPrice) : 0;
    const total = unit * it.qty;
    subtotal += total;
    return { it, l, unit, total };
  });
  const ship = Number(quote.shippingCost ?? 0);
  const grandTotal = subtotal + ship;

  return (
    <>
      <div className="quote-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {hasSourcePdf ? (
          <a
            href={quote.sourcePdfUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            style={btn}
          >
            📥 Download PDF{quote.sourcePdfName ? ` · ${quote.sourcePdfName}` : ""}
          </a>
        ) : (
          <button type="button" onClick={() => window.print()} style={btn}>
            🖨 Print / PDF
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
          📎 Supplier uploaded their own quote PDF. The structured fields below
          are still readable on screen for the buyer's reference.
        </div>
      )}

      {hasSourcePdf ? (
        <iframe
          src={quote.sourcePdfUrl ?? ""}
          title={quote.sourcePdfName ?? "Quote PDF"}
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
          className="quote-doc"
          style={{
            background: "#fff",
            color: "#111",
            padding: 36,
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            fontFamily: "Inter, Helvetica, Arial, sans-serif",
          }}
        >
          {/* Header — supplier letterhead */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              {supplierLogoUrl && (
                <img
                  src={supplierLogoUrl}
                  alt={`${quote.companyName} logo`}
                  style={{ width: 80, height: 80, objectFit: "contain", borderRadius: 4 }}
                />
              )}
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "#111" }}>{quote.companyName}</div>
                <div style={{ fontSize: 11, color: "#555", lineHeight: 1.6 }}>
                  {quote.contactName && <div>{quote.contactName}</div>}
                  {quote.contactEmail && <div>{quote.contactEmail}</div>}
                  {quote.contactPhone && <div>{quote.contactPhone}</div>}
                  {quote.address && <div>{quote.address}</div>}
                  {quote.countryOfOrigin && <div>Origin: {quote.countryOfOrigin}</div>}
                </div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#111" }}>
                QUOTATION
              </div>
              <div style={{ marginTop: 14, fontSize: 12, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                {clientLogoUrl && (
                  <img
                    src={clientLogoUrl}
                    alt={`${clientName} logo`}
                    style={{ width: 60, height: 60, objectFit: "contain", marginBottom: 4 }}
                  />
                )}
                <Row label="For" value={clientName} />
                <Row label="RFQ ref" value={rfq.rfqNumber} highlight />
                <Row label="Project" value={rfq.projectName ?? rfq.projectNum} />
                {quote.submittedAt && (
                  <Row label="Submitted" value={new Date(quote.submittedAt).toLocaleDateString()} />
                )}
                {quote.validityUntil && (
                  <Row label="Valid until" value={String(quote.validityUntil)} />
                )}
              </div>
            </div>
          </div>

          {/* Commercial terms strip */}
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
            <Chip label="Currency" value={quote.currency} />
            <Chip label="Incoterms" value={quote.incoterms ?? "—"} />
            <Chip label="Transport" value={`${tm.icon} ${tm.label}`} />
            <Chip label="Lead time" value={`${quote.leadTimeDays}d`} />
            {quote.manufacturerName && (
              <Chip label="Manufacturer" value={quote.manufacturerName} />
            )}
            {quote.manufacturerPartNumber && (
              <Chip label="MFG part #" value={quote.manufacturerPartNumber} />
            )}
          </div>

          {/* Line items */}
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 22, fontSize: 11.5 }}>
            <thead>
              <tr style={{ background: "#0f1115", color: "#fff" }}>
                <th style={th}>LIGHTBASE REF.</th>
                <th style={th}>REF</th>
                <th style={th}>PHOTO</th>
                <th style={{ ...th, textAlign: "left" }}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>QTY</th>
                <th style={{ ...th, textAlign: "right" }}>SEC. STOCK</th>
                <th style={{ ...th, textAlign: "right" }}>TOTAL QTY</th>
                <th style={{ ...th, textAlign: "right" }}>MOQ</th>
                <th style={{ ...th, textAlign: "right" }}>Unit price</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ padding: 18, textAlign: "center", color: "#888" }}>
                    No line items.
                  </td>
                </tr>
              ) : (
                rows.map(({ it, l, unit, total }) => {
                  const atts = attachmentsByItem[it.id] ?? [];
                  const photos = atts.filter((a) => a.kind === "photo");
                  return (
                    <tr key={it.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      <td style={{ ...td, textAlign: "center", background: "#f0f9ff" }}>
                        <strong style={{ color: "#0a58ca", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 10.5 }}>
                          {it.lightbaseRef ?? "—"}
                        </strong>
                      </td>
                      <td style={{ ...td, textAlign: "center" }}>
                        <strong>{it.clientRef ?? ""}</strong>
                      </td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {photos.length > 0 ? (
                          <a href={photos[0].url} target="_blank" rel="noopener noreferrer">
                            <img
                              src={photos[0].url}
                              alt={photos[0].name}
                              style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #ddd" }}
                            />
                          </a>
                        ) : (
                          <span style={{ color: "#bbb", fontSize: 10 }}>—</span>
                        )}
                      </td>
                      <td style={td}>
                        {it.description}
                        {it.specifications && (
                          <div style={{ color: "#555", fontSize: 10.5, marginTop: 2 }}>{it.specifications}</div>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>{it.qty}</td>
                      <td style={{ ...td, textAlign: "right" }}>{it.securityStock}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700, background: "#f5f5f7" }}>
                        {it.qty + it.securityStock}
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>{l?.moq ?? "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {fmtMoney(unit, quote.currency)}
                      </td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>
                        {fmtMoney(total, quote.currency)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {/* Totals */}
          <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
            <div style={{ minWidth: 320, fontSize: 12 }}>
              <Total label="Subtotal" value={fmtMoney(subtotal, quote.currency)} />
              <Total label="Shipping / freight" value={fmtMoney(ship, quote.currency)} />
              <Total label="TOTAL" value={fmtMoney(grandTotal, quote.currency)} bold />
            </div>
          </div>

          {quote.notes && (
            <div style={{ marginTop: 18, padding: 12, borderRadius: 6, background: "#fff6d1", fontSize: 11.5 }}>
              <b>Notes:</b> {quote.notes}
            </div>
          )}
        </div>
      )}

      <style>{`
        @media print {
          body { background: #fff !important; }
          .quote-toolbar { display: none !important; }
          .quote-doc { box-shadow: none !important; padding: 0 !important; }
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
