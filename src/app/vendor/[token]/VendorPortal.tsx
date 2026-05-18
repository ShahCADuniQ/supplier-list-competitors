"use client";

// Supplier-facing portal. Token-gated so no Clerk login is needed. The
// supplier sees the RFQ, fills out the unified quote form (snapshotted
// company info + per-item pricing), and uploads supporting docs. Saving
// "draft" updates the row; clicking Submit locks it + notifies the buyer.
//
// Uploads use the existing Vercel Blob client + /api/blob/upload route —
// access is open since the token gates the whole portal.

import { useMemo, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  CURRENCY_OPTIONS,
  TRANSPORT_MODE_META,
  TRANSPORT_MODE_ORDER,
  fmtMoney,
} from "@/app/suppliers/_orders-constants";
import IncotermSelect from "@/app/suppliers/IncotermSelect";
import {
  addVendorQuoteAttachment,
  declineVendorRfq,
  deleteVendorQuoteAttachment,
  submitVendorQuote,
  type VendorPortalPayload,
} from "@/app/suppliers/rfq-actions";
import { parseQuoteFromUpload } from "@/app/suppliers/rfq-extract-actions";

const ATT_KINDS = [
  { key: "datasheet", label: "Technical datasheet", icon: "📋" },
  { key: "certification", label: "Certification (UL/CSA/RoHS)", icon: "🛡" },
  { key: "brochure", label: "Brochure / catalog", icon: "📚" },
  { key: "image", label: "Product image", icon: "🖼" },
  { key: "other", label: "Other", icon: "📎" },
];

function safeFileName(name: string) {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";
}

