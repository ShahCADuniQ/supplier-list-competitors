import Link from "next/link";
import { redirect } from "next/navigation";
import { canViewDesignEngineering, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Full CAD + PDM (Stage 5) — ${CLIENT_CONFIG.name}`,
};

// Stage 5 — SolidWorks-class CAD browser-native + cross-vendor PDM. Each
// module here will host real CAD functionality as it ships. For now the
// page surfaces the catalog + roadmap so users see exactly what's coming
// and in what order.

const MODULES = [
  {
    id: "5a",
    title: "Surfacing & Class-A",
    blurb:
      "NURBS surface kernel, Style spline, freeform/deform, G0–G3 continuity analysis with zebra-stripe & curvature-comb visualisation, mesh-to-surface reconstruction.",
    months: "M30 → M37",
    replaces: ["Catia ICEM Surf", "Alias", "SolidWorks Premium add-on"],
    accent: "#7c3aed",
  },
  {
    id: "5b",
    title: "Sheet Metal & Weldments Pro",
    blurb:
      "Forming-tools library with auto-detection, hem/edge/swept/lofted flanges, multi-body sheet metal, weldment cut list, weld beads + ISO 2553 symbols from mating constraints.",
    months: "M32 → M37",
    replaces: ["SolidWorks Premium sheet metal"],
    accent: "#0891b2",
  },
  {
    id: "5c",
    title: "Mold Tools & Plastics",
    blurb:
      "Parting line/surface, core/cavity split, mold-base library (Hasco/DME/Misumi), cooling-channel design with FEA hooks, ejector layout, mold-flow simulation.",
    months: "M37 → M43",
    replaces: ["MoldFlow", "SolidWorks Plastics"],
    accent: "#ea580c",
  },
  {
    id: "5d",
    title: "Routing — Electrical / Piping / Conduit",
    blurb:
      "Auto-route with clearance + bend-radius constraints, cable harnesses with bundle viz, pipe specs (ASME B16 / DIN / ISO) with auto-fittings, flattened harness drawings.",
    months: "M37 → M44",
    replaces: ["SolidWorks Routing", "Catia DMU"],
    accent: "#db2777",
  },
  {
    id: "5e",
    title: "CAM Toolpath",
    blurb:
      "2.5/3/4/5-axis milling + turning + wire EDM + mill-turn. ISO tool library, post-processors for Haas/Fanuc/Mazak/DMG Mori/Siemens, voxel material-removal preview, G-code export, setup sheets.",
    months: "M40 → M50 (heaviest module)",
    replaces: ["HSMWorks", "Mastercam", "Fusion CAM"],
    accent: "#ca8a04",
  },
  {
    id: "5f",
    title: "Electrical Schematics 2D + 3D",
    blurb:
      "IEC/IEEE/JIC symbol libraries, bidirectional schematic ↔ 3D harness sync, wire labels, terminal blocks, PLC I/O, cabinet design (DIN rail, 19″ rack), auto wire BOM.",
    months: "M44 → M51",
    replaces: ["SolidWorks Electrical", "EPLAN"],
    accent: "#16a34a",
  },
  {
    id: "5g",
    title: "Composer-Grade Tech Comm",
    blurb:
      "Vector technical illustrations driven by 3D state, animated maintenance procedures, interactive 3D PDF, shop-floor + field-service documentation.",
    months: "M48 → M52",
    replaces: ["SolidWorks Composer", "PTC Creo Illustrate"],
    accent: "#2563eb",
  },
  {
    id: "5h",
    title: "Cross-CAD Round-Trip",
    blurb:
      "Native read/write SLDPRT, IPT/IAM, CATPart, NX PRT, Creo PRT, F3D — with feature-tree preservation. Two-way bridge so SolidWorks teams + CADuniQ teams edit the same parts.",
    months: "M30 → M50 (ongoing)",
    replaces: ["Manual export/import dance"],
    accent: "#7c3aed",
  },
  {
    id: "5i",
    title: "Enterprise PDM",
    blurb:
      "Multi-site vault replication, ECO/ECN/ECR workflows, BOM-aware revision propagation, mobile sign-off, web-first cross-CAD vault holding every vendor's files in one repo.",
    months: "M48 → M56",
    replaces: ["SolidWorks PDM Pro", "Autodesk Vault", "PTC Windchill"],
    accent: "#0891b2",
    link: "/design-engineering/enterprise-pdm",
    linkLabel: "Open vault (MVP)",
    status: "partial" as const,
  },
  {
    id: "5j",
    title: "Desktop Bridge Apps",
    blurb:
      "Lightweight Windows / macOS / Linux companion apps (Tauri) running alongside SolidWorks / Inventor / Catia / NX / Creo / Fusion. Auto-sync to vault, live presence inside host CAD, Copilot docked.",
    months: "M52 → M56",
    replaces: ["Manual file shuttling"],
    accent: "#ea580c",
  },
];

function StatusPill({ status }: { status?: "partial" | "coming-soon" }) {
  if (status === "partial") {
    return (
      <span
        style={{
          background: "rgba(234,179,8,0.18)",
          color: "rgb(161,98,7)",
          padding: "2px 8px",
          borderRadius: 5,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.8,
          textTransform: "uppercase",
        }}
      >
        Partial · MVP live
      </span>
    );
  }
  return (
    <span
      style={{
        background: "rgba(234,88,12,0.14)",
        color: "rgb(234,88,12)",
        padding: "2px 8px",
        borderRadius: 5,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.8,
        textTransform: "uppercase",
      }}
    >
      Coming soon
    </span>
  );
}

export default async function FullCadModulePage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewDesignEngineering(profile)) redirect("/");

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
          background:
            "linear-gradient(155deg, rgba(234,88,12,0.10), var(--lb-bg-elev))",
          border: "1px solid rgba(234,88,12,0.28)",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <span
            style={{
              background: "#ea580c",
              color: "#fff",
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 1.2,
              padding: "3px 10px",
              borderRadius: 5,
              textTransform: "uppercase",
            }}
          >
            Stage 5 · M30 → M60
          </span>
        </div>
        <h1
          style={{
            fontSize: "clamp(28px, 3.6vw, 42px)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          Full CAD + Enterprise PDM
        </h1>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
            margin: "12px 0 0",
            maxWidth: 780,
          }}
        >
          SolidWorks-Premium-class CAD running browser-native. Ten modules
          covering surfacing, sheet metal, mold tools, routing, CAM, electrical,
          tech comm, cross-CAD round-trip, enterprise PDM, and desktop bridges.
          Each one plugs into the same event bus that drives Stage 3 ERP,
          Stage 4 CRM, and Stage 6 floor ops.
        </p>
      </header>

      {/* HOW IT FITS */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        <Fact
          accent="#2563eb"
          title="What it replaces"
          body="SolidWorks Premium + PDM Pro + HSMWorks + Electrical + Composer + Visualize Pro — six $4-10k desktop seats per engineer."
        />
        <Fact
          accent="#16a34a"
          title="Why browser-native"
          body="One vault, one Copilot, one event bus. Real-time multi-user on every module. No Windows-only PDM client."
        />
        <Fact
          accent="#7c3aed"
          title="Bridge for sceptics"
          body="Cross-CAD round-trip (5h) + Desktop Bridge (5j) keep SolidWorks teams in their daily driver — CADuniQ owns everything around it."
        />
      </section>

      {/* MODULE CATALOG */}
      <section
        style={{
          padding: "22px 26px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <h2
          style={{
            fontSize: 15,
            fontWeight: 700,
            margin: "0 0 14px",
            letterSpacing: "-0.01em",
          }}
        >
          Stage 5 module roadmap
        </h2>
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 12,
          }}
        >
          {MODULES.map((m) => (
            <li
              key={m.id}
              style={{
                padding: "16px 18px",
                borderRadius: 12,
                background: "var(--lb-bg)",
                border: `1px solid ${m.accent}55`,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                borderLeft: `4px solid ${m.accent}`,
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontFamily:
                        "ui-monospace, 'JetBrains Mono', Menlo, monospace",
                      fontSize: 11,
                      fontWeight: 800,
                      color: "#fff",
                      padding: "2px 7px",
                      borderRadius: 5,
                      background: m.accent,
                    }}
                  >
                    {m.id}
                  </span>
                  <h3
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      margin: 0,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {m.title}
                  </h3>
                </div>
                <StatusPill status={m.status} />
              </header>
              <p
                style={{
                  fontSize: 12.5,
                  color: "var(--lb-text-2)",
                  lineHeight: 1.55,
                  margin: 0,
                }}
              >
                {m.blurb}
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {m.replaces.map((r) => (
                  <span
                    key={r}
                    style={{
                      fontSize: 10.5,
                      padding: "2px 7px",
                      borderRadius: 5,
                      background: "var(--lb-bg-elev)",
                      color: "var(--lb-text-3)",
                      fontWeight: 600,
                    }}
                  >
                    replaces · {r}
                  </span>
                ))}
              </div>
              <footer
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--lb-text-3)",
                    fontFamily:
                      "ui-monospace, 'JetBrains Mono', Menlo, monospace",
                  }}
                >
                  {m.months}
                </span>
                {m.link && (
                  <Link
                    href={m.link}
                    style={{
                      fontSize: 12,
                      color: m.accent,
                      fontWeight: 700,
                      textDecoration: "none",
                    }}
                  >
                    {m.linkLabel} →
                  </Link>
                )}
              </footer>
            </li>
          ))}
        </ol>
      </section>

      {/* EVENT BUS HOOK */}
      <section
        style={{
          padding: "16px 22px",
          borderRadius: 14,
          background:
            "linear-gradient(90deg, rgba(37,99,235,0.10), rgba(124,58,237,0.10), rgba(234,88,12,0.10))",
          border: "1px solid var(--lb-border)",
        }}
      >
        <h2
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            margin: "0 0 6px",
            color: "var(--lb-text)",
          }}
        >
          ⚡ How Stage 5 plugs into the rest of the platform
        </h2>
        <p
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
            margin: 0,
          }}
        >
          Every Stage 5 edit emits typed events on the same bus the Projects
          workflow uses. <code>cad.surface.modified</code> in 5a regenerates
          the 2D drawing set in 1a. <code>cam.toolpath_generated</code> in 5e
          drops G-code straight into Stage 2 supplier routing.{" "}
          <code>pdm.eco_approved</code> in 5i propagates revisions across the
          BOM in 3b and triggers a maintenance check in 6c. One geometry edit,
          every system updated.
        </p>
      </section>
    </div>
  );
}

function Fact({
  accent,
  title,
  body,
}: {
  accent: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: accent,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "var(--lb-text-2)",
        }}
      >
        {body}
      </div>
    </div>
  );
}
