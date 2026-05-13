import PlatformMap from "./PlatformMap";
import { getStage, type PlatformStageId } from "./platform-stages";

// Template for every Coming-Soon module page. Renders a stage-specific hero,
// a "what's coming" module list pulled from the visual map, an event-bus
// "connects to" panel showing inbound + outbound events, and the platform map
// with this stage highlighted so the user always sees how this module fits
// into the larger CADuniQ flow.

export default function ComingSoonModule({
  stage,
  intro,
  extras,
}: {
  stage: PlatformStageId;
  /** Optional 1-2 sentence intro replacing the visual-map summary. */
  intro?: string;
  /** Optional extra blocks rendered between the connects-to panel and the
   *  platform map (e.g. a screenshot, a simulation embed, a roadmap teaser). */
  extras?: React.ReactNode;
}) {
  const s = getStage(stage);
  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      {/* HERO */}
      <header
        style={{
          padding: "24px 28px",
          borderRadius: 14,
          background: `linear-gradient(155deg, ${s.accentBg}, var(--lb-bg-elev))`,
          border: `1px solid ${s.accentBorder}`,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          color: "#1a1f36",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              background: s.accent,
              color: "#fff",
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 1.2,
              padding: "3px 10px",
              borderRadius: 5,
              textTransform: "uppercase",
            }}
          >
            {s.badge}
          </span>
          <span
            style={{
              background: "rgba(234,88,12,0.16)",
              color: "rgb(234,88,12)",
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 1.2,
              padding: "3px 10px",
              borderRadius: 5,
              textTransform: "uppercase",
            }}
          >
            Coming soon
          </span>
        </div>
        <h1
          style={{
            fontSize: "clamp(26px, 3.4vw, 38px)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            margin: 0,
            lineHeight: 1.1,
            color: "#1a1f36",
          }}
        >
          {s.title}
        </h1>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "#3d4663",
            margin: 0,
            maxWidth: 760,
          }}
        >
          {intro ?? s.summary}
        </p>
      </header>

      {/* WHAT'S COMING */}
      <section
        style={{
          padding: "18px 22px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <h2
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
            margin: "0 0 12px",
          }}
        >
          What ships in this module
        </h2>
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 8,
          }}
        >
          {s.modules.map((m) => (
            <li
              key={m}
              style={{
                fontSize: 13,
                color: "var(--lb-text-2)",
                padding: "8px 10px",
                background: "var(--lb-bg)",
                borderRadius: 8,
                border: "1px solid var(--lb-border)",
              }}
            >
              {m}
            </li>
          ))}
        </ul>
      </section>

      {/* CONNECTS TO */}
      {(s.consumes || s.emits) && (
        <section
          style={{
            padding: "18px 22px",
            borderRadius: 14,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}
        >
          <div>
            <h2
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--lb-text-3)",
                margin: "0 0 10px",
              }}
            >
              Consumes (from event bus)
            </h2>
            {s.consumes && s.consumes.length > 0 ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {s.consumes.map((e) => (
                  <li
                    key={e}
                    style={{
                      fontFamily:
                        "ui-monospace, 'JetBrains Mono', Menlo, monospace",
                      fontSize: 12,
                      color: "var(--lb-text)",
                      padding: "5px 9px",
                      borderRadius: 6,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      display: "inline-block",
                      margin: "0 6px 6px 0",
                    }}
                  >
                    {e}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 12, color: "var(--lb-text-3)", margin: 0 }}>
                Independent of upstream events — kicks off its own flows.
              </p>
            )}
          </div>
          <div>
            <h2
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--lb-text-3)",
                margin: "0 0 10px",
              }}
            >
              Emits (to event bus)
            </h2>
            {s.emits && s.emits.length > 0 ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {s.emits.map((e) => (
                  <li
                    key={e}
                    style={{
                      fontFamily:
                        "ui-monospace, 'JetBrains Mono', Menlo, monospace",
                      fontSize: 12,
                      color: "var(--lb-text)",
                      padding: "5px 9px",
                      borderRadius: 6,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      display: "inline-block",
                      margin: "0 6px 6px 0",
                    }}
                  >
                    {e}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 12, color: "var(--lb-text-3)", margin: 0 }}>
                Terminal subscriber — no downstream emissions.
              </p>
            )}
          </div>
        </section>
      )}

      {extras}

      {/* PLATFORM MAP */}
      <PlatformMap highlight={stage} compact />
    </div>
  );
}
