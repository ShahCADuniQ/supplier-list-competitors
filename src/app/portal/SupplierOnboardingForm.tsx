"use client";

// Supplier onboarding STEP 2 — the compliance checklist.
//
// The shop-side data (company name, contact, capability, products,
// manufacturing types, materials, country) was collected in STEP 1 of
// the wizard at /onboarding. We show those values as a tidy read-only
// summary by default so step 2 stays focused on compliance, but until
// the supplier hits submit on step 2 their step-1 facts AND their
// engineering-company choice are still editable: clicking "Edit" on
// the summary card swaps it for an inline editor backed by the
// updateSupplierShopInfo server action. Once status flips to
// 'submitted' the row locks (the supplier has to ask the reviewer to
// send it back if they need changes after that).
//
// Auto-save: every change to answers or notes is debounce-saved to the
// supplier's onboarding_draft column, so a supplier can sign out
// mid-flow and resume later without losing progress.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addSupplierOnboardingAttachment,
  deleteSupplierOnboardingAttachment,
  deleteSupplierOnboardingCustomSection,
  saveSupplierOnboardingDraft,
  submitSupplierOnboarding,
  updateSupplierShopInfo,
  type OnboardingAttachmentRow,
} from "@/app/suppliers/onboarding-actions";
import { SUPPLIER_CATEGORIES } from "@/app/suppliers/supplier-inventory-constants";
import {
  SUPPLIER_ATTACHMENT_CATEGORIES,
  CUSTOM_SECTION_META,
  customCatLabel,
  customCatSlug,
  listCustomSectionIds,
} from "@/app/suppliers/supplier-attachment-categories";
import FileViewerModal, { forceDownloadFile } from "@/components/FileViewerModal";

// Slug-safe filename for the Vercel Blob pathname.
function safeBlobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
}

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Compliance questions for selling lighting products into Canada. The
// list is intentionally focused on what's legally required to ship +
// what a buyer needs to evaluate fitness for a Canadian lighting
// program. Critical items must be answered "Yes" or "N/A"; the submit
// button stays disabled until every critical item has an answer.
//
// "Critical" = required to legally sell the product in Canada or to
// underwrite a PO (insurance). "Non-critical" = nice-to-have due
// diligence the buyer uses to break ties between suppliers.
const UNIVERSAL_QUESTIONS: Array<{ id: string; text: string; ref: string; critical: boolean }> = [
  { id: "u1", text: "Do you hold ISO 9001 certification or run an equivalent documented Quality Management System?", ref: "ISO 9001:2015", critical: true },
  { id: "u2", text: "Can you supply products with a valid cUL, CSA or ETL-c (Intertek) electrical safety listing for the Canadian market?", ref: "CSA C22.2 No. 250 series · cUL · ETL-Canada", critical: true },
  { id: "u3", text: "Are your electronic products compliant with ISED ICES-003 (Class A or Class B EMC)?", ref: "ISED ICES-003", critical: true },
  { id: "u4", text: "Can you provide product datasheets and Safety Data Sheets in BOTH English and French (Quebec Bill 96)?", ref: "Quebec Charter of French Language · CPLA", critical: true },
  { id: "u5", text: "Can you provide RoHS, REACH and Health Canada CCPSA declarations for the parts you supply?", ref: "RoHS 3 · REACH · CCPSA", critical: true },
  { id: "u6", text: "Can you supply CBSA-compliant HS classification codes and country-of-origin marking on every product?", ref: "CBSA D11-3-1", critical: true },
  { id: "u7", text: "Do your lamps / luminaires meet NRCan Energy Efficiency Regulations and minimum efficacy requirements for the Canadian market?", ref: "NRCan EER 2016 · CSA C654 / C862", critical: true },
  { id: "u8", text: "Do you carry Product Liability insurance of at least CAD 2,000,000 per occurrence?", ref: "Certificate of Insurance required at PO", critical: true },
  { id: "u9", text: "Can you provide LM-79 photometric test reports (lumen output, CCT, CRI, distribution) from an accredited lab?", ref: "IES LM-79-19 · NVLAP / A2LA-accredited lab", critical: false },
  { id: "u10", text: "Can you provide LM-80 / TM-21 LED lifetime + lumen-maintenance data for the packages you use?", ref: "IES LM-80-20 · TM-21-21", critical: false },
  { id: "u11", text: "Are your higher-power LED products evaluated for photobiological safety (eye safety / blue-light hazard)?", ref: "IEC 62471 · CIE S 009", critical: false },
  { id: "u12", text: "Are your products DLC-qualified, or could they be submitted to the DesignLights Consortium for utility-rebate eligibility?", ref: "DLC Technical Requirements V5+", critical: false },
];

