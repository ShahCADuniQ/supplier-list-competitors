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
import {
  addSupplierTaxonomyTerm,
  saveSupplierOnboardingDraft,
  submitSupplierOnboarding,
  updateSupplierShopInfo,
} from "@/app/suppliers/onboarding-actions";
import MultiSelect from "@/components/MultiSelect";
import {
  MANUFACTURING_TYPES,
  SUPPLIER_CATEGORIES,
  SUPPLIER_MATERIALS,
} from "@/app/suppliers/supplier-inventory-constants";

// Case-insensitive UNION of curated baseline + custom taxonomy entries.
function mergeOptions(base: readonly string[], extras: readonly string[]): string[] {
  const seen = new Set(base.map((s) => s.toLowerCase()));
  const out: string[] = [...base];
  for (const e of extras) {
    const k = e.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

// Universal knock-out + scoring questions, ported from the Canadian
// Quick-Check brief. Critical items must be answered "Yes" or "N/A" — a
// "No" disqualifies the submission.
const UNIVERSAL_QUESTIONS: Array<{ id: string; text: string; ref: string; critical: boolean }> = [
  { id: "u1", text: "Do you hold ISO 9001 certification or run an equivalent documented Quality Management System?", ref: "ISO 9001:2015", critical: true },
  { id: "u2", text: "Can you supply products with valid cUL, CSA or ETL-c (Intertek) listing for the Canadian market?", ref: "CSA C22.2 No. 250 series · cUL · ETL-Canada", critical: true },
  { id: "u3", text: "Are your electronic products compliant with ISED ICES-003 (Class A or Class B EMC)?", ref: "ISED ICES-003", critical: true },
  { id: "u4", text: "Can you provide product datasheets and Safety Data Sheets in BOTH English and French (Quebec Bill 96)?", ref: "Quebec Charter of French Language · CPLA", critical: true },
  { id: "u5", text: "Can your supply chain be disclosed under the Fighting Against Forced Labour and Child Labour in Supply Chains Act (Bill S-211)?", ref: "Bill S-211", critical: true },
  { id: "u6", text: "Can you provide RoHS, REACH and Health Canada CCPSA declarations for the parts you supply?", ref: "RoHS 3 · REACH · CCPSA", critical: true },
  { id: "u7", text: "Can you supply CBSA-compliant HS classification codes and country-of-origin marking on every product?", ref: "CBSA D11-3-1", critical: true },
  { id: "u8", text: "Do you carry Product Liability insurance of at least CAD 2,000,000 per occurrence?", ref: "Certificate of Insurance required at PO", critical: true },
  { id: "u9", text: "Are your products aligned with NRCan Energy Efficiency Regulations where applicable (MEPS for lamps / luminaires)?", ref: "NRCan EER 2016", critical: false },
  { id: "u10", text: "Have you previously supplied lighting OEMs or distributors selling into Canada?", ref: "Three references required at next stage", critical: false },
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
  customManufacturing = [],
  customMaterials = [],
}: {
  supplierId: number;
  supplierName: string;
  prefill?: OnboardingPrefill;
  rejectionReason?: string | null;
  clientName: string;
  shopSummary: ShopSummary;
  customManufacturing?: string[];
  customMaterials?: string[];
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

  // Compute score + verdict. Critical "Yes" = +3, non-critical "Yes" =
  // +1, any critical "No" knocks the submission to "Not qualified".
  const { score, scoreMax, verdict, knockouts, allCriticalAnswered } = useMemo(() => {
    let earned = 0;
    let max = 0;
    const ko: string[] = [];
    for (const q of UNIVERSAL_QUESTIONS) {
      const weight = q.critical ? 3 : 1;
      max += weight;
      const a = answers[q.id];
      if (a === "yes") earned += weight;
      else if (q.critical && a === "no") ko.push(q.text);
    }
    const allCrit = UNIVERSAL_QUESTIONS.filter((q) => q.critical).every(
      (q) => answers[q.id] !== undefined,
    );
    const pct = max > 0 ? earned / max : 0;
    let v: "pre-qualified" | "conditional" | "not-qualified";
    if (ko.length > 0) v = "not-qualified";
    else if (pct >= 0.75) v = "pre-qualified";
    else v = "conditional";
    return { score: earned, scoreMax: max, verdict: v, knockouts: ko, allCriticalAnswered: allCrit };
  }, [answers]);

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
        score,
        scoreMax,
        verdict,
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
        customManufacturing={customManufacturing}
        customMaterials={customMaterials}
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

      {/* NOTES */}
      <section style={PANEL_STYLE}>
        <h2 style={H2_STYLE}>2 · Anything else?</h2>
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
          borderLeft:
            knockouts.length > 0
              ? "6px solid #dc2626"
              : verdict === "pre-qualified"
                ? "6px solid #16a34a"
                : "6px solid var(--lb-accent)",
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
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color:
                  knockouts.length > 0
                    ? "#dc2626"
                    : verdict === "pre-qualified"
                      ? "#16a34a"
                      : "var(--lb-accent)",
              }}
            >
              {knockouts.length > 0
                ? "Not qualified"
                : verdict === "pre-qualified"
                  ? "Pre-qualified"
                  : "Conditional"}
            </div>
            <div style={{ fontSize: 13.5, color: "var(--lb-text-2)", marginTop: 4 }}>
              {knockouts.length > 0
                ? `${knockouts.length} critical requirement${knockouts.length === 1 ? "" : "s"} not met. Review the starred items above.`
                : allCriticalAnswered
                  ? `You can submit your application. ${clientName} will review and respond.`
                  : "Answer every starred (critical) question to see your verdict."}
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "var(--lb-text)" }}>
              {score}
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--lb-text-3)",
                  marginLeft: 2,
                }}
              >
                / {scoreMax}
              </span>
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
  customManufacturing,
  customMaterials,
}: {
  supplierId: number;
  supplierName: string;
  summary: ShopSummary;
  customManufacturing: string[];
  customMaterials: string[];
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ShopSummaryEditor
        supplierId={supplierId}
        summary={summary}
        customManufacturing={customManufacturing}
        customMaterials={customMaterials}
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
  customManufacturing,
  customMaterials,
  onCancel,
  onSaved,
}: {
  supplierId: number;
  summary: ShopSummary;
  customManufacturing: string[];
  customMaterials: string[];
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
  const [manufacturingTypes, setManufacturingTypes] = useState<string[]>(
    summary.manufacturingTypes,
  );
  const [materials, setMaterials] = useState<string[]>(summary.materials);
  // Distributor toggle. Pre-checked if the supplier already flipped it
  // on at step 1. Flipping it on hides the manufacturing/materials
  // controls and the save will wipe both arrays server-side.
  const [isDistributor, setIsDistributor] = useState(summary.isDistributor);
  const [mfgOptions, setMfgOptions] = useState<string[]>(() =>
    mergeOptions(MANUFACTURING_TYPES, customManufacturing),
  );
  const [matOptions, setMatOptions] = useState<string[]>(() =>
    mergeOptions(SUPPLIER_MATERIALS, customMaterials),
  );

  // Retargeting the engineering company is opt-in. Default off so a
  // routine save doesn't have to re-validate the email match.
  const [changeEngineering, setChangeEngineering] = useState(false);
  const [engineeringEmail, setEngineeringEmail] = useState("");

  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  async function persistCustomMfg(value: string): Promise<string> {
    const res = await addSupplierTaxonomyTerm({ kind: "manufacturing", value });
    setMfgOptions((prev) =>
      prev.some((o) => o.toLowerCase() === res.value.toLowerCase())
        ? prev
        : [...prev, res.value],
    );
    return res.value;
  }
  async function persistCustomMat(value: string): Promise<string> {
    const res = await addSupplierTaxonomyTerm({ kind: "material", value });
    setMatOptions((prev) =>
      prev.some((o) => o.toLowerCase() === res.value.toLowerCase())
        ? prev
        : [...prev, res.value],
    );
    return res.value;
  }

  function save() {
    if (pending) return;
    setErr(null);
    if (!companyName.trim()) {
      setErr("Company name is required");
      return;
    }
    if (changeEngineering && !engineeringEmail.trim()) {
      setErr("Enter the new retailer's email or cancel the change.");
      return;
    }
    startTransition(async () => {
      try {
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
          manufacturingTypes: isDistributor ? [] : manufacturingTypes,
          materials: isDistributor ? [] : materials,
          isDistributor,
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

      {/* Buy & sell only toggle — same UX as the step-1 wizard. */}
      <label
        style={{
          marginTop: 14,
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 12,
          border: "1px solid var(--lb-border)",
          borderRadius: 8,
          background: "var(--lb-bg)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={isDistributor}
          onChange={(e) => setIsDistributor(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span style={{ fontSize: 13.5, color: "var(--lb-text)", lineHeight: 1.45 }}>
          <strong>I&apos;m a buy &amp; sell supplier</strong> (distributor /
          reseller). I don&apos;t manufacture in-house, so skip the
          manufacturing and materials questions.
        </span>
      </label>

      {!isDistributor && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14, marginTop: 14 }}>
          <MultiSelect
            label="Manufacturing capabilities"
            options={mfgOptions}
            selected={manufacturingTypes}
            onChange={setManufacturingTypes}
            allowCustom
            onAddCustom={persistCustomMfg}
          />
          <MultiSelect
            label="Materials you work with"
            options={matOptions}
            selected={materials}
            onChange={setMaterials}
            allowCustom
            onAddCustom={persistCustomMat}
          />
        </div>
      )}

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
              {summary.invitingClientName ?? "(no retailer linked)"}
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
              Change retailer
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
            <Field label="New retailer email *">
              <input
                type="email"
                value={engineeringEmail}
                onChange={(e) => setEngineeringEmail(e.target.value)}
                placeholder="e.g. contact@acmelighting.com"
                style={INPUT_STYLE}
              />
            </Field>
            <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: -6 }}>
              The new email must belong to a retailer that already has a
              CADuniQ account. We&apos;ll re-validate the match before saving.
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
