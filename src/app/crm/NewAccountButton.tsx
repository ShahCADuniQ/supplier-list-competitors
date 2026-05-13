"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CrmAccount } from "@/db/schema";
import { createAccount } from "./actions";
import { TIER_META, TIER_ORDER } from "./constants";

export default function NewAccountButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [country, setCountry] = useState("");
  const [tier, setTier] = useState<CrmAccount["tier"]>("lead");
  const [busy, setBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setWebsite("");
    setIndustry("");
    setCountry("");
    setTier("lead");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Account name is required");
      return;
    }
    setError(null);
    setBusy(async () => {
      try {
        const r = await createAccount({
          name: name.trim(),
          website: website.trim() || undefined,
          industry: industry.trim() || undefined,
          country: country.trim() || undefined,
          tier,
        });
        reset();
        setOpen(false);
        router.push(`/crm/accounts/${r.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create account");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 18px",
          borderRadius: 999,
          background: "rgb(219,39,119)",
          color: "#fff",
          fontSize: 13.5,
          fontWeight: 700,
          letterSpacing: "-0.005em",
          border: "1px solid rgb(219,39,119)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        + New account
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New account"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 60,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <form
            onSubmit={handleSubmit}
            style={{
              width: "100%",
              maxWidth: 460,
              padding: 24,
              borderRadius: 14,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              color: "var(--lb-text)",
            }}
          >
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              New CRM account
            </h2>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--lb-text-2)",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              One account per company. You&apos;ll add contacts, opportunities,
              and activities on the detail page.
            </p>

            <Field label="Company name *">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Robotics Inc."
                autoFocus
                disabled={busy}
                style={INPUT}
              />
            </Field>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <Field label="Website">
                <input
                  type="url"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://acme.com"
                  disabled={busy}
                  style={INPUT}
                />
              </Field>
              <Field label="Country">
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="USA"
                  disabled={busy}
                  style={INPUT}
                />
              </Field>
            </div>

            <Field label="Industry">
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. Industrial automation"
                disabled={busy}
                style={INPUT}
              />
            </Field>

            <Field label="Tier">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {TIER_ORDER.map((t) => {
                  const m = TIER_META[t];
                  const active = t === tier;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTier(t)}
                      disabled={busy}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 999,
                        background: active ? m.color : "var(--lb-bg-elev)",
                        color: active ? "#fff" : m.color,
                        border: `1px solid ${active ? m.color : `${m.color}55`}`,
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: busy ? "not-allowed" : "pointer",
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            {error && (
              <div
                role="alert"
                style={{
                  fontSize: 12.5,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "rgba(239,68,68,0.14)",
                  color: "rgb(220,38,38)",
                  border: "1px solid rgba(239,68,68,0.28)",
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (!busy) {
                    reset();
                    setOpen(false);
                  }
                }}
                disabled={busy}
                style={{
                  padding: "9px 16px",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--lb-text-2)",
                  border: "1px solid var(--lb-border)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: "9px 18px",
                  borderRadius: 8,
                  background: "rgb(219,39,119)",
                  color: "#fff",
                  border: "1px solid rgb(219,39,119)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "Creating…" : "Create account"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

const INPUT: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg-elev)",
  color: "var(--lb-text)",
  fontSize: 13.5,
  width: "100%",
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--lb-text-2)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