const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--lb-text-3)",
  marginBottom: 4,
};
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 14,
  border: "1px solid var(--lb-border)",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  outline: "none",
};
const PANEL_STYLE: React.CSSProperties = {
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};
const H2_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "var(--lb-accent)",
  marginBottom: 14,
  paddingBottom: 8,
  borderBottom: "1px solid var(--lb-border)",
};

// Prefill kept narrow on purpose: only the fields step 2 actually
// renders (the compliance answers + free-text notes). Everything else
// the supplier filled in at step 1 lives on the suppliers row and is
// rendered as read-only via the `shopSummary` prop.
export type OnboardingPrefill = {
  answers?: Record<string, "yes" | "no" | "na">;
  notes?: string;
};

// Subset of the suppliers row that step 2 displays in its summary
// card. Passed by /portal/page.tsx; the engineer reviewing the
// submission sees the same data from their admin panel. When the
// supplier opens the inline editor, every field except `email` becomes
// editable; the engineering company they applied to is also editable
// via `invitingClientName` + the engineering-email input.
export type ShopSummary = {
  companyName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  subCategory: string | null;
  origin: string | null;
  products: string | null;
  manufacturingTypes: string[];
  materials: string[];
  // Buy-and-sell distributor flag. When true the summary card shows a
  // "Buy & sell only" badge in place of the manufacturing / materials
  // tag rows, and the editor pre-ticks the same checkbox the step-1
  // wizard offered.
  isDistributor: boolean;
  // Name of the engineering company / client tenant the supplier
  // submitted to in step 1 (looked up via clientId on /portal/page.tsx).
  // Shown in the summary so the supplier sees who they applied to;
  // editable by entering a different engineering-company email.
  invitingClientName: string | null;
};