export default function VendorPortal({
  token,
  portal,
  clientName,
  supplierHomeToken,
}: {
  token: string;
  portal: VendorPortalPayload;
  clientName: string;
  supplierHomeToken: string | null;
}) {
  const { recipient, rfq, items, quote, lines, attachments } = portal;
  const isLocked = quote?.status === "submitted";
  const isDeclined =
    recipient.status === "declined" || quote?.status === "declined";

  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<null | "save" | "submit" | "upload">(null);

  function ping(msg: string, err?: boolean) {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 3000);
  }

  // Form state — seeded from the existing quote or sensible defaults.
  const [companyName, setCompanyName] = useState(quote?.companyName ?? recipient.inviteName ?? "");
  const [contactName, setContactName] = useState(quote?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(quote?.contactEmail ?? recipient.inviteEmail);
  const [contactPhone, setContactPhone] = useState(quote?.contactPhone ?? "");
  const [address, setAddress] = useState(quote?.address ?? "");
  const [countryOfOrigin, setCountryOfOrigin] = useState(quote?.countryOfOrigin ?? "");
  const [manufacturerName, setManufacturerName] = useState(quote?.manufacturerName ?? "");
  const [manufacturerPartNumber, setManufacturerPartNumber] = useState(quote?.manufacturerPartNumber ?? "");
  const [currency, setCurrency] = useState(quote?.currency ?? rfq.targetCurrency);
  const [incoterms, setIncoterms] = useState(quote?.incoterms ?? rfq.incoterms ?? "FOB");
  const [transportMode, setTransportMode] = useState<typeof rfq.transportMode>(quote?.transportMode ?? rfq.transportMode);
  const [shippingCost, setShippingCost] = useState(String(quote?.shippingCost ?? 0));
  const [leadTimeDays, setLeadTimeDays] = useState(String(quote?.leadTimeDays ?? ""));
  const [validityUntil, setValidityUntil] = useState(quote?.validityUntil ?? "");
  const [notes, setNotes] = useState(quote?.notes ?? "");
  const [sourcePdfUrl, setSourcePdfUrl] = useState(quote?.sourcePdfUrl ?? "");
  const [sourcePdfName, setSourcePdfName] = useState(quote?.sourcePdfName ?? "");

  // Per-item pricing. Seeded from existing quote lines if any.
  const initialLines = useMemo(() => {
    return items.map((it) => {
      const line = lines.find((l) => l.rfqItemId === it.id);
      return {
        rfqItemId: it.id,
        unitPrice: line ? Number(line.unitPrice) : 0,
        moq: line?.moq ?? 1,
        availableStock: line?.availableStock ?? null,
        leadTimeDays: line?.leadTimeDays ?? null,
        notes: line?.notes ?? "",
      };
    });
  }, [items, lines]);
  const [lineState, setLineState] = useState(initialLines);

  function updateLine(idx: number, patch: Partial<(typeof initialLines)[number]>) {
    setLineState((s) => s.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function save(finalize: boolean) {
    setBusy(finalize ? "submit" : "save");
    startTransition(async () => {
      try {
        await submitVendorQuote({
          token,
          companyName: companyName.trim(),
          contactName,
          contactEmail,
          contactPhone,
          address,
          countryOfOrigin,
          manufacturerName,
          manufacturerPartNumber,
          currency,
          incoterms,
          transportMode,
          shippingCost: Number(shippingCost) || 0,
          leadTimeDays: Number(leadTimeDays) || 0,
          validityUntil: validityUntil || null,
          notes,
          sourcePdfUrl: sourcePdfUrl || undefined,
          sourcePdfName: sourcePdfName || undefined,
          finalize,
          lines: lineState.map((l) => ({
            rfqItemId: l.rfqItemId,
            unitPrice: l.unitPrice,
            moq: l.moq,
            availableStock: l.availableStock,
            leadTimeDays: l.leadTimeDays,
            notes: l.notes,
          })),
        });
        ping(finalize ? "Quote submitted — Lightbase has been notified" : "Draft saved");
        if (finalize) {
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch (e) {
        ping(e instanceof Error ? e.message : "Save failed", true);
      } finally {
        setBusy(null);
      }
    });
  }

  async function handleDecline() {
    const reason = window.prompt(
      `Decline this RFQ from ${clientName}? Add an optional reason — the buyer sees it.\n\n(Leave blank to decline without explanation.)`,
      "",
    );
    if (reason === null) return; // user cancelled
    setBusy("submit");
    startTransition(async () => {
      try {
        await declineVendorRfq({ token, reason: reason || undefined });
        ping("RFQ declined — the buyer has been notified");
        setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Decline failed", true);
      } finally {
        setBusy(null);
      }
    });
  }

  async function handleUpload(files: FileList | null, kind: string) {
    if (!files || files.length === 0) return;
    if (!quote) {
      ping("Save your quote first, then attach files", true);
      return;
    }
    setBusy("upload");
    try {
      for (const f of Array.from(files)) {
        const pathname = `vendor-quotes/${quote.id}/${kind}/${crypto.randomUUID()}-${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/vendor/upload",
          clientPayload: token,
          contentType: f.type || undefined,
        });
        await addVendorQuoteAttachment({
          token,
          kind,
          name: f.name,
          size: f.size,
          mimeType: f.type,
          url: blob.url,
          blobPathname: blob.pathname,
        });
      }
      ping(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`);
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      ping(e instanceof Error ? e.message : "Upload failed", true);
    } finally {
      setBusy(null);
    }
  }

  async function handleSourceFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    setBusy("upload");
    try {
      const pathname = `vendor-quotes/source/${recipient.id}/${crypto.randomUUID()}-${safeFileName(f.name)}`;
      const blob = await upload(pathname, f, {
        access: "public",
        handleUploadUrl: "/api/vendor/upload",
        clientPayload: token,
        contentType: f.type || undefined,
      });
      setSourcePdfUrl(blob.url);
      setSourcePdfName(f.name);
      // Now ask Claude to extract structured fields from the uploaded file.
      ping("Reading your quote with AI…");
      const parsed = await parseQuoteFromUpload({
        token,
        url: blob.url,
        fileName: f.name,
      });
      // Merge into the form — only overwrite blank fields so the supplier's
      // typed values are preserved.
      if (!companyName.trim() && parsed.companyName) setCompanyName(parsed.companyName);
      if (!contactName.trim() && parsed.contactName) setContactName(parsed.contactName);
      if (!contactEmail.trim() && parsed.contactEmail) setContactEmail(parsed.contactEmail);
      if (!contactPhone.trim() && parsed.contactPhone) setContactPhone(parsed.contactPhone);
      if (!address.trim() && parsed.address) setAddress(parsed.address);
      if (!countryOfOrigin.trim() && parsed.countryOfOrigin) setCountryOfOrigin(parsed.countryOfOrigin);
      if (!manufacturerName.trim() && parsed.manufacturerName) setManufacturerName(parsed.manufacturerName);
      if (!manufacturerPartNumber.trim() && parsed.manufacturerPartNumber)
        setManufacturerPartNumber(parsed.manufacturerPartNumber);
      if (parsed.currency) setCurrency(parsed.currency);
      if (parsed.incoterms) setIncoterms(parsed.incoterms);
      if (parsed.transportMode) setTransportMode(parsed.transportMode);
      if (parsed.shippingCost != null) setShippingCost(String(parsed.shippingCost));
      if (parsed.leadTimeDays != null) setLeadTimeDays(String(parsed.leadTimeDays));
      if (parsed.validityUntil) setValidityUntil(parsed.validityUntil);
      if (!notes.trim() && parsed.notes) setNotes(parsed.notes);
      // Per-line pricing — match Claude's lines to our RFQ items by
      // clientRef (best signal) and fall back to position.
      if (parsed.lines.length > 0) {
        setLineState((prev) =>
          prev.map((cur, idx) => {
            const it = items[idx];
            // Prefer match by clientRef
            const byRef = parsed.lines.find(
              (pl) => pl.clientRef && it.clientRef &&
                pl.clientRef.trim().toLowerCase() === it.clientRef.trim().toLowerCase(),
            );
            const match = byRef ?? parsed.lines[idx] ?? null;
            if (!match) return cur;
            return {
              ...cur,
              unitPrice: match.unitPrice ?? cur.unitPrice,
              moq: match.moq ?? cur.moq,
              availableStock: match.availableStock ?? cur.availableStock,
              leadTimeDays: match.leadTimeDays ?? cur.leadTimeDays,
              notes: cur.notes || (match.notes ?? ""),
            };
          }),
        );
      }
      ping("✓ Quote auto-filled — review and submit when ready");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Upload / extraction failed", true);
    } finally {
      setBusy(null);
    }
  }

  async function removeAttachment(attachmentId: number) {
    if (!confirm("Delete this attachment?")) return;
    try {
      await deleteVendorQuoteAttachment({ token, attachmentId });
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      ping(e instanceof Error ? e.message : "Delete failed", true);
    }
  }

  const totalAttachments = attachments.length;
  const totalValue = lineState.reduce((sum, l) => {
    const it = items.find((x) => x.id === l.rfqItemId);
    return sum + (it?.qty ?? 0) * (l.unitPrice ?? 0);
  }, 0) + (Number(shippingCost) || 0);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        padding: "32px 20px 64px",
      }}
    >
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            padding: "12px 18px",
            borderRadius: 10,
            background: toast.err ? "#dc2626" : "#16a34a",
            color: "var(--lb-text)",
            fontSize: 13.5,
            fontWeight: 600,
            zIndex: 80,
            boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
          }}
        >
          {toast.msg}
        </div>
      )}

      <div style={{ maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        {supplierHomeToken && (
          <a
            href={`/vendor/home/${supplierHomeToken}`}
            style={{
              alignSelf: "flex-start",
              padding: "6px 12px",
              borderRadius: 999,
              background: "transparent",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              fontSize: 12,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ← My RFQs dashboard
          </a>
        )}
        {/* Header */}
        <header
          style={{
            padding: 22,
            borderRadius: 14,
            background: "linear-gradient(135deg, rgba(234,88,12,0.12), rgba(8,145,178,0.08))",
            border: "1px solid var(--lb-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
                {clientName} · Vendor Portal
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 4px", color: "var(--lb-text)" }}>
                Request for Quotation {rfq.rfqNumber}
              </h1>
              <div style={{ fontSize: 13, color: "var(--lb-text-2)" }}>
                Project <b>{rfq.projectName ?? rfq.projectNum}</b> · {rfq.niche ?? "—"}
                {rfq.quoteDeadline && (
                  <>
                    {" "}· deadline <b>{new Date(rfq.quoteDeadline).toLocaleDateString()}</b>
                  </>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 6 }}>
                Transport preference: {TRANSPORT_MODE_META[rfq.transportMode].icon} {TRANSPORT_MODE_META[rfq.transportMode].label} · Target currency: {rfq.targetCurrency} · Incoterms: {rfq.incoterms ?? "open"}
              </div>
              {/* Always-available "view RFQ as PDF" — opens the source PDF
                  if the buyer uploaded one, otherwise the platform-generated
                  print view. Token gates access on the target route. */}
              <div style={{ marginTop: 10 }}>
                <a
                  href={`/suppliers/rfq/${rfq.id}?token=${encodeURIComponent(token)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: 999,
                    background: "var(--lb-bg-elev)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    fontSize: 12,
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  📄 View RFQ as PDF
                </a>
              </div>
            </div>
            {isLocked ? (
              <div style={{ padding: "8px 14px", borderRadius: 999, background: "rgba(22,163,74,0.18)", color: "#16a34a", fontWeight: 800, fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase" }}>
                ✓ Submitted — locked
              </div>
            ) : (
              <div style={{ padding: "8px 14px", borderRadius: 999, background: "rgba(202,138,4,0.2)", color: "#facc15", fontWeight: 800, fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase" }}>
                Draft
              </div>
            )}
          </div>
          {rfq.notes && (
            <p style={{ marginTop: 12, fontSize: 12.5, color: "var(--lb-text-2)" }}>{rfq.notes}</p>
          )}
        </header>

        {/* Auto-fill from existing quote PDF or Excel */}
        <Section
          title="Already have a quote? Auto-fill from PDF / Excel"
          subtitle="We'll read your quotation and pre-fill every field below — you just review and submit."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <label
              style={{
                ...btnPrimary,
                cursor: isLocked || busy !== null ? "wait" : "pointer",
                opacity: isLocked || busy !== null ? 0.6 : 1,
              }}
            >
              {busy === "upload"
                ? "Reading file… (~10-30s)"
                : sourcePdfName
                  ? "Replace file"
                  : "⚡ Upload quote PDF / Excel"}
              <input
                type="file"
                accept=".pdf,.xlsx,.xls,.csv,application/pdf"
                style={{ display: "none" }}
                disabled={isLocked || busy !== null}
                onChange={(e) => handleSourceFile(e.target.files)}
              />
            </label>
            {sourcePdfName && (
              <a href={sourcePdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lb-accent)", fontSize: 13 }}>
                📎 {sourcePdfName}
              </a>
            )}
          </div>
        </Section>

        {/* Company / contact */}
        <Section title="Your company">
          <div style={grid(3)}>
            <Field label="Company name *">
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Contact name">
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Contact email">
              <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Phone">
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Address">
              <input value={address} onChange={(e) => setAddress(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Country of origin">
              <input value={countryOfOrigin} onChange={(e) => setCountryOfOrigin(e.target.value)} disabled={isLocked} placeholder="e.g. China" style={input} />
            </Field>
          </div>
        </Section>

        <Section title="Manufacturer & commercial terms">
          <div style={grid(3)}>
            <Field label="Manufacturer name">
              <input value={manufacturerName} onChange={(e) => setManufacturerName(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Manufacturer part number">
              <input value={manufacturerPartNumber} onChange={(e) => setManufacturerPartNumber(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Currency">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={isLocked} style={input}>
                {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Incoterms">
              <IncotermSelect
                value={incoterms}
                onChange={setIncoterms}
                disabled={isLocked}
                allowEmpty
              />
            </Field>
            <Field label="Transport mode">
              <select value={transportMode} onChange={(e) => setTransportMode(e.target.value as typeof transportMode)} disabled={isLocked} style={input}>
                {TRANSPORT_MODE_ORDER.map((m) => (
                  <option key={m} value={m}>{TRANSPORT_MODE_META[m].icon} {TRANSPORT_MODE_META[m].label}</option>
                ))}
              </select>
            </Field>
            <Field label="Shipping / freight cost (total)">
              <input type="number" step="0.01" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Standard lead time (days)">
              <input type="number" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} disabled={isLocked} style={input} />
            </Field>
            <Field label="Quote validity (until)">
              <input type="date" value={validityUntil} onChange={(e) => setValidityUntil(e.target.value)} disabled={isLocked} style={input} />
            </Field>
          </div>
        </Section>

        {/* Per-line pricing */}
        <Section title={`Line items (${items.length})`}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Item</Th>
                  <Th style={{ textAlign: "right" }}>RFQ qty</Th>
                  <Th style={{ textAlign: "right" }}>Unit price ({currency}) *</Th>
                  <Th style={{ textAlign: "right" }}>MOQ</Th>
                  <Th style={{ textAlign: "right" }}>Available stock</Th>
                  <Th style={{ textAlign: "right" }}>Lead time (d)</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const l = lineState[idx];
                  return (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--lb-border)" }}>
                      <Td>{it.lineNo}</Td>
                      <Td>
                        <div style={{ fontWeight: 700 }}>{it.description}</div>
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                          {it.clientRef && <>ref {it.clientRef} · </>}
                          {it.productCode && <>code {it.productCode}</>}
                        </div>
                      </Td>
                      <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{it.qty}</Td>
                      <Td style={{ textAlign: "right" }}>
                        <input
                          type="number"
                          step="0.0001"
                          value={l.unitPrice}
                          onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value) })}
                          disabled={isLocked}
                          style={{ ...input, width: 110, textAlign: "right" }}
                        />
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <input
                          type="number"
                          min={1}
                          value={l.moq}
                          onChange={(e) => updateLine(idx, { moq: Number(e.target.value) })}
                          disabled={isLocked}
                          style={{ ...input, width: 80, textAlign: "right" }}
                        />
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <input
                          type="number"
                          value={l.availableStock ?? ""}
                          onChange={(e) => updateLine(idx, { availableStock: e.target.value === "" ? null : Number(e.target.value) })}
                          disabled={isLocked}
                          placeholder="—"
                          style={{ ...input, width: 90, textAlign: "right" }}
                        />
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <input
                          type="number"
                          value={l.leadTimeDays ?? ""}
                          onChange={(e) => updateLine(idx, { leadTimeDays: e.target.value === "" ? null : Number(e.target.value) })}
                          disabled={isLocked}
                          placeholder="—"
                          style={{ ...input, width: 80, textAlign: "right" }}
                        />
                      </Td>
                      <Td>
                        <input
                          value={l.notes}
                          onChange={(e) => updateLine(idx, { notes: e.target.value })}
                          disabled={isLocked}
                          style={input}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7} style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700, color: "var(--lb-text-2)" }}>
                    Estimated total (incl. shipping)
                  </td>
                  <td style={{ padding: "10px 6px", textAlign: "right", fontWeight: 800, color: "var(--lb-text)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtMoney(totalValue, currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>

        {/* Supporting docs */}
        <Section title={`Supporting documents (${totalAttachments})`} subtitle="Datasheets, certifications, brochures, and product photos.">
          {!quote ? (
            <Hint>Save the quote first, then come back to upload supporting files.</Hint>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ATT_KINDS.map((k) => (
                  <label key={k.key} style={{ ...btnGhost, cursor: isLocked ? "not-allowed" : "pointer" }}>
                    {k.icon} {k.label}
                    <input type="file" multiple style={{ display: "none" }} disabled={isLocked || busy !== null} onChange={(e) => { handleUpload(e.target.files, k.key); e.currentTarget.value = ""; }} />
                  </label>
                ))}
              </div>
              {attachments.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
                  {attachments.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--lb-bg)", border: "1px solid var(--lb-border)", borderRadius: 8 }}>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", flex: 1, fontSize: 13 }}>
                        {ATT_KINDS.find((k) => k.key === a.kind)?.icon ?? "📎"} {a.name}
                      </a>
                      <span style={{ fontSize: 10, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{a.kind}</span>
                      {!isLocked && (
                        <button type="button" onClick={() => removeAttachment(a.id)} style={miniBtn("#dc2626")}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Section>

        {/* Notes */}
        <Section title="Additional notes / status update">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isLocked}
            placeholder="Anything Lightbase should know: production stage, alternate offers, payment terms, etc."
            rows={4}
            style={{ ...input, fontFamily: "inherit", resize: "vertical" }}
          />
        </Section>

        {/* Save / submit / decline */}
        {!isLocked && !isDeclined && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleDecline}
              disabled={busy !== null}
              style={{
                ...btnGhost,
                color: "#dc2626",
                borderColor: "rgba(220,38,38,0.4)",
              }}
              title="Tell the buyer you can't quote this one"
            >
              ✕ Decline this RFQ
            </button>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => save(false)} disabled={busy !== null} style={btnGhost}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </button>
              <button type="button" onClick={() => save(true)} disabled={busy !== null || !companyName.trim()} style={btnPrimary}>
                {busy === "submit" ? "Submitting…" : "Submit quote"}
              </button>
            </div>
          </div>
        )}
        {isDeclined && (
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "rgba(220,38,38,0.10)",
              border: "1px solid rgba(220,38,38,0.45)",
              fontSize: 13,
              color: "var(--lb-text)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#dc2626", fontWeight: 800 }}>✕ Declined</span>
            <span style={{ flex: 1 }}>
              You declined this RFQ
              {recipient.respondedAt
                ? ` on ${new Date(recipient.respondedAt).toLocaleString()}`
                : ""}
              . {clientName} has been notified.
              {quote?.notes && (
                <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "var(--lb-text-2)" }}>
                  Reason: <i>{quote.notes.replace(/^Declined:\s*/, "")}</i>
                </span>
              )}
            </span>
          </div>
        )}
        {isLocked && quote && (
          <div style={{ padding: 14, borderRadius: 10, background: "rgba(22,163,74,0.12)", border: "1px solid rgba(22,163,74,0.4)", fontSize: 13, color: "#86efac", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <span style={{ flex: 1 }}>
              Your quote was submitted on {quote.submittedAt ? new Date(quote.submittedAt).toLocaleString() : "—"}. {clientName} will reach out if you're awarded the PO.
            </span>
            {quote.sourcePdfUrl && (
              <a
                href={quote.sourcePdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text)",
                  textDecoration: "none",
                  fontWeight: 700,
                  fontSize: 12.5,
                }}
              >
                📄 Download your uploaded PDF
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// shared styles (kept local to keep the public portal independent of the
// internal `--lb-*` token system)
// ─────────────────────────────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 13,
  outline: "none",
};

const btnPrimary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "9px 16px",
  borderRadius: 999,
  background: "#ea580c",
  color: "var(--lb-text)",
  border: "1px solid #ea580c",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const btnGhost: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 999,
  background: "transparent",
  color: "var(--lb-text-2)",
  border: "1px solid var(--lb-border)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

function miniBtn(color: string): React.CSSProperties {
  return {
    padding: "3px 9px",
    borderRadius: 6,
    background: `${color}1f`,
    color,
    border: `1px solid ${color}55`,
    fontSize: 10.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 18, borderRadius: 12, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--lb-text)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--lb-text-3)" }}>{label}</span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: 11.5, color: "var(--lb-text-3)" }}>{children}</p>;
}

function grid(n: number): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gap: 10 };
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ textAlign: "left", padding: "8px 6px", fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--lb-text-3)", borderBottom: "1px solid var(--lb-border)", ...style }}>{children}</th>;
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "8px 6px", verticalAlign: "middle", ...style }}>{children}</td>;
}
