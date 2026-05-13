import Link from "next/link";
import { redirect } from "next/navigation";
import {
  canViewDesignEngineering,
  getOrCreateProfile,
  isAdmin,
} from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { listMyDesignProjects } from "./actions";
import NewProjectButton from "./NewProjectButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Design & Engineering — ${CLIENT_CONFIG.name}`,
};

// Stage 1 workflow project list. Each project follows the seven-step
// concept-guide flow (CAD upload → drawing settings → BOM → AI material
// recommender → FEA notes → installation manual notes → approval gate).
// The wizard lives at /design-engineering/projects/[id].

function statusBadge(status: string) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    draft: {
      label: "Draft",
      bg: "rgba(120,113,108,0.16)",
      fg: "rgb(87,83,78)",
    },
    "in-review": {
      label: "In Review",
      bg: "rgba(234,179,8,0.18)",
      fg: "rgb(161,98,7)",
    },
    approved: {
      label: "Approved",
      bg: "rgba(34,197,94,0.18)",
      fg: "rgb(22,163,74)",
    },
  };
  const s = map[status] ?? map.draft;
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        padding: "3px 9px",
        borderRadius: 6,
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.8,
        textTransform: "uppercase",
      }}
    >
      {s.label}
    </span>
  );
}

function progress(p: {
  cadFilesCount: number;
  bomItemsCount: number;
  hasFeaNotes: boolean;
  hasManualNotes: boolean;
  status: string;
}) {
  const checks: Array<{ key: string; done: boolean; label: string }> = [
    { key: "cad", done: p.cadFilesCount > 0, label: "CAD" },
    { key: "bom", done: p.bomItemsCount > 0, label: "BOM" },
    { key: "fea", done: p.hasFeaNotes, label: "FEA" },
    { key: "manual", done: p.hasManualNotes, label: "Manual" },
    { key: "approve", done: p.status === "approved", label: "Approved" },
  ];
  const completed = checks.filter((c) => c.done).length;
  const pct = Math.round((completed / checks.length) * 100);
  return { pct, completed, total: checks.length, checks };
}

export default async function DesignEngineeringPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewDesignEngineering(profile)) redirect("/");
  const projects = await listMyDesignProjects();
  const showingAll = isAdmin(profile);

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
            "linear-gradient(155deg, var(--lb-bg-elev), var(--lb-bg))",
          border: "1px solid var(--lb-border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 320 }}>
          <span
            style={{
              display: "inline-block",
              padding: "4px 12px",
              borderRadius: 20,
              background:
                "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
              color: "var(--lb-accent)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            Stage 1 · The CADuniQ Workflow
          </span>
          <h1
            style={{
              fontSize: "clamp(28px, 3.6vw, 42px)",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            Design &amp; Engineering Projects
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--lb-text-2)",
              margin: "12px 0 0",
              maxWidth: 760,
            }}
          >
            Start a project. Upload your CAD, build the BOM, get AI
            material/process recommendations, attach validation &amp;
            installation notes, then approve. Every step writes to the same
            project record so you can leave and come back.
          </p>
        </div>
        <NewProjectButton />
      </header>

      {/* WORKFLOW LEGEND */}
      <section
        aria-label="Seven-step workflow"
        style={{
          padding: "16px 22px",
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
            margin: "0 0 10px",
          }}
        >
          What happens inside each project
        </h2>
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 8,
            counterReset: "step",
          }}
        >
          {[
            "Upload CAD",
            "Drawing settings",
            "Build BOM",
            "AI material rec.",
            "FEA / CFD notes",
            "Install manual",
            "Approve & export",
          ].map((s, i) => (
            <li
              key={s}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                fontSize: 12.5,
                color: "var(--lb-text)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: "var(--lb-accent)",
                  color: "var(--lb-accent-fg)",
                  fontSize: 11,
                  fontWeight: 800,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* PROJECT LIST */}
      <section
        style={{
          padding: "20px 24px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {showingAll
              ? `All projects (${projects.length})`
              : `Your projects (${projects.length})`}
          </h2>
        </div>
        {projects.length === 0 ? (
          <div
            style={{
              padding: "32px 20px",
              borderRadius: 10,
              border: "1px dashed var(--lb-border)",
              textAlign: "center",
              color: "var(--lb-text-2)",
              fontSize: 14,
            }}
          >
            No projects yet. Click <strong>New project</strong> above to start
            your first one.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {projects.map((p) => {
              const pr = progress({
                cadFilesCount: p.cadFiles.length,
                bomItemsCount: p.bomItems.length,
                hasFeaNotes: p.feaNotes.trim().length > 0,
                hasManualNotes: p.manualNotes.trim().length > 0,
                status: p.status,
              });
              return (
                <li key={p.id}>
                  <Link
                    href={`/design-engineering/projects/${p.id}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      padding: "16px 18px",
                      borderRadius: 12,
                      background: "var(--lb-bg)",
                      border: "1px solid var(--lb-border)",
                      textDecoration: "none",
                      color: "inherit",
                      transition: "border-color 160ms ease",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <h3
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          margin: 0,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {p.name}
                      </h3>
                      {statusBadge(p.status)}
                    </div>
                    {p.niche && (
                      <span
                        style={{ fontSize: 12, color: "var(--lb-text-3)" }}
                      >
                        Niche: {p.niche}
                      </span>
                    )}
                    {p.description && (
                      <p
                        style={{
                          fontSize: 13,
                          lineHeight: 1.5,
                          color: "var(--lb-text-2)",
                          margin: 0,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {p.description}
                      </p>
                    )}
                    <div
                      aria-hidden
                      style={{
                        height: 6,
                        borderRadius: 999,
                        background: "rgba(255,255,255,0.08)",
                        overflow: "hidden",
                        position: "relative",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: `${pr.pct}%`,
                          background:
                            "linear-gradient(90deg, var(--lb-accent), var(--lb-accent-2, #f97316))",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        fontSize: 10.5,
                      }}
                    >
                      {pr.checks.map((c) => (
                        <span
                          key={c.key}
                          style={{
                            padding: "2px 7px",
                            borderRadius: 4,
                            background: c.done
                              ? "rgba(34,197,94,0.16)"
                              : "rgba(120,113,108,0.12)",
                            color: c.done
                              ? "rgb(22,163,74)"
                              : "var(--lb-text-3)",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: 0.6,
                          }}
                        >
                          {c.done ? "✓" : "·"} {c.label}
                        </span>
                      ))}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--lb-text-3)",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <span>
                        {p.cadFiles.length} CAD · {p.bomItems.length} BOM
                      </span>
                      <span>
                        Updated{" "}
                        {new Date(p.updatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