export default function SupplierOnboardingForm({
  supplierId,
  supplierName,
  prefill,
  rejectionReason,
  clientName,
  shopSummary,
  existingAttachments = [],
}: {
  supplierId: number;
  supplierName: string;
  prefill?: OnboardingPrefill;
  rejectionReason?: string | null;
  clientName: string;
  shopSummary: ShopSummary;
  // Files the supplier already uploaded during this onboarding session.
  // Grouped by catId in the rendered UI; the per-row Delete button posts
  // to deleteSupplierOnboardingAttachment.
  existingAttachments?: OnboardingAttachmentRow[];
}) {
  const [notes, setNotes] = useState(prefill?.notes ?? "");
  const [answers, setAnswers] = useState<Record<string, "yes" | "no" | "na">>(
    prefill?.answers ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Draft auto-save. Every change to answers/notes is debounce-written
  // to suppliers.onboarding_draft so the supplier can sign out
  // mid-checklist and resume later. We skip the first render so a
  // freshly-loaded prefill doesn't immediately overwrite itself.
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const skipFirstSaveRef = useRef(true);
  useEffect(() => {
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      setDraftStatus("saving");
      saveSupplierOnboardingDraft({
        supplierId,
        formData: {
          answers,
          notes: notes.trim(),
        },
      })
        .then(() => setDraftStatus("saved"))
        .catch(() => setDraftStatus("error"));
    }, 1200);
    return () => window.clearTimeout(t);
  }, [supplierId, answers, notes]);

  // Track only whether every critical question has been answered. We
  // deliberately don't compute a public score or "qualified / not
  // qualified" verdict here — that's a decision the reviewer makes when
  // they evaluate the submission, not something the supplier should see
  // pre-rendered. Submission stays gated on critical-answered so the
  // reviewer never gets a half-filled form.
  const allCriticalAnswered = useMemo(
    () =>
      UNIVERSAL_QUESTIONS.filter((q) => q.critical).every(
        (q) => answers[q.id] !== undefined,
      ),
    [answers],
  );

  async function submit() {
    setErr(null);
    if (!allCriticalAnswered) {
      setErr("Please answer every starred (critical) question before submitting.");
      return;
    }
    setBusy(true);
    try {
      await submitSupplierOnboarding({
        supplierId,
        formData: {
          answers,
          notes: notes.trim(),
        },
        // No score/verdict sent: the reviewer evaluates on the answers
        // themselves. Keeping these fields optional on the server lets
        // older clients still work without renaming the action.
      });
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submission failed");
      setBusy(false);
    }
  }

  function setAnswer(qid: string, v: "yes" | "no" | "na") {
    setAnswers((s) => ({ ...s, [qid]: v }));
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* Intro / status banner */}
      <header
        style={{
          padding: 22,
          borderRadius: 14,
          background:
            "linear-gradient(135deg, rgba(234,88,12,0.12), rgba(8,145,178,0.08))",
          border: "1px solid var(--lb-border)",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          Supplier Onboarding · Step 2 of 2
        </div>
        <h1
          style={{
            fontSize: "clamp(22px, 2.6vw, 28px)",
            fontWeight: 800,
            margin: "6px 0 4px",
            letterSpacing: "-0.02em",
          }}
        >
          Compliance checklist
        </h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--lb-text-2)",
            marginTop: 8,
            maxWidth: 760,
          }}
        >
          You already told us about your shop. This second screen asks only the
          regulatory and certification questions {clientName} needs to review.
          Once you submit, {clientName} usually responds within one business
          day.
        </p>
      </header>

      {rejectionReason && (
        <div
          style={{
            padding: 14,
            background: "rgba(179, 38, 30, 0.1)",
            border: "1px solid rgba(179, 38, 30, 0.4)",
            borderRadius: 10,
            marginBottom: 16,
            color: "#dc2626",
            fontSize: 13.5,
          }}
        >
          <strong>Your previous submission was sent back for changes.</strong>
          <div style={{ marginTop: 6, color: "var(--lb-text-2)", whiteSpace: "pre-wrap" }}>
            {rejectionReason}
          </div>
          <div style={{ marginTop: 6 }}>Please address the items above and resubmit.</div>
        </div>
      )}

      {/* SHOP SUMMARY — strictly read-only. Mirror of what step 1 saved on the suppliers row. */}
      <ShopSummaryCard
        supplierId={supplierId}
        supplierName={supplierName}
        summary={shopSummary}
      />

      {/* CHECKLIST */}
      <section style={PANEL_STYLE}>
        <h2 style={H2_STYLE}>1 · Compliance checklist (Canadian market)</h2>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--lb-text-3)",
            marginTop: -8,
            marginBottom: 14,
          }}
        >
          ★ Starred items are <strong>critical knock-outs</strong> — any &ldquo;No&rdquo; disqualifies. Other items affect your overall score.
        </p>
        <div>
          {UNIVERSAL_QUESTIONS.map((q) => (
            <div
              key={q.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 14,
                padding: "12px 0",
                borderBottom: "1px solid var(--lb-border)",
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 13.5, color: "var(--lb-text)" }}>
                {q.critical && (
                  <span style={{ color: "var(--lb-accent)", marginRight: 6 }}>★</span>
                )}
                {q.text}
                <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
                  {q.ref}
                </div>
              </div>
              <YesNoNa value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
            </div>
          ))}
        </div>
      </section>

      {/* ATTACHMENTS */}
      <section style={PANEL_STYLE}>
        <h2 style={H2_STYLE}>2 · Supporting documents (optional)</h2>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--lb-text-3)",
            marginTop: -8,
            marginBottom: 14,
          }}
        >
          Upload datasheets, certifications, sample quotes, or anything else
          that helps the reviewer understand your shop. Files attach to your
          supplier profile and appear under the matching category whenever{" "}
          {clientName} opens it.
        </p>
        <OnboardingAttachments
          supplierId={supplierId}
          initial={existingAttachments}
        />
      </section>

      {/* NOTES */}
      <section style={PANEL_STYLE}>
        <h2 style={H2_STYLE}>3 · Anything else?</h2>
        <Field label={`Notes for ${clientName}'s reviewer`}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Certifications you'd like to highlight, references, context that helps the reviewer evaluate you…"
            style={{ ...INPUT_STYLE, minHeight: 90, resize: "vertical" }}
          />
        </Field>
      </section>

      {/* SUBMIT */}
      <section
        style={{
          ...PANEL_STYLE,
          position: "sticky",
          bottom: 16,
          borderLeft: "6px solid var(--lb-accent)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            {/* Simple status line. No "Pre-qualified / Not qualified"
                verdict is rendered here — the supplier shouldn't be
                pre-judged by the form; the reviewer makes that call
                when they read the submission. */}
            <div style={{ fontSize: 13.5, color: "var(--lb-text-2)" }}>
              {allCriticalAnswered
                ? `You can submit your application. ${clientName} will review and respond.`
                : "Answer every starred (critical) question to enable submit."}
            </div>
            {err && (
              <div style={{ color: "#dc2626", fontSize: 12.5, marginTop: 6 }}>{err}</div>
            )}
            <div
              aria-live="polite"
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                marginTop: 6,
                color:
                  draftStatus === "error"
                    ? "#dc2626"
                    : draftStatus === "saving"
                      ? "var(--lb-text-3)"
                      : draftStatus === "saved"
                        ? "#059669"
                        : "var(--lb-text-3)",
              }}
            >
              {draftStatus === "saving" && "Saving draft…"}
              {draftStatus === "saved" && "✓ Draft saved. Safe to leave and finish later."}
              {draftStatus === "error" && "Couldn't save draft. Check your connection."}
              {draftStatus === "idle" && "Your answers save automatically as you type."}
            </div>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !allCriticalAnswered}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 999,
              border: "1px solid var(--lb-accent)",
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              cursor: busy ? "wait" : "pointer",
              opacity: busy || !allCriticalAnswered ? 0.6 : 1,
            }}
          >
            {busy ? "Submitting…" : `Submit to ${clientName}`}
          </button>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step-1 facts shown by default as a read-only summary card so step 2
