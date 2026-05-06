"use client";

// StubTab — placeholder shown for Inventory & Manufacturing modules that
// are scoped on the roadmap but not yet implemented. Apple-inspired:
// generous whitespace, large display type, soft card, subtle shadow.

type Props = {
  title: string;
  description: string;
  features: string[];
};

export default function StubTab({ title, description, features }: Props) {
  return (
    <section className="im-stub">
      <div className="im-stub-eyebrow">In development</div>
      <h2 className="im-stub-title">{title}.</h2>
      <p className="im-stub-desc">{description}</p>

      <div className="im-stub-grid">
        {features.map((f, i) => (
          <div key={i} className="im-stub-feature">
            <span className="im-stub-dot" aria-hidden />
            <span className="im-stub-text">{f}</span>
          </div>
        ))}
      </div>

      <p className="im-stub-foot">
        Built following the best practices of Odoo, SAP, and NetSuite —
        adapted for the lighting industry. <span>Suppliers</span> and{" "}
        <span>Barcodes</span> are live today; the rest rolls out in phases.
      </p>

      <style>{`
        .im-stub{
          max-width:880px;margin:0 auto;padding:80px 32px 96px;text-align:center;
        }
        .im-stub-eyebrow{
          display:inline-block;
          font-family:var(--lb-font-display);
          font-size:12.5px;font-weight:600;color:var(--lb-accent);
          letter-spacing:.02em;margin-bottom:16px;
          padding:5px 12px;border-radius:var(--lb-radius-pill);
          background:color-mix(in srgb, var(--lb-accent) 8%, transparent);
        }
        .im-stub-title{
          font-family:var(--lb-font-display);
          font-size:clamp(36px,5vw,56px);line-height:1.05;font-weight:600;
          letter-spacing:-.028em;margin:0 0 16px;color:var(--lb-text);
        }
        .im-stub-desc{
          font-size:clamp(17px,1.5vw,20px);line-height:1.5;font-weight:400;
          letter-spacing:-.008em;color:var(--lb-text-2);
          max-width:620px;margin:0 auto 48px;
        }
        .im-stub-grid{
          display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
          gap:1px;background:var(--lb-border);
          border:1px solid var(--lb-border);border-radius:var(--lb-radius);
          overflow:hidden;text-align:left;
          box-shadow:var(--lb-shadow-sm);
        }
        .im-stub-feature{
          display:flex;gap:14px;align-items:flex-start;
          background:var(--lb-bg-elev);
          padding:22px 24px;
        }
        .im-stub-dot{
          flex-shrink:0;display:inline-block;width:8px;height:8px;
          margin-top:7px;border-radius:50%;
          background:var(--lb-accent);
          box-shadow:0 0 0 4px color-mix(in srgb, var(--lb-accent) 14%, transparent);
        }
        .im-stub-text{
          font-size:14px;line-height:1.5;color:var(--lb-text);letter-spacing:-.005em;
        }
        .im-stub-foot{
          margin-top:48px;font-size:13px;line-height:1.55;
          color:var(--lb-text-3);
        }
        .im-stub-foot span{color:var(--lb-text);font-weight:500}

        @media (max-width:640px){
          .im-stub{padding:48px 20px 64px;text-align:left}
          .im-stub-title{text-align:left}
          .im-stub-desc{margin-left:0;margin-right:0;text-align:left}
        }
      `}</style>
    </section>
  );
}
