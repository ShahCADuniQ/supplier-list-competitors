"use client";

// Post-signup wizard. Three completely separate forms depending on the
// `role` chosen at /get-started.
//
// Supplier flow: the sign-up screen only collects the bare-minimum
// company identifiers needed to route the request to the retailer for
// approval. Capabilities, materials, distributor flag, and supporting
// documents are filled in later — first via the compliance step at
// /portal, then continuously through the "About us" tab once approved.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  claimEngineeringCompany,
  claimRetailer,
  claimSupplier,
} from "./onboarding-actions";
import { SUPPLIER_CATEGORIES as CANONICAL_SUPPLIER_CATEGORIES } from "@/app/suppliers/supplier-inventory-constants";

const SECTION: React.CSSProperties = {
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
  borderRadius: 12,
  padding: 24,
  marginBottom: 14,
};
const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 700, letterSpacing: "0.02em",
  textTransform: "uppercase", color: "var(--lb-text-3)",
  marginBottom: 4,
};
const INPUT: React.CSSProperties = {
  width: "100%", padding: "9px 12px", fontSize: 14,
  border: "1px solid var(--lb-border)", borderRadius: 8,
  background: "var(--lb-bg)", color: "var(--lb-text)",
  outline: "none",
};
const PRIMARY_BTN: React.CSSProperties = {
  padding: "11px 22px", fontSize: 14, fontWeight: 700,
  borderRadius: 999, color: "#fff", border: "none",
  cursor: "pointer",
  boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
};

const ENGINEERING_INDUSTRIES = [
  "Manufacturing",
  "Lighting",
  "Construction / Building Materials",
  "Aerospace",
  "Automotive",
  "Medical Devices",
  "Consumer Electronics",
  "Industrial Equipment",
  "Furniture / Fixtures",
  "Other",
];

// Primary-capability picker on step 1. Re-exported from the canonical
// list in supplier-inventory-constants.ts so the wizard offers exactly
// the same options the supplier-database admin picker shows. The OLD
// list here was a mix of manufacturing PROCESSES (CNC, sheet-metal,
// etc.) — those now belong in the dedicated "Manufacturing
// capabilities" multi-select further down the form, NOT here.
const SUPPLIER_CATEGORIES = [...CANONICAL_SUPPLIER_CATEGORIES];

export default function OnboardingWizard({
  role,
  defaultEmail,
  defaultName,
}: {
  role: "engineering" | "supplier" | "retailer";
  defaultEmail: string;
  defaultName: string;
}) {
  return (
    <main style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #eef2ff 0%, #f8f9fc 40%, #fdf2f8 100%)",
      padding: "clamp(32px, 6vw, 64px) 20px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <Link href="/" style={{
          display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 18,
          color: "var(--lb-text-3)", textDecoration: "none", fontSize: 13,
        }}>
          <span aria-hidden style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, borderRadius: 7,
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
            color: "#fff", fontWeight: 800, fontSize: 13,
          }}>C</span>
          <strong style={{ color: "var(--lb-text)" }}>CADuniQ Manufacturing</strong>
        </Link>

        {role === "engineering" ? (
          <EngineeringFlow defaultEmail={defaultEmail} defaultName={defaultName} />
        ) : role === "supplier" ? (
          <SupplierFlow
            defaultEmail={defaultEmail}
            defaultName={defaultName}
          />
        ) : (
          <RetailerFlow defaultEmail={defaultEmail} defaultName={defaultName} />
        )}
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINEERING COMPANY FLOW
// ─────────────────────────────────────────────────────────────────────────────

