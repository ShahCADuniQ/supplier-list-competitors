"use client";

// StubTab — placeholder for Inventory & Manufacturing modules that are scoped
// on the roadmap but not yet implemented. Follows the SaaS dashboard design
// system (docs/superpowers/specs/2026-05-05-saas-dashboard-design-system.md):
// dark card, vivid cobalt status pill, two-column feature grid.

type Props = {
  title: string;
  description: string;
  features: string[];
};

export default function StubTab({ title, description, features }: Props) {
  return (
    <section className="px-6 py-8" style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div
        className="lb-card"
        style={{
          padding: 32,
          borderRadius: "var(--lb-radius-lg)",
        }}
      >
        <span
          className="lb-section-title"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 12px",
            borderRadius: "var(--lb-radius-pill)",
            background: "color-mix(in srgb, var(--lb-accent) 12%, transparent)",
            color: "var(--lb-accent)",
            fontSize: 11,
            letterSpacing: "0.06em",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: 9999,
              background: "var(--lb-accent)",
            }}
          />
          In development
        </span>
        <h2
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.022em",
            color: "var(--lb-text)",
            margin: "16px 0 8px",
          }}
        >
          {title}
        </h2>
        <p
          style={{
            fontSize: "var(--lb-text-15)",
            lineHeight: 1.5,
            color: "var(--lb-text-2)",
            margin: 0,
            maxWidth: 640,
          }}
        >
          {description}
        </p>

        <div
          className="grid mt-8 gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
        >
          {features.map((f, i) => (
            <div
              key={i}
              className="flex items-start gap-3 px-4 py-3"
              style={{
                background: "var(--lb-bg-sunken)",
                border: "1px solid var(--lb-border)",
                borderRadius: "var(--lb-radius-sm)",
              }}
            >
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  marginTop: 8,
                  borderRadius: 9999,
                  background: "var(--lb-accent)",
                  boxShadow: "var(--lb-glow-accent)",
                }}
              />
              <span
                style={{
                  fontSize: "var(--lb-text-13)",
                  lineHeight: 1.5,
                  color: "var(--lb-text)",
                  letterSpacing: "-0.005em",
                }}
              >
                {f}
              </span>
            </div>
          ))}
        </div>

        <p
          style={{
            marginTop: 24,
            fontSize: "var(--lb-text-13)",
            lineHeight: 1.55,
            color: "var(--lb-text-3)",
          }}
        >
          Built following the best practices of Odoo, SAP, and NetSuite —
          adapted for the lighting industry. Suppliers and Barcodes are live
          today; the rest rolls out in phases.
        </p>
      </div>
    </section>
  );
}