// stays focused on compliance. Until the supplier hits submit on step 2,
// every field stays editable: clicking "Edit" swaps the card for an
// inline form that posts to updateSupplierShopInfo. Once status flips
// to 'submitted' the row is locked and we don't render the Edit button.
// ─────────────────────────────────────────────────────────────────────

function ShopSummaryCard({
  supplierId,
  supplierName,
  summary,
}: {
  supplierId: number;
  supplierName: string;
  summary: ShopSummary;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ShopSummaryEditor
        supplierId={supplierId}
        summary={summary}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          // updateSupplierShopInfo already revalidates /portal, but the
          // current client-side state still holds the old prefill prop.
          // A full reload picks up the new values from the freshly
          // revalidated server component above.
          window.location.reload();
        }}
      />
    );
  }

  const rows: { label: string; value: string | null }[] = [
    { label: "Company", value: summary.companyName || supplierName },
    { label: "Primary contact", value: summary.contactName },
    { label: "Email", value: summary.email },
    { label: "Phone", value: summary.phone },
    { label: "Website", value: summary.website },
    { label: "Country", value: summary.origin },
    { label: "Primary capability", value: summary.category },
    { label: "Sub-category", value: summary.subCategory },
    { label: "Submitting to", value: summary.invitingClientName },
  ];

  return (
    <section
      style={{
        ...PANEL_STYLE,
        background: "var(--lb-bg)",
        borderLeft: "4px solid var(--lb-text-3)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: "1px solid var(--lb-border)",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--lb-text-2)",
            margin: 0,
          }}
        >
          Your shop · from step 1
        </h2>
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.4,
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-2)",
            cursor: "pointer",
          }}
        >
          Edit
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
        }}
      >
        {rows
          .filter((r) => r.value && r.value.trim())
          .map((r) => (
            <div key={r.label}>
              <div style={FIELD_LABEL}>{r.label}</div>
              <div style={{ fontSize: 14, color: "var(--lb-text)" }}>{r.value}</div>
            </div>
          ))}
      </div>

      {/* Buy & sell only: replace the manufacturing/materials tag rows
          with a single explicit badge so the reviewer reads it as a
          deliberate signal, not an empty-form omission. */}
      {summary.isDistributor ? (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "color-mix(in srgb, var(--lb-accent) 12%, transparent)",
            color: "var(--lb-accent)",
            border: "1px solid var(--lb-border)",
            fontSize: 12.5,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          <span aria-hidden>↻</span>
          Buy &amp; sell only · no in-house manufacturing
        </div>
      ) : (
        (summary.manufacturingTypes.length > 0 ||
          summary.materials.length > 0 ||
          (summary.products && summary.products.trim())) && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {summary.manufacturingTypes.length > 0 && (
              <TagRow label="Manufacturing capabilities" items={summary.manufacturingTypes} />
            )}
            {summary.materials.length > 0 && (
              <TagRow label="Materials" items={summary.materials} />
            )}
            {summary.products && summary.products.trim() && (
              <div>
                <div style={FIELD_LABEL}>Products / services</div>
                <div
                  style={{
                    fontSize: 13.5,
                    color: "var(--lb-text)",
                    whiteSpace: "pre-wrap",
                    marginTop: 2,
                  }}
                >
                  {summary.products}
                </div>
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inline editor for step-1 facts. Reachable from the Edit button on the
// summary card while status is 'pending' or 'rejected'. Persists via
// updateSupplierShopInfo; supports retargeting to a different
// engineering company via an opt-in "change" toggle so a casual save
// doesn't accidentally re-validate (and possibly fail) the email.
// ─────────────────────────────────────────────────────────────────────

function ShopSummaryEditor({
  supplierId,
  summary,
  onCancel,
  onSaved,
}: {
  supplierId: number;
  summary: ShopSummary;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [companyName, setCompanyName] = useState(summary.companyName);
  const [contactName, setContactName] = useState(summary.contactName ?? "");
  const [phone, setPhone] = useState(summary.phone ?? "");
  const [website, setWebsite] = useState(summary.website ?? "");
  const [origin, setOrigin] = useState(summary.origin ?? "");
  const [category, setCategory] = useState(summary.category ?? "");
  const [subCategory, setSubCategory] = useState(summary.subCategory ?? "");
  const [products, setProducts] = useState(summary.products ?? "");
  // Manufacturing capabilities, materials, and the buy-&-sell flag are
  // not editable from this step-2 form anymore — see the comment in
  // save() below. The values still sit on the supplier row from step 1
  // and update via the regular portal post-approval.

  // Retargeting the engineering company is opt-in. Default off so a
  // routine save doesn't have to re-validate the email match.
  const [changeEngineering, setChangeEngineering] = useState(false);
  const [engineeringEmail, setEngineeringEmail] = useState("");

  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function save() {
    if (pending) return;
    setErr(null);
    if (!companyName.trim()) {
      setErr("Company name is required");
      return;
    }
    if (changeEngineering && !engineeringEmail.trim()) {
      setErr("Enter the new Engineering/Designer Company's email or cancel the change.");
      return;
    }
    startTransition(async () => {
      try {
        // Step 2 only edits the basics + the engineering-company link.
        // We deliberately don't send manufacturingTypes / materials /
        // isDistributor — those were captured at step 1 and the
        // supplier edits them later from their portal once approved.
        // Keeping them out of this payload also stops the editor from
        // accidentally clearing them when a supplier hits Save here.
        await updateSupplierShopInfo({
          supplierId,
          companyName,
          contactName: contactName || null,
          phone: phone || null,
          website: website || null,
          category: category || null,
          subCategory: subCategory || null,
          origin: origin || null,
          products: products || null,
          ...(changeEngineering
            ? { newEngineeringCompanyEmail: engineeringEmail }
            : {}),
        });
        onSaved();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't save changes");
      }
    });
  }

  return (
    <section
      style={{
        ...PANEL_STYLE,
        background: "var(--lb-bg)",
        borderLeft: "4px solid var(--lb-accent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
          paddingBottom: 8,
          borderBottom: "1px solid var(--lb-border)",
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--lb-accent)",
            margin: 0,
          }}
        >
          Edit your shop info
        </h2>
        <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontStyle: "italic" }}>
          unlocks until you submit step 2
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <Field label="Company name *">
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            style={INPUT_STYLE}
          />
        </Field>
        <Field label="Primary contact">
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            style={INPUT_STYLE}
            placeholder="Jane Smith, Sales Director"
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={INPUT_STYLE}
            placeholder="+1 …"
          />
        </Field>
        <Field label="Website">
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            style={INPUT_STYLE}
            placeholder="https://"
          />
        </Field>
        <Field label="Country of operation">
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            style={INPUT_STYLE}
            placeholder="Canada / United States / China …"
          />
        </Field>
        <Field label="Primary capability">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="">— select —</option>
            {SUPPLIER_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sub-category / specialty">
          <input
            value={subCategory}
            onChange={(e) => setSubCategory(e.target.value)}
            style={INPUT_STYLE}
            placeholder="e.g. aluminum extrusion, 0-10V drivers …"
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label="Products / services you offer">
          <textarea
            value={products}
            onChange={(e) => setProducts(e.target.value)}
            placeholder="One per line."
            style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
          />
        </Field>
      </div>

      {/* Manufacturing capabilities, materials, and the buy-&-sell flag
          are NOT re-asked here on step 2 — they were captured at step 1
          and the values stay editable from the supplier's portal once
          they're approved. Repeating them in step 2 just made the
          compliance review screen longer for no real input gain. The
          step-2 editor's submit still preserves whatever was already
          on the supplier row (see ShopSummaryEditor.save). */}

      {/* Engineering company retargeting */}
      <div
        style={{
          marginTop: 18,
          padding: 14,
          borderRadius: 10,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={FIELD_LABEL}>Currently submitting to</div>
            <div style={{ fontSize: 14, color: "var(--lb-text)", marginTop: 2 }}>
              {summary.invitingClientName ?? "(no Engineering/Designer Company linked)"}
            </div>
          </div>
          {!changeEngineering ? (
            <button
              type="button"
              onClick={() => setChangeEngineering(true)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text-2)",
                cursor: "pointer",
              }}
            >
              Change Engineering/Designer Company
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setChangeEngineering(false);
                setEngineeringEmail("");
              }}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text-2)",
                cursor: "pointer",
              }}
            >
              Keep current
            </button>
          )}
        </div>

        {changeEngineering && (
          <div style={{ marginTop: 10 }}>
            <Field label="New Engineering/Designer Company email *">
              <input
                type="email"
                value={engineeringEmail}
                onChange={(e) => setEngineeringEmail(e.target.value)}
                placeholder="e.g. contact@acmelighting.com"
                style={INPUT_STYLE}
              />
            </Field>
            <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: -6 }}>
              The new email must belong to an Engineering/Designer Company
              that already has a CADuniQ account. We&apos;ll re-validate
              the match before saving.
            </div>
          </div>
        )}
      </div>

      {err && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            background: "rgba(220,38,38,0.10)",
            border: "1px solid rgba(220,38,38,0.40)",
            color: "#dc2626",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          display: "flex",
          gap: 10,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-2)",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            borderRadius: 999,
            background: "var(--lb-accent)",
            border: "1px solid var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}

function TagRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div style={FIELD_LABEL}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {items.map((t) => (
          <span
            key={t}
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 12.5,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
            }}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Small Field wrapper + Yes/No/N/A pill group, used by the compliance
// list. Visual style matches the rest of the dashboard.
// ─────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={FIELD_LABEL}>{label}</div>
      {children}
    </label>
  );
}

function YesNoNa({
  value,
  onChange,
}: {
  value: "yes" | "no" | "na" | undefined;
  onChange: (v: "yes" | "no" | "na") => void;
}) {
  const options: { v: "yes" | "no" | "na"; label: string; on: string }[] = [
    { v: "yes", label: "Yes", on: "#16a34a" },
    { v: "no", label: "No", on: "#dc2626" },
    { v: "na", label: "N/A", on: "#64748b" },
  ];
  return (
    <div style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => {
        const selected = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              fontSize: 12.5,
              fontWeight: 700,
              border: `1px solid ${selected ? o.on : "var(--lb-border)"}`,
              background: selected ? o.on : "var(--lb-bg)",
              color: selected ? "#fff" : "var(--lb-text-2)",
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Categorised attachment uploader for the onboarding form. Mirrors the
// Lightbase admin's AttachmentsTab look but uses the supplier-self
// server actions (the canEdit-gated ones reject suppliers). Files land
// on Vercel Blob at suppliers/<id>/<catId>/<safeName> so the reviewer's
// AttachmentsTab picks them up under the matching category.
// ─────────────────────────────────────────────────────────────────────

function OnboardingAttachments({
  supplierId,
  initial,
}: {
  supplierId: number;
  initial: OnboardingAttachmentRow[];
}) {
  const [items, setItems] = useState<OnboardingAttachmentRow[]>(initial);
  const [busyCat, setBusyCat] = useState<string | null>(null);
  const [attErr, setAttErr] = useState<string | null>(null);
  // Section names the supplier just created but hasn't uploaded into yet.
  // Cleared once the first file with that catId lands.
  const [draftSections, setDraftSections] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState<OnboardingAttachmentRow | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  // Custom sections derived from the attachments themselves — every
  // non-canonical catId becomes its own section. Mirrors the same logic
  // the engineering admin's AttachmentsTab uses, so a section created
  // here shows up there automatically.
  const persistedCustomIds = useMemo(
    () => listCustomSectionIds(items.map((a) => a.catId)),
    [items],
  );

  const customCats = useMemo(() => {
    const seen = new Set<string>(persistedCustomIds);
    const out: { id: string; label: string; isDraft: boolean }[] = persistedCustomIds.map(
      (id) => ({ id, label: customCatLabel(id), isDraft: false }),
    );
    for (const d of draftSections) {
      const slug = customCatSlug(d);
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        out.push({ id: slug, label: d, isDraft: true });
      }
    }
    return out;
  }, [persistedCustomIds, draftSections]);

  useEffect(() => {
    if (draftSections.length === 0) return;
    const persistedSlugs = new Set(persistedCustomIds);
    const stillDrafts = draftSections.filter(
      (d) => !persistedSlugs.has(customCatSlug(d)),
    );
    if (stillDrafts.length !== draftSections.length) {
      setDraftSections(stillDrafts);
    }
  }, [persistedCustomIds, draftSections]);

  // Render order: 8 canonical sections (shared with the reviewer) then
  // custom sections (created by the supplier or the reviewer). The
  // `deletable` flag drives the per-section trash button so default
  // sections stay locked.
  const allCats = useMemo(() => [
    ...SUPPLIER_ATTACHMENT_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      color: c.color,
      desc: c.desc,
      deletable: false,
      isDraft: false,
    })),
    ...customCats.map((c) => ({
      id: c.id,
      label: c.label,
      icon: CUSTOM_SECTION_META.icon,
      color: CUSTOM_SECTION_META.color,
      desc: c.isDraft
        ? "Custom section (waiting for first upload)"
        : "Custom section",
      deletable: true,
      isDraft: c.isDraft,
    })),
  ], [customCats]);

  async function handleDeleteSection(catId: string, label: string, isDraft: boolean, fileCount: number) {
    if (isDraft) {
      setDraftSections((prev) =>
        prev.filter((d) => customCatSlug(d) !== catId),
      );
      return;
    }
    const msg = fileCount > 0
      ? `Delete the "${label}" section and the ${fileCount} file${fileCount === 1 ? "" : "s"} inside? This can't be undone.`
      : `Delete the "${label}" section?`;
    if (!window.confirm(msg)) return;
    setAttErr(null);
    try {
      await deleteSupplierOnboardingCustomSection({ supplierId, catId });
      setItems((prev) => prev.filter((a) => a.catId !== catId));
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Section delete failed");
    }
  }

  const byCat = useMemo(() => {
    const map: Record<string, OnboardingAttachmentRow[]> = {};
    for (const c of allCats) map[c.id] = [];
    for (const a of items) {
      if (map[a.catId]) map[a.catId].push(a);
      else map[a.catId] = [a];
    }
    return map;
  }, [items, allCats]);

  function addCustomSection() {
    const raw = window.prompt("Name this section (e.g. Warranty docs, Installation guides):");
    const name = (raw ?? "").trim();
    if (!name) return;
    if (name.length > 80) {
      setAttErr("Section names must be 80 characters or fewer.");
      return;
    }
    const slug = customCatSlug(name);
    if (!slug) return;
    if (customCats.some((c) => c.id === slug)) return;
    setDraftSections((prev) => [...prev, name]);
  }

  async function handleUpload(catId: string, files: FileList | File[]) {
    setAttErr(null);
    setBusyCat(catId);
    try {
      for (const f of Array.from(files)) {
        const pathname = `suppliers/${supplierId}/${catId}/${safeBlobName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        const res = await addSupplierOnboardingAttachment({
          supplierId,
          catId,
          name: f.name,
          size: f.size,
          mimeType: f.type || null,
          url: blob.url,
          blobPathname: blob.pathname,
        });
        setItems((prev) => [
          {
            id: res.id,
            catId,
            name: f.name,
            size: f.size,
            mimeType: f.type || null,
            url: blob.url,
            createdAt: new Date(),
            uploader: null,
          },
          ...prev,
        ]);
      }
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyCat(null);
    }
  }

  async function handleDelete(attachmentId: number, name: string) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    setAttErr(null);
    try {
      await deleteSupplierOnboardingAttachment({ supplierId, attachmentId });
      setItems((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      {attErr && (
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
          {attErr}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {allCats.map((cat) => {
          const list = byCat[cat.id] ?? [];
          const busy = busyCat === cat.id;
          return (
            <div
              key={cat.id}
              style={{
                borderRadius: 10,
                border: "1px solid var(--lb-border)",
                background: "var(--lb-bg)",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      display: "grid",
                      placeItems: "center",
                      background: `${cat.color}22`,
                      color: cat.color,
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {cat.icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: "var(--lb-text)",
                      }}
                    >
                      {cat.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--lb-text-3)",
                        marginTop: 1,
                      }}
                    >
                      {cat.desc}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: list.length > 0 ? `${cat.color}1a` : "var(--lb-bg-elev)",
                      color: list.length > 0 ? cat.color : "var(--lb-text-3)",
                      border: "1px solid var(--lb-border)",
                    }}
                  >
                    {list.length}
                  </span>
                  <label
                    style={{
                      padding: "5px 12px",
                      fontSize: 12,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: "var(--lb-bg-elev)",
                      border: "1px solid var(--lb-border)",
                      color: busy ? "var(--lb-text-3)" : "var(--lb-text)",
                      cursor: busy ? "wait" : "pointer",
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {busy ? "Uploading…" : "+ Add"}
                    <input
                      type="file"
                      multiple
                      disabled={busy}
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleUpload(cat.id, e.target.files);
                        }
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {cat.deletable && (
                    <button
                      type="button"
                      title="Delete section"
                      onClick={() =>
                        handleDeleteSection(cat.id, cat.label, cat.isDraft, list.length)
                      }
                      style={{
                        padding: "5px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        borderRadius: 999,
                        background: "var(--lb-bg-elev)",
                        border: "1px solid var(--lb-border)",
                        color: "#dc2626",
                        cursor: "pointer",
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>

              {list.length === 0 ? (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: "var(--lb-text-3)",
                    fontStyle: "italic",
                  }}
                >
                  No files in this category yet.
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "10px 0 0",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {list.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "var(--lb-bg-elev)",
                        border: "1px solid var(--lb-border)",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--lb-text)",
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={a.name}
                        >
                          {a.name}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 1 }}>
                          {fmtBytes(a.size)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {a.url && (
                          <>
                            <button
                              type="button"
                              onClick={() => setPreviewing(a)}
                              style={{
                                padding: "4px 10px",
                                fontSize: 12,
                                fontWeight: 600,
                                borderRadius: 999,
                                color: "var(--lb-text-2)",
                                background: "var(--lb-bg)",
                                border: "1px solid var(--lb-border)",
                                cursor: "pointer",
                              }}
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              disabled={downloadingId === a.id}
                              onClick={async () => {
                                setDownloadingId(a.id);
                                setAttErr(null);
                                try {
                                  await forceDownloadFile(a.url!, a.name);
                                } catch (e) {
                                  setAttErr(e instanceof Error ? e.message : "Download failed");
                                } finally {
                                  setDownloadingId(null);
                                }
                              }}
                              style={{
                                padding: "4px 10px",
                                fontSize: 12,
                                fontWeight: 600,
                                borderRadius: 999,
                                color: "var(--lb-text)",
                                background: "var(--lb-bg-elev)",
                                border: "1px solid var(--lb-border)",
                                cursor: downloadingId === a.id ? "wait" : "pointer",
                                opacity: downloadingId === a.id ? 0.6 : 1,
                              }}
                            >
                              {downloadingId === a.id ? "…" : "⬇ Download"}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(a.id, a.name)}
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            fontWeight: 600,
                            borderRadius: 999,
                            color: "#dc2626",
                            background: "var(--lb-bg)",
                            border: "1px solid var(--lb-border)",
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={addCustomSection}
          style={{
            marginTop: 4,
            padding: "10px 14px",
            fontSize: 12.5,
            fontWeight: 600,
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            background: "transparent",
            color: "var(--lb-text-2)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          + Add section
        </button>
      </div>

      {previewing && previewing.url && (
        <FileViewerModal
          url={previewing.url}
          name={previewing.name}
          mimeType={previewing.mimeType}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}