function EngineeringFlow({ defaultEmail, defaultName }: { defaultEmail: string; defaultName: string }) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("Manufacturing");
  const [contactName, setContactName] = useState(defaultName);
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!companyName.trim()) { setErr("Company name is required"); return; }
    setBusy(true); setErr(null);
    try {
      await claimEngineeringCompany({
        companyName,
        industry,
        contactName,
        phone,
        website,
      });
      router.push("/admin");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create company");
      setBusy(false);
    }
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <span style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 999,
          background: "rgba(37,99,235,0.10)", color: "#2563eb",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
        }}>
          DESIGNER / ENGINEERING COMPANY · STEP 1 OF 1
        </span>
        <h1 style={{ margin: "12px 0 6px", fontSize: "clamp(24px, 3vw, 32px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          Tell us about your company.
        </h1>
        <p style={{ margin: 0, color: "var(--lb-text-2)", fontSize: 14, lineHeight: 1.55 }}>
          This creates your private workspace. You&apos;ll be the admin and can
          invite teammates from /admin once you&apos;re in.
        </p>
      </header>

      <section style={SECTION}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Company name *">
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme Lighting Inc." style={INPUT} />
          </Field>
          <Field label="Industry">
            <select value={industry} onChange={(e) => setIndustry(e.target.value)} style={INPUT}>
              {ENGINEERING_INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
          <Field label="Your name">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Jane Smith" style={INPUT} />
          </Field>
          <Field label="Signed up as">
            <input value={defaultEmail} disabled style={{ ...INPUT, opacity: 0.7, cursor: "not-allowed" }} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 514 ..." style={INPUT} />
          </Field>
          <Field label="Website">
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" style={INPUT} />
          </Field>
        </div>
      </section>

      {err && (
        <div style={{
          padding: 12, marginBottom: 12, borderRadius: 10,
          background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)",
          color: "#dc2626", fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !companyName.trim()}
          style={{
            ...PRIMARY_BTN,
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
            opacity: busy || !companyName.trim() ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Creating workspace…" : "Create my workspace →"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER FLOW
// ─────────────────────────────────────────────────────────────────────────────

function SupplierFlow({
  defaultEmail,
  defaultName,
}: {
  defaultEmail: string;
  defaultName: string;
}) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState(defaultName);
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [country, setCountry] = useState("");
  const [products, setProducts] = useState("");
  const [engineeringEmail, setEngineeringEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!companyName.trim()) { setErr("Your company name is required"); return; }
    if (!contactName.trim()) { setErr("Please tell us who you are"); return; }
    if (!engineeringEmail.trim()) {
      setErr("Please enter the email of the retailer that invited you (or that you want to work with).");
      return;
    }
    setBusy(true); setErr(null);
    try {
      // Manufacturing capabilities, materials, and the buy-&-sell flag
      // are NOT collected on sign-up anymore — the supplier sets them
      // later from their "About us" tab in the portal. Sending empty
      // arrays + false here keeps the server payload shape stable.
      await claimSupplier({
        companyName,
        contactName,
        phone,
        website,
        category,
        subCategory,
        country,
        products,
        manufacturingTypes: [],
        materials: [],
        isDistributor: false,
        engineeringCompanyEmail: engineeringEmail,
      });
      // claimSupplier throws if the engineering company email doesn't
      // map to a real CADuniQ tenant, so reaching this point means the
      // supplier is now linked. /portal renders step 2 (compliance only).
      router.push("/portal");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit");
      setBusy(false);
    }
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <span style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 999,
          background: "rgba(22,163,74,0.12)", color: "#16a34a",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
        }}>
          SUPPLIER · STEP 1 OF 2
        </span>
        <h1 style={{ margin: "12px 0 6px", fontSize: "clamp(24px, 3vw, 32px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          Tell us about your shop.
        </h1>
        <p style={{ margin: 0, color: "var(--lb-text-2)", fontSize: 14, lineHeight: 1.55 }}>
          This creates your private supplier profile. The retailer you enter
          below will review it. Everything you fill in here describes your
          shop. Step 2 (the compliance checklist) opens automatically afterwards
          and asks only about certifications and regulations, no repeat
          questions.
        </p>
      </header>

      {/* Company info */}
      <section style={SECTION}>
        <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#16a34a", paddingBottom: 8, borderBottom: "1px solid var(--lb-border)" }}>
          1 · Who you are
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Company name *">
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Tadius Machine Shop Inc." style={INPUT} />
          </Field>
          <Field label="Your name *">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Jane Smith, Sales Director" style={INPUT} />
          </Field>
          <Field label="Signed up as">
            <input value={defaultEmail} disabled style={{ ...INPUT, opacity: 0.7, cursor: "not-allowed" }} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 ..." style={INPUT} />
          </Field>
          <Field label="Website">
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" style={INPUT} />
          </Field>
          <Field label="Country of operation">
            <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Canada / United States / China …" style={INPUT} />
          </Field>
        </div>
      </section>

      {/* What you supply — all capability + portfolio data lives here, NOT in step 2. */}
      <section style={SECTION}>
        <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#16a34a", paddingBottom: 8, borderBottom: "1px solid var(--lb-border)" }}>
          2 · What you supply
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <Field label="Primary capability">
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={INPUT}>
              <option value="">— select —</option>
              {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Sub-category / specialty">
            <input
              value={subCategory}
              onChange={(e) => setSubCategory(e.target.value)}
              placeholder="e.g. aluminum extrusion, 0-10V drivers, IES-rated lenses…"
              style={INPUT}
            />
          </Field>
        </div>
        <Field label="Products / services you offer">
          <textarea
            value={products}
            onChange={(e) => setProducts(e.target.value)}
            placeholder="One per line. The retailer uses this to decide which RFQs to send you."
            style={{ ...INPUT, minHeight: 70, resize: "vertical" }}
          />
        </Field>
        <p style={{
          margin: "10px 0 0",
          fontSize: 11.5,
          color: "var(--lb-text-3)",
          fontStyle: "italic",
        }}>
          Capabilities, materials, and supporting documents are filled in
          later from your portal &mdash; we keep this first step short.
        </p>
      </section>

      {/* Engineering company link */}
      <section style={{
        ...SECTION,
        borderLeft: "4px solid #16a34a",
      }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#16a34a" }}>
          3 · Who invited you?
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
          Enter the email of the retailer you&apos;re signing up to work with.
          We&apos;ll route your profile to them for approval.{" "}
          <strong>They won&apos;t see who else you supply, and you won&apos;t
          see who else they buy from.</strong>
        </p>
        <Field label="Retailer email *">
          <input
            type="email"
            value={engineeringEmail}
            onChange={(e) => setEngineeringEmail(e.target.value)}
            placeholder="e.g. contact@acmelighting.com"
            style={INPUT}
          />
        </Field>
        <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>
          This email must belong to a retailer that already has a CADuniQ
          account. If we can&apos;t find a match we&apos;ll tell you so you can
          try a different address.
        </p>
      </section>

      {err && (
        <div style={{
          padding: 12, marginBottom: 12, borderRadius: 10,
          background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)",
          color: "#dc2626", fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !companyName.trim() || !engineeringEmail.trim()}
          style={{
            ...PRIMARY_BTN,
            background: "linear-gradient(135deg, #16a34a 0%, #059669 100%)",
            boxShadow: "0 4px 14px rgba(22,163,74,0.22)",
            opacity: busy || !companyName.trim() || !engineeringEmail.trim() ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Submitting…" : "Continue to compliance checklist →"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RETAILER FLOW
// Buyers / distributors of finished goods. They link to an engineering
// company by email (same resolution as the supplier flow), and on submit
// the server creates a crm_accounts row in that engineering company's
// CRM + flips isRetailer on the user_profiles row so the app shell
// routes them to /retailer.
// ─────────────────────────────────────────────────────────────────────────────

const RETAILER_INDUSTRIES = [
  "Lighting Distributor",
  "Architectural / Specifier",
  "General Contractor",
  "Electrical Wholesaler",
  "Hospitality / Hotel Group",
  "Retail Chain",
  "E-commerce Brand",
  "Government / Municipal",
  "Property Developer",
  "Other",
];

function RetailerFlow({ defaultEmail, defaultName }: { defaultEmail: string; defaultName: string }) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState(defaultName);
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [country, setCountry] = useState("");
  const [engineeringEmail, setEngineeringEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!companyName.trim()) { setErr("Your company name is required"); return; }
    if (!contactName.trim()) { setErr("Please tell us who you are"); return; }
    if (!engineeringEmail.trim()) {
      setErr("Please enter the email of the engineering company you buy from.");
      return;
    }
    setBusy(true); setErr(null);
    try {
      await claimRetailer({
        companyName,
        contactName,
        phone,
        website,
        industry,
        country,
        engineeringCompanyEmail: engineeringEmail,
      });
      // claimRetailer throws if no matching engineering company exists,
      // so reaching here means we landed on a real tenant.
      router.push("/retailer");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit");
      setBusy(false);
    }
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <span style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 999,
          background: "rgba(234,88,12,0.12)", color: "#ea580c",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
        }}>
          RETAILER · STEP 1 OF 1
        </span>
        <h1 style={{ margin: "12px 0 6px", fontSize: "clamp(24px, 3vw, 32px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          Tell us about your company.
        </h1>
        <p style={{ margin: 0, color: "var(--lb-text-2)", fontSize: 14, lineHeight: 1.55 }}>
          You buy finished products from a CADuniQ engineering company.
          We&apos;ll set up your private buyer portal, link you to their
          catalog, and notify them you&apos;ve signed up.
        </p>
      </header>

      <section style={SECTION}>
        <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#ea580c", paddingBottom: 8, borderBottom: "1px solid var(--lb-border)" }}>
          1 · Your company
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Company name *">
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme Lighting Distribution" style={INPUT} />
          </Field>
          <Field label="Your name *">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Jane Smith, Procurement Director" style={INPUT} />
          </Field>
          <Field label="Signed up as">
            <input value={defaultEmail} disabled style={{ ...INPUT, opacity: 0.7, cursor: "not-allowed" }} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 ..." style={INPUT} />
          </Field>
          <Field label="Website">
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" style={INPUT} />
          </Field>
          <Field label="Country">
            <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Canada / United States / France …" style={INPUT} />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="What kind of business are you?">
              <select value={industry} onChange={(e) => setIndustry(e.target.value)} style={INPUT}>
                <option value="">— select —</option>
                {RETAILER_INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </Field>
          </div>
        </div>
      </section>

      <section style={{ ...SECTION, borderLeft: "4px solid #ea580c" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#ea580c" }}>
          2 · Which engineering company do you buy from?
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
          Enter the contact email of the engineering company that supplies
          you. We&apos;ll link your buyer profile to them so your portal
          shows only their catalog and your orders.{" "}
          <strong>They won&apos;t see who their other retailers are, and you
          won&apos;t see anyone else&apos;s catalog.</strong>
        </p>
        <Field label="Engineering company email *">
          <input
            type="email"
            value={engineeringEmail}
            onChange={(e) => setEngineeringEmail(e.target.value)}
            placeholder="e.g. contact@acmelighting.com"
            style={INPUT}
          />
        </Field>
        <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--lb-text-3)" }}>
          This email must belong to an engineering company that already has a
          CADuniQ account. If we can&apos;t find a match we&apos;ll let you
          know so you can try a different address.
        </p>
      </section>

      {err && (
        <div style={{
          padding: 12, marginBottom: 12, borderRadius: 10,
          background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)",
          color: "#dc2626", fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !companyName.trim() || !engineeringEmail.trim()}
          style={{
            ...PRIMARY_BTN,
            background: "linear-gradient(135deg, #ea580c 0%, #db2777 100%)",
            boxShadow: "0 4px 14px rgba(234,88,12,0.22)",
            opacity: busy || !companyName.trim() || !engineeringEmail.trim() ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Setting up…" : "Open my buyer portal →"}
        </button>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div style={FIELD_LABEL}>{label}</div>
      {children}
    </label>
  );
}
