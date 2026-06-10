"use client";

// Place an order direct from the supplier catalogue. Wraps createRfq +
// inviteSupplierBatchToRfq + sendInitialRfqDeliveries so a 1-line RFQ
// goes out with the same routing options as the full create flow, but
// with the product pre-filled.

import { useEffect, useMemo, useState } from "react";
import { createRfq, inviteSupplierBatchToRfq } from "./rfq-actions";
import {
  sendInitialRfqDeliveries,
  getEmailTransportStatus,
  previewRfqEmailBody,
} from "./rfq-email-actions";
import type { AggregateInventoryPart } from "./supplier-inventory-actions";
import AssemblyPicker from "./AssemblyPicker";

type Props = {
  open: boolean;
  product: AggregateInventoryPart | null;
  onClose: () => void;
  onSent: (msg: string) => void;
};

export default function PlaceOrderDialog({
  open,
  product,
  onClose,
  onSent,
}: Props) {
  const [projectNum, setProjectNum] = useState("");
  const [projectName, setProjectName] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [targetUnitPrice, setTargetUnitPrice] = useState<string>("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [transport, setTransport] = useState<{ configured: boolean } | null>(
    null,
  );
  // "For product / assembly" — which Lightbase assembly is this order
  // for? Optional; lets the team trace every part used to build a given
  // product.
  const [forInventoryItemId, setForInventoryItemId] = useState<number | null>(
    null,
  );
  // Email preview / edit. Open the panel to see the auto-generated body
  // procurement (or the supplier) will see; edit before sending.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSubject, setPreviewSubject] = useState("");
  const [previewBody, setPreviewBody] = useState("");
  const [previewEdited, setPreviewEdited] = useState(false);

  // Routing flags — same shape as the create-RFQ panel.
  const [deliverToSupplierEmail, setDeliverToSupplierEmail] = useState(true);
  const [deliverToSupplierPlatform, setDeliverToSupplierPlatform] =
    useState(true);
  const [procurementViaEmail, setProcurementViaEmail] = useState(false);
  const [procurementViaPlatform, setProcurementViaPlatform] = useState(false);
  const procurementPicked = procurementViaEmail || procurementViaPlatform;
  const supplierPicked = deliverToSupplierEmail || deliverToSupplierPlatform;
  useEffect(() => {
    if (procurementPicked && supplierPicked) {
      setDeliverToSupplierEmail(false);
      setDeliverToSupplierPlatform(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procurementPicked]);

  useEffect(() => {
    if (!open) return;
    getEmailTransportStatus()
      .then((s) => setTransport({ configured: s.configured }))
      .catch(() => setTransport({ configured: false }));
  }, [open]);

  const description = useMemo(() => {
    if (!product) return "";
    if (product.productCode && product.name && product.name !== product.productCode) {
      return `${product.name} (${product.productCode})`;
    }
    return product.name || product.productCode || "";
  }, [product]);

  // Build / refresh the preview body whenever inputs change AND the
  // user hasn't manually edited it yet. After the user types in the
  // preview area we stop overwriting their edits.
  useEffect(() => {
    if (!previewOpen || previewEdited) return;
    if (!product) return;
    setPreviewLoading(true);
    previewRfqEmailBody({
      projectNum: projectNum.trim() || "(your project)",
      projectName: projectName.trim() || undefined,
      toName: contactName.trim() || null,
      items: [
        {
          lineNo: 1,
          description,
          qty,
          productCode: product.productCode ?? null,
        },
      ],
      quoteDeadline: deliveryDate || null,
    })
      .then(({ subject, body }) => {
        setPreviewSubject(subject);
        setPreviewBody(body);
      })
      .catch(() => undefined)
      .finally(() => setPreviewLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewOpen,
    projectNum,
    projectName,
    qty,
    contactName,
    deliveryDate,
    description,
    product?.id,
  ]);

  if (!open || !product) return null;

  async function submit() {
    if (!product) return;
    setErr(null);
    if (!projectNum.trim()) {
      setErr("Project number is required.");
      return;
    }
    if (qty < 1) {
      setErr("Qty must be at least 1.");
      return;
    }
    if (supplierPicked && !contactEmail.trim()) {
      setErr("Add a contact email so we know where to send the RFQ.");
      return;
    }
    setBusy(true);
    try {
      // 1) Create a 1-line RFQ with the product linked to the catalogue.
      const created = await createRfq({
        projectNum: projectNum.trim(),
        projectName: projectName.trim() || undefined,
        niche: product.category ?? undefined,
        // Single-supplier order — RFQ is born already "committed" since
        // there's no comparison stage. The buyer picked the supplier by
        // clicking 🛒 Order on their catalogue card.
        stage: "committed",
        items: [
          {
            clientRef: undefined,
            productCode: product.productCode ?? undefined,
            description,
            qty,
            securityStock: 0,
            targetUnitPrice: targetUnitPrice ? Number(targetUnitPrice) : null,
            productUrl: product.productUrl ?? undefined,
            notes: notes.trim() || undefined,
            supplierProductId: product.id,
            forInventoryItemId,
          },
        ],
      });
      // 2) Invite the product's supplier as the recipient.
      const emails = contactEmail
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      let recipientIds: number[] = [];
      if (emails.length > 0) {
        const invite = await inviteSupplierBatchToRfq({
          rfqId: created.rfqId,
          supplierId: product.supplierId,
          contactName: contactName.trim() || undefined,
          emails,
        });
        recipientIds = invite.invites.map((i) => i.recipientId);
      }
      // 3) Dispatch the initial outreach per the chosen routing.
      let summary = "RFQ created";
      if (recipientIds.length > 0 && (supplierPicked || procurementPicked)) {
        const out = await sendInitialRfqDeliveries({
          rfqId: created.rfqId,
          recipientIds,
          deliverToSupplierEmail,
          deliverToSupplierPlatform,
          procurementViaEmail,
          procurementViaPlatform,
          includeAiSummary: false,
          // Pass the edited preview content when the user opened +
          // tweaked the panel. Otherwise null falls back to the
          // auto-generated body so the existing behaviour is preserved.
          subjectOverride: previewEdited ? previewSubject : null,
          bodyOverride: previewEdited ? previewBody : null,
        });
        if (out.sentCount > 0)
          summary += ` · sent ${out.sentCount} RFQ${out.sentCount === 1 ? "" : "s"}`;
        if (out.queuedCount > 0)
          summary += ` · ${out.queuedCount} queued for procurement`;
      }
      onSent(summary);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Order failed");
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
          width: "min(760px, 100%)",
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
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>
              🛒 Place order
            </h2>
            <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 4 }}>
              {description} · {product.supplierName}
            </div>
          </div>
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
            ⚠ Email transport not configured — outbound mail will go to the
            server console (in-app notifications still work).
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Project number *">
            <input
              value={projectNum}
              onChange={(e) => setProjectNum(e.target.value)}
              placeholder="e.g. PRJ-2026-014"
              style={input}
            />
          </Field>
          <Field label="Project name">
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Optional"
              style={input}
            />
          </Field>
          <Field label="Qty *">
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              style={input}
            />
          </Field>
          <Field label="Target unit price">
            <input
              type="number"
              step="0.01"
              value={targetUnitPrice}
              onChange={(e) => setTargetUnitPrice(e.target.value)}
              placeholder="Optional"
              style={input}
            />
          </Field>
          <Field label="Target delivery date">
            <input
              type="date"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              style={input}
            />
          </Field>
          <Field label="Contact name">
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Optional"
              style={input}
            />
          </Field>
          <div style={{ gridColumn: "span 2" }}>
            <Field label="Contact email(s) — comma- or space-separated">
              <input
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="sales@supplier.com"
                style={input}
              />
            </Field>
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <Field label="Notes for the supplier (optional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                style={{ ...input, minHeight: 60, resize: "vertical" }}
              />
            </Field>
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <AssemblyPicker
              value={forInventoryItemId}
              label="Used for product / assembly (optional)"
              hint="Tag which Lightbase assembly this order goes into. The link lets the team see every part / consumable ordered for a given product."
              onChange={(item) => setForInventoryItemId(item ? item.id : null)}
            />
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px dashed var(--lb-border)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
            }}
          >
            How should this RFQ be delivered?
          </div>
          <RoutingPair
            heading="To the supplier"
            picked={supplierPicked}
            otherPicked={procurementPicked}
            options={[
              {
                label: "Through the platform",
                checked: deliverToSupplierPlatform,
                onChange: setDeliverToSupplierPlatform,
              },
              {
                label: `By email to ${contactEmail || "the supplier contact"}`,
                checked: deliverToSupplierEmail,
                onChange: setDeliverToSupplierEmail,
              },
            ]}
          />
          <RoutingPair
            heading="Route through procurement"
            picked={procurementPicked}
            otherPicked={supplierPicked}
            options={[
              {
                label: "Notify procurement through the platform",
                checked: procurementViaPlatform,
                onChange: setProcurementViaPlatform,
              },
              {
                label: "Notify procurement by email",
                checked: procurementViaEmail,
                onChange: setProcurementViaEmail,
              },
            ]}
          />
        </div>

        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px dashed var(--lb-border)",
          }}
        >
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            style={{
              padding: "6px 12px",
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              border: "1px solid var(--lb-border)",
              background: previewOpen
                ? "color-mix(in srgb, var(--lb-accent) 10%, var(--lb-bg))"
                : "var(--lb-bg)",
              color: "var(--lb-text-2)",
              cursor: "pointer",
            }}
          >
            📄 {previewOpen ? "Hide preview" : "Preview & edit email"}
          </button>
          {previewOpen && (
            <div
              style={{
                marginTop: 10,
                padding: 12,
                borderRadius: 10,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "var(--lb-text-3)",
                }}
              >
                {procurementPicked
                  ? "This is the email body Procurement will see in their review queue. Edit before sending."
                  : "This is the email body the supplier will receive. Edit before sending."}
                {previewLoading && " · rebuilding…"}
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
                  Subject
                </span>
                <input
                  value={previewSubject}
                  onChange={(e) => {
                    setPreviewSubject(e.target.value);
                    setPreviewEdited(true);
                  }}
                  style={input}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
                  Body
                </span>
                <textarea
                  value={previewBody}
                  onChange={(e) => {
                    setPreviewBody(e.target.value);
                    setPreviewEdited(true);
                  }}
                  style={{ ...input, minHeight: 180, fontFamily: "inherit", resize: "vertical" }}
                />
              </label>
              {previewEdited && (
                <button
                  type="button"
                  onClick={() => {
                    setPreviewEdited(false);
                    setPreviewSubject("");
                    setPreviewBody("");
                  }}
                  style={{
                    alignSelf: "flex-start",
                    padding: "4px 10px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    border: "1px solid var(--lb-border)",
                    background: "transparent",
                    color: "var(--lb-text-3)",
                    cursor: "pointer",
                  }}
                  title="Discard your edits and regenerate from form data"
                >
                  ↺ Reset to auto-generated
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onClose} style={miniBtn} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || (!supplierPicked && !procurementPicked)}
            style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
          >
            {busy
              ? "Submitting…"
              : procurementPicked
                ? "Submit for procurement review"
                : "Place order"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoutingPair({
  heading,
  picked,
  otherPicked,
  options,
}: {
  heading: string;
  picked: boolean;
  otherPicked: boolean;
  options: Array<{
    label: string;
    checked: boolean;
    onChange: (b: boolean) => void;
  }>;
}) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        background: otherPicked ? "transparent" : "var(--lb-bg)",
        border: otherPicked
          ? "1px dashed var(--lb-border)"
          : "1px solid var(--lb-border)",
        opacity: otherPicked ? 0.45 : 1,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
          marginBottom: 6,
        }}
      >
        {heading}
      </div>
      {options.map((o, i) => (
        <label
          key={i}
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 4 }}
        >
          <input
            type="checkbox"
            checked={o.checked}
            disabled={otherPicked}
            onChange={(e) => o.onChange(e.target.checked)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
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
