"use client";

// Stage 1 workflow wizard. Each step is a card with its own controls and
// optimistic local state. Steps save server-side as the user edits — no
// global "Next" button, you can come back to any step at any time. The
// step rail on the left summarises status; the active step shows in the
// middle.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import type {
  DesignBomItem,
  DesignCadFile,
  DesignProject,
} from "@/db/schema";
import {
  addBomItem,
  approveDesignProject,
  attachCadFile,
  autoExtractBomFromCadFile,
  buildProjectManifest,
  deleteDesignProject,
  recommendBomItemMaterial,
  removeBomItem,
  removeCadFile,
  reopenDesignProject,
  updateBomItem,
  updateDesignProjectMeta,
  updateDrawingSettings,
  updateFeaNotes,
  updateManualNotes,
} from "../../actions";
import { isStepFile } from "../../step-parser";

type StepKey =
  | "cad"
  | "drawing"
  | "bom"
  | "material"
  | "fea"
  | "manual"
  | "approval";

const STEPS: Array<{
  key: StepKey;
  number: number;
  title: string;
  blurb: string;
  done: (p: DesignProject) => boolean;
}> = [
  {
    key: "cad",
    number: 1,
    title: "Get the CAD In",
    blurb: "Upload existing CAD (STEP / STL / native) — browser CAD + AI text-to-CAD are coming.",
    done: (p) => p.cadFiles.length > 0,
  },
  {
    key: "drawing",
    number: 2,
    title: "Drawing Settings",
    blurb: "Pick the standard, units, sheet size, scale. AI auto-generates the drawings.",
    done: (p) =>
      !!p.drawingSettings.standard &&
      !!p.drawingSettings.units &&
      !!p.drawingSettings.sheetSize,
  },
  {
    key: "bom",
    number: 3,
    title: "Build the BOM",
    blurb: "Add every part with quantity. Step 4 fills material / process via Claude.",
    done: (p) => p.bomItems.length > 0,
  },
  {
    key: "material",
    number: 4,
    title: "Material & Process",
    blurb: "Per-line: enter your own, or let Claude recommend material + process + cost.",
    done: (p) =>
      p.bomItems.length > 0 &&
      p.bomItems.every((b) => b.material.trim() && b.process.trim()),
  },
  {
    key: "fea",
    number: 5,
    title: "FEA / CFD Validation",
    blurb: "Notes for now — full auto-FEA ships with module 1h.",
    done: (p) => p.feaNotes.trim().length > 0,
  },
  {
    key: "manual",
    number: 6,
    title: "Installation Manual",
    blurb: "Notes for now — full AI-generated 3D / 2D / video manual ships with module 1c.",
    done: (p) => p.manualNotes.trim().length > 0,
  },
  {
    key: "approval",
    number: 7,
    title: "Approve & Export",
    blurb: "E-sign the package and download the JSON manifest of every artifact.",
    done: (p) => p.status === "approved",
  },
];

function safeFileName(name: string) {
  return (
    (name || "file")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "file"
  );
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export default function ProjectWizard({ project }: { project: DesignProject }) {
  const router = useRouter();
  const [activeStep, setActiveStep] = useState<StepKey>(() => {
    // Land on the first incomplete step.
    const incomplete = STEPS.find((s) => !s.done(project));
    return incomplete?.key ?? "approval";
  });

  // Project-meta editor state (held locally + saved on blur).
  const [name, setName] = useState(project.name);
  const [niche, setNiche] = useState(project.niche ?? "");
  const [description, setDescription] = useState(project.description ?? "");

  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  function saveMeta() {
    startTransition(async () => {
      try {
        await updateDesignProjectMeta(project.id, {
          name: name.trim() || project.name,
          niche,
          description,
        });
        ping("Saved");
      } catch (e) {
        ping(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete "${project.name}"? This removes the project record but leaves any uploaded CAD files in blob storage.`,
      )
    )
      return;
    try {
      await deleteDesignProject(project.id);
      router.push("/design-engineering");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <>
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "10px 16px",
            borderRadius: 8,
            background: "rgba(15,23,42,0.95)",
            color: "#fff",
            fontSize: 13,
            zIndex: 80,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          }}
        >
          {toast}
        </div>
      )}

      {/* HERO + META */}
      <header
        style={{
          padding: "20px 24px",
          borderRadius: 14,
          background:
            "linear-gradient(155deg, var(--lb-bg-elev), var(--lb-bg))",
          border: "1px solid var(--lb-border)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <span
              style={{
                display: "inline-block",
                padding: "3px 10px",
                borderRadius: 6,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                fontSize: 10.5,
                fontWeight: 700,
                color: "var(--lb-text-3)",
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Project #{project.id} ·{" "}
              {project.status === "approved" ? "Approved" : "Draft"}
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveMeta}
              style={{
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: "var(--lb-text)",
                background: "transparent",
                border: "none",
                outline: "none",
                width: "100%",
                padding: 0,
              }}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginTop: 10,
              }}
            >
              <input
                type="text"
                value={niche}
                placeholder="Niche (e.g. Indoor Linear Lighting)"
                onChange={(e) => setNiche(e.target.value)}
                onBlur={saveMeta}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text)",
                  fontSize: 12.5,
                }}
              />
              <input
                type="text"
                value={description}
                placeholder="Short description (used as AI context)"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={saveMeta}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text)",
                  fontSize: 12.5,
                }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleDelete}
            style={{
              alignSelf: "flex-start",
              padding: "8px 14px",
              borderRadius: 8,
              background: "transparent",
              color: "rgb(220,38,38)",
              border: "1px solid rgba(220,38,38,0.35)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </header>

      {/* MAIN GRID: rail + active step */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 280px) 1fr",
          gap: 16,
          alignItems: "flex-start",
        }}
        className="lb-project-wizard-grid"
      >
        <StepRail
          steps={STEPS}
          project={project}
          activeStep={activeStep}
          onChange={setActiveStep}
        />
        <StepBody
          step={activeStep}
          project={project}
          ping={ping}
          onMoveToStep={setActiveStep}
        />
      </div>

      {/* Mobile: stack the grid */}
      <style>{`
        @media (max-width: 900px) {
          .lb-project-wizard-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP RAIL — left-side numbered checklist
// ─────────────────────────────────────────────────────────────────────────────

function StepRail({
  steps,
  project,
  activeStep,
  onChange,
}: {
  steps: typeof STEPS;
  project: DesignProject;
  activeStep: StepKey;
  onChange: (k: StepKey) => void;
}) {
  return (
    <nav
      aria-label="Workflow steps"
      style={{
        padding: 12,
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        position: "sticky",
        top: 16,
      }}
    >
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {steps.map((s) => {
          const isActive = s.key === activeStep;
          const done = s.done(project);
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onChange(s.key)}
                aria-current={isActive ? "step" : undefined}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: isActive ? "var(--lb-accent)" : "transparent",
                  color: isActive ? "var(--lb-accent-fg)" : "var(--lb-text)",
                  border: "1px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: 13,
                  transition: "background 140ms ease",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: done
                      ? "rgba(34,197,94,0.85)"
                      : isActive
                        ? "rgba(255,255,255,0.22)"
                        : "var(--lb-bg)",
                    color: done ? "#fff" : isActive ? "#fff" : "var(--lb-text-2)",
                    border: done
                      ? "1px solid rgba(34,197,94,0.85)"
                      : "1px solid var(--lb-border)",
                    fontSize: 11,
                    fontWeight: 800,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {done ? "✓" : s.number}
                </span>
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 600 }}>{s.title}</span>
                  <span
                    style={{
                      fontSize: 11,
                      color: isActive
                        ? "rgba(255,255,255,0.78)"
                        : "var(--lb-text-3)",
                      marginTop: 1,
                    }}
                  >
                    {s.blurb}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP BODY — switches per active step
// ─────────────────────────────────────────────────────────────────────────────

function StepBody({
  step,
  project,
  ping,
  onMoveToStep,
}: {
  step: StepKey;
  project: DesignProject;
  ping: (msg: string) => void;
  onMoveToStep: (k: StepKey) => void;
}) {
  switch (step) {
    case "cad":
      return <StepCad project={project} ping={ping} onNext={() => onMoveToStep("drawing")} />;
    case "drawing":
      return (
        <StepDrawing project={project} ping={ping} onNext={() => onMoveToStep("bom")} />
      );
    case "bom":
      return <StepBom project={project} ping={ping} onNext={() => onMoveToStep("material")} />;
    case "material":
      return (
        <StepMaterial project={project} ping={ping} onNext={() => onMoveToStep("fea")} />
      );
    case "fea":
      return <StepFea project={project} ping={ping} onNext={() => onMoveToStep("manual")} />;
    case "manual":
      return (
        <StepManual project={project} ping={ping} onNext={() => onMoveToStep("approval")} />
      );
    case "approval":
      return <StepApproval project={project} ping={ping} />;
  }
}

function StepCard({
  number,
  title,
  blurb,
  comingSoon,
  children,
  footer,
}: {
  number: number;
  title: string;
  blurb: string;
  comingSoon?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: "22px 26px",
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingBottom: 12,
          borderBottom: "1px solid var(--lb-border)",
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 999,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            fontWeight: 800,
            fontSize: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {number}
        </span>
        <div style={{ flex: 1 }}>
          <h2
            style={{
              fontSize: 17,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--lb-text-3)",
              margin: "2px 0 0",
            }}
          >
            {blurb}
          </p>
        </div>
        {comingSoon && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1,
              padding: "3px 8px",
              borderRadius: 5,
              background: "rgba(234,88,12,0.18)",
              color: "rgb(234,88,12)",
              textTransform: "uppercase",
            }}
          >
            Auto coming soon
          </span>
        )}
      </header>
      {children}
      {footer}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — CAD UPLOAD (functional)
// ─────────────────────────────────────────────────────────────────────────────

function StepCad({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [autoBom, setAutoBom] = useState(true);
  const [extractingPath, setExtractingPath] = useState<string | null>(null);

  async function runAutoExtract(
    blobPathname: string,
    fileName: string,
    mode: "merge" | "replace" = "merge",
  ): Promise<void> {
    setExtractingPath(blobPathname);
    try {
      const r = await autoExtractBomFromCadFile(project.id, blobPathname, {
        mode,
      });
      if (r.ok) {
        router.refresh();
        if (r.added > 0) {
          ping(
            `Auto-BOM from ${fileName}: +${r.added} line${
              r.added === 1 ? "" : "s"
            }${r.skipped ? ` · skipped ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"}` : ""}`,
          );
        } else if (r.skipped > 0) {
          ping(
            `Auto-BOM: every extracted part already exists. ${r.skipped} skipped.`,
          );
        } else {
          ping("Auto-BOM ran but found no parts to add.");
        }
      } else {
        ping(r.error);
      }
    } catch (e) {
      ping(e instanceof Error ? e.message : "Auto-extract failed");
    } finally {
      setExtractingPath(null);
    }
  }

  async function handleFiles(picked: FileList | File[]) {
    const list = Array.from(picked);
    if (list.length === 0) return;
    setUploading(true);
    const stepUploads: Array<{ blobPathname: string; name: string }> = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setUploadStatus(`Uploading ${f.name} (${i + 1}/${list.length})…`);
      try {
        const pathname = `design-engineering/${project.id}/${crypto.randomUUID()}-${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || "application/octet-stream",
        });
        const cad: DesignCadFile = {
          url: blob.url,
          name: f.name,
          size: f.size,
          mime: f.type || null,
          blobPathname: blob.pathname,
        };
        await attachCadFile(project.id, cad);
        if (autoBom && isStepFile({ name: f.name, mime: f.type })) {
          stepUploads.push({ blobPathname: blob.pathname, name: f.name });
        }
      } catch (e) {
        ping(
          `Upload failed for ${f.name}: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    }
    setUploading(false);
    setUploadStatus(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    router.refresh();
    ping(`Uploaded ${list.length} file${list.length === 1 ? "" : "s"}`);

    // Auto-extract BOM from each freshly-uploaded STEP file. Runs after
    // the upload toast so the user sees both events distinctly.
    for (const s of stepUploads) {
      setUploadStatus(`Extracting BOM from ${s.name}…`);
      await runAutoExtract(s.blobPathname, s.name, "merge");
    }
    setUploadStatus(null);
  }

  async function handleRemove(blobPathname: string) {
    try {
      await removeCadFile(project.id, blobPathname);
      router.refresh();
      ping("Removed");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Remove failed");
    }
  }

  return (
    <StepCard
      number={1}
      title="Get the CAD In"
      blurb="Upload existing CAD files. Browser CAD modeller and AI text-to-CAD ship with module 1g."
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        }}
        style={{
          padding: 24,
          borderRadius: 12,
          border: "2px dashed var(--lb-border)",
          background: "var(--lb-bg)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>📥</div>
        <p style={{ fontSize: 14, margin: 0, color: "var(--lb-text)" }}>
          Drop CAD files here or
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".step,.stp,.iges,.igs,.stl,.obj,.glb,.gltf,.3mf,.sldprt,.sldasm,.ipt,.iam,.f3d,.prt,.asm,.catpart,.catproduct,.jt,.x_t,.x_b,application/octet-stream"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
          }}
          disabled={uploading}
          style={{ display: "block", margin: "10px auto 0" }}
        />
        <p
          style={{
            fontSize: 11.5,
            color: "var(--lb-text-3)",
            marginTop: 10,
            marginBottom: 0,
          }}
        >
          STEP · IGES · STL · OBJ · GLB · 3MF · SLDPRT · IPT · F3D · NX · Creo · CATPart · JT · Parasolid — up to 50&nbsp;MB each
        </p>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            fontSize: 12,
            color: "var(--lb-text-2)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={autoBom}
            onChange={(e) => setAutoBom(e.target.checked)}
            style={{ accentColor: "var(--lb-accent)" }}
          />
          Auto-extract BOM from STEP files when uploaded
        </label>
        {uploadStatus && (
          <p
            style={{
              fontSize: 12.5,
              color: "var(--lb-accent)",
              marginTop: 10,
              marginBottom: 0,
            }}
          >
            {uploadStatus}
          </p>
        )}
      </div>

      {project.cadFiles.length > 0 && (
        <div>
          <h3
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
              margin: "0 0 8px",
            }}
          >
            Attached files ({project.cadFiles.length})
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {project.cadFiles.map((f) => (
              <li
                key={f.blobPathname}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                }}
              >
                <span aria-hidden style={{ fontSize: 18 }}>
                  📐
                </span>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flex: 1,
                    color: "var(--lb-text)",
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  {f.name}
                </a>
                <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                  {fmtBytes(f.size)}
                </span>
                {isStepFile({ name: f.name, mime: f.mime }) && (
                  <button
                    type="button"
                    onClick={() => runAutoExtract(f.blobPathname, f.name, "merge")}
                    disabled={extractingPath === f.blobPathname}
                    title="Parse this STEP file and add any new parts to the BOM"
                    style={{
                      padding: "3px 10px",
                      borderRadius: 5,
                      border: "1px solid var(--lb-accent)",
                      background: "var(--lb-accent)",
                      color: "var(--lb-accent-fg)",
                      fontSize: 11,
                      fontWeight: 700,
                      cursor:
                        extractingPath === f.blobPathname
                          ? "not-allowed"
                          : "pointer",
                      opacity: extractingPath === f.blobPathname ? 0.6 : 1,
                    }}
                  >
                    {extractingPath === f.blobPathname
                      ? "Extracting…"
                      : "✨ Auto-BOM"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(f.blobPathname)}
                  aria-label={`Remove ${f.name}`}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 5,
                    border: "1px solid var(--lb-border)",
                    background: "transparent",
                    color: "rgb(220,38,38)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onNext}
          disabled={project.cadFiles.length === 0}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background: project.cadFiles.length === 0 ? "var(--lb-bg)" : "var(--lb-accent)",
            color:
              project.cadFiles.length === 0
                ? "var(--lb-text-3)"
                : "var(--lb-accent-fg)",
            border: "1px solid var(--lb-border)",
            fontSize: 13,
            fontWeight: 700,
            cursor: project.cadFiles.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          Next: Drawing settings →
        </button>
      </div>
    </StepCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — DRAWING SETTINGS (functional)
// ─────────────────────────────────────────────────────────────────────────────

function StepDrawing({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [s, setS] = useState(project.drawingSettings);
  const [busy, setBusy] = useState(false);

  async function persist(patch: Partial<typeof s>) {
    const next = { ...s, ...patch };
    setS(next);
    setBusy(true);
    try {
      await updateDrawingSettings(project.id, patch);
      router.refresh();
    } catch (e) {
      ping(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function Picker<T extends string>({
    label,
    value,
    options,
    onPick,
  }: {
    label: string;
    value: T;
    options: T[];
    onPick: (v: T) => void;
  }) {
    return (
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--lb-text-2)",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          {label}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {options.map((o) => {
            const active = o === value;
            return (
              <button
                key={o}
                type="button"
                onClick={() => onPick(o)}
                disabled={busy}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: active ? "var(--lb-accent)" : "var(--lb-bg)",
                  color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                  border: active
                    ? "1px solid var(--lb-accent)"
                    : "1px solid var(--lb-border)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {o}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <StepCard
      number={2}
      title="Drawing Settings"
      blurb="Pick the standard, units, sheet size and scale. AI will generate the orthographic drawings from your CAD using these defaults."
      comingSoon
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Picker
          label="Drawing standard"
          value={s.standard}
          options={["ANSI Y14.5", "ISO 128", "JIS B 0001", "DIN"]}
          onPick={(v) => persist({ standard: v })}
        />
        <Picker
          label="Units"
          value={s.units}
          options={["mm", "in"]}
          onPick={(v) => persist({ units: v })}
        />
        <Picker
          label="Sheet size"
          value={s.sheetSize}
          options={["A4", "A3", "A2", "A1", "A0", "Letter", "Tabloid"]}
          onPick={(v) => persist({ sheetSize: v })}
        />
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--lb-text-2)",
              letterSpacing: 0.4,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Scale
          </div>
          <input
            type="text"
            value={s.scale}
            onChange={(e) => setS({ ...s, scale: e.target.value })}
            onBlur={(e) => persist({ scale: e.target.value })}
            placeholder="1:1"
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--lb-border)",
              background: "var(--lb-bg)",
              color: "var(--lb-text)",
              fontSize: 13,
              width: "100%",
            }}
          />
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: "rgba(37,99,235,0.10)",
          border: "1px solid rgba(37,99,235,0.30)",
          color: "var(--lb-text-2)",
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--lb-text)" }}>What ships next:</strong>{" "}
        Module 1a will auto-generate the orthographic 2D drawings (front / top /
        right / iso) from your uploaded CAD using these settings, with editable
        dimensions and AI tolerance recommendations.
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onNext}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Next: Build the BOM →
        </button>
      </div>
    </StepCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — BOM EDITOR (functional)
// ─────────────────────────────────────────────────────────────────────────────

function StepBom({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [extractingPath, setExtractingPath] = useState<string | null>(null);

  const stepFiles = useMemo(
    () => project.cadFiles.filter((f) => isStepFile({ name: f.name, mime: f.mime })),
    [project.cadFiles],
  );

  async function runAutoExtract(
    blobPathname: string,
    fileName: string,
    mode: "merge" | "replace",
  ) {
    if (
      mode === "replace" &&
      project.bomItems.length > 0 &&
      !confirm(
        `Replace the current ${project.bomItems.length} BOM line${
          project.bomItems.length === 1 ? "" : "s"
        } with the extracted parts from ${fileName}? Any manual edits + AI recommendations will be lost.`,
      )
    ) {
      return;
    }
    setExtractingPath(blobPathname);
    try {
      const r = await autoExtractBomFromCadFile(project.id, blobPathname, {
        mode,
      });
      if (r.ok) {
        router.refresh();
        if (mode === "replace") {
          ping(
            `Replaced BOM with ${r.added} extracted line${r.added === 1 ? "" : "s"} from ${fileName}.`,
          );
        } else {
          ping(
            r.added > 0
              ? `+${r.added} line${r.added === 1 ? "" : "s"} from ${fileName}${r.skipped ? ` · skipped ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"}` : ""}`
              : `No new parts to add (skipped ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"}).`,
          );
        }
      } else {
        ping(r.error);
      }
    } catch (e) {
      ping(e instanceof Error ? e.message : "Auto-extract failed");
    } finally {
      setExtractingPath(null);
    }
  }

  async function add() {
    setBusy(true);
    try {
      await addBomItem(project.id);
      router.refresh();
    } catch (e) {
      ping(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function patch(
    id: string,
    p: Partial<Omit<DesignBomItem, "id" | "aiRecommendation">>,
  ) {
    try {
      await updateBomItem(project.id, id, p);
      router.refresh();
    } catch (e) {
      ping(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this BOM line?")) return;
    try {
      await removeBomItem(project.id, id);
      router.refresh();
    } catch (e) {
      ping(e instanceof Error ? e.message : "Remove failed");
    }
  }

  return (
    <StepCard
      number={3}
      title="Build the BOM"
      blurb="Each line is one part. Step 4 fills the material / process columns via Claude."
    >
      {stepFiles.length > 0 && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "rgba(124,58,237,0.10)",
            border: "1px solid rgba(124,58,237,0.30)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
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
                fontSize: 18,
                lineHeight: 1,
              }}
              aria-hidden
            >
              ✨
            </span>
            <strong
              style={{
                fontSize: 13.5,
                color: "var(--lb-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Auto-extract BOM from your STEP file{stepFiles.length === 1 ? "" : "s"}
            </strong>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--lb-text-3)",
                marginLeft: "auto",
              }}
            >
              Parses PRODUCT entries + assembly tree
            </span>
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {stepFiles.map((f) => {
              const busyHere = extractingPath === f.blobPathname;
              return (
                <li
                  key={f.blobPathname}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                  }}
                >
                  <span aria-hidden>📐</span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      color: "var(--lb-text)",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      runAutoExtract(f.blobPathname, f.name, "merge")
                    }
                    disabled={busyHere}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--lb-accent)",
                      background: "var(--lb-accent)",
                      color: "var(--lb-accent-fg)",
                      fontSize: 11.5,
                      fontWeight: 700,
                      cursor: busyHere ? "not-allowed" : "pointer",
                      opacity: busyHere ? 0.6 : 1,
                    }}
                  >
                    {busyHere ? "Extracting…" : "Merge into BOM"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      runAutoExtract(f.blobPathname, f.name, "replace")
                    }
                    disabled={busyHere}
                    title="Wipe the current BOM and replace with extracted parts"
                    style={{
                      padding: "5px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--lb-border)",
                      background: "var(--lb-bg-elev)",
                      color: "var(--lb-text-2)",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: busyHere ? "not-allowed" : "pointer",
                    }}
                  >
                    Replace BOM
                  </button>
                </li>
              );
            })}
          </ul>
          <p
            style={{
              margin: 0,
              fontSize: 11.5,
              color: "var(--lb-text-3)",
              lineHeight: 1.5,
            }}
          >
            Quantities are inferred from the assembly tree (NAUO links).
            Material + process are <em>not</em> in the STEP file — fill them
            yourself or use the ✨ Recommend button in Step 4.
          </p>
        </div>
      )}
      {project.bomItems.length === 0 ? (
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            textAlign: "center",
            color: "var(--lb-text-2)",
            fontSize: 13.5,
          }}
        >
          No BOM lines yet. Click <strong>Add line</strong> to start.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--lb-bg)" }}>
                <Th>#</Th>
                <Th>Part name</Th>
                <Th>SKU / code</Th>
                <Th>Description</Th>
                <Th style={{ width: 80, textAlign: "right" }}>Qty</Th>
                <Th>Material</Th>
                <Th>Process</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {project.bomItems.map((item) => (
                <BomRow
                  key={item.id}
                  item={item}
                  onPatch={(p) => patch(item.id, p)}
                  onRemove={() => remove(item.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={add}
          disabled={busy}
          style={{
            padding: "9px 16px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            color: "var(--lb-text)",
            border: "1px solid var(--lb-border)",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          + Add line
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={project.bomItems.length === 0}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background:
              project.bomItems.length === 0 ? "var(--lb-bg)" : "var(--lb-accent)",
            color:
              project.bomItems.length === 0
                ? "var(--lb-text-3)"
                : "var(--lb-accent-fg)",
            border: "1px solid var(--lb-border)",
            fontSize: 13,
            fontWeight: 700,
            cursor: project.bomItems.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          Next: Material &amp; process →
        </button>
      </div>
    </StepCard>
  );
}

function Th({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 8px",
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--lb-text-3)",
        borderBottom: "1px solid var(--lb-border)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        padding: "6px 8px",
        borderBottom: "1px solid var(--lb-border)",
        verticalAlign: "top",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function CellInput({
  value,
  onCommit,
  placeholder,
  type = "text",
  style,
}: {
  value: string | number;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  style?: React.CSSProperties;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => {
    setV(String(value));
  }, [value]);
  return (
    <input
      type={type}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== String(value)) onCommit(v);
      }}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "5px 8px",
        borderRadius: 6,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        color: "var(--lb-text)",
        fontSize: 12.5,
        ...style,
      }}
    />
  );
}

function BomRow({
  item,
  onPatch,
  onRemove,
}: {
  item: DesignBomItem;
  onPatch: (p: Partial<Omit<DesignBomItem, "id" | "aiRecommendation">>) => void;
  onRemove: () => void;
}) {
  return (
    <tr>
      <Td style={{ width: 40 }}>
        <CellInput
          value={item.itemNumber}
          onCommit={(v) => onPatch({ itemNumber: v })}
          style={{ width: 50 }}
        />
      </Td>
      <Td>
        <CellInput
          value={item.partName}
          onCommit={(v) => onPatch({ partName: v })}
          placeholder="Main Frame"
        />
      </Td>
      <Td>
        <CellInput
          value={item.productCode}
          onCommit={(v) => onPatch({ productCode: v })}
          placeholder="MF-001"
        />
      </Td>
      <Td>
        <CellInput
          value={item.description}
          onCommit={(v) => onPatch({ description: v })}
          placeholder="Bolted-on mounting plate, 4x M5 holes"
        />
      </Td>
      <Td style={{ textAlign: "right" }}>
        <CellInput
          value={item.quantity}
          type="number"
          onCommit={(v) => onPatch({ quantity: Number(v) || 1 })}
          style={{ width: 70, textAlign: "right" }}
        />
      </Td>
      <Td>
        <CellInput
          value={item.material}
          onCommit={(v) => onPatch({ material: v })}
          placeholder="—"
        />
      </Td>
      <Td>
        <CellInput
          value={item.process}
          onCommit={(v) => onPatch({ process: v })}
          placeholder="—"
        />
      </Td>
      <Td>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove line"
          style={{
            padding: "3px 8px",
            borderRadius: 5,
            border: "1px solid var(--lb-border)",
            background: "transparent",
            color: "rgb(220,38,38)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </Td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — AI MATERIAL/PROCESS RECOMMENDER (functional via Claude)
// ─────────────────────────────────────────────────────────────────────────────

function StepMaterial({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [budget, setBudget] = useState<string>("");
  const [recommending, setRecommending] = useState<string | null>(null);

  async function recommend(item: DesignBomItem) {
    setRecommending(item.id);
    try {
      const r = await recommendBomItemMaterial({
        projectId: project.id,
        itemId: item.id,
        partName: item.partName,
        description: item.description,
        quantity: item.quantity,
        targetBudgetUsdPerPart: budget ? Number(budget) || null : null,
      });
      if (r.ok) {
        router.refresh();
        ping(`Recommended: ${r.recommendation?.material} · ${r.recommendation?.process}`);
      } else {
        ping(r.error);
      }
    } catch (e) {
      ping(e instanceof Error ? e.message : "Recommend failed");
    } finally {
      setRecommending(null);
    }
  }

  const itemsWithoutDesc = useMemo(
    () =>
      project.bomItems.filter(
        (b) => !b.partName.trim() && !b.description.trim(),
      ),
    [project.bomItems],
  );

  if (project.bomItems.length === 0) {
    return (
      <StepCard
        number={4}
        title="Material & Process"
        blurb="Add BOM lines first, then come back here to assign material + process."
      >
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
          No BOM lines yet. Go to Step 3 to add some.
        </div>
      </StepCard>
    );
  }

  return (
    <StepCard
      number={4}
      title="Material & Process"
      blurb="Claude recommends a specific material grade + process per BOM line. You can also fill them manually in step 3."
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--lb-text-2)",
            whiteSpace: "nowrap",
          }}
        >
          Target budget per part (USD, optional):
        </label>
        <input
          type="number"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="e.g. 40"
          step="0.01"
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13,
            width: 120,
          }}
        />
        <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
          Used as context when Claude picks material + process.
        </span>
      </div>

      {itemsWithoutDesc.length > 0 && (
        <div
          style={{
            fontSize: 12,
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(234,179,8,0.14)",
            color: "rgb(161,98,7)",
            border: "1px solid rgba(234,179,8,0.30)",
          }}
        >
          {itemsWithoutDesc.length} line
          {itemsWithoutDesc.length === 1 ? "" : "s"} have no name/description —
          fill those in step 3 first so Claude has enough context.
        </div>
      )}

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {project.bomItems.map((item) => (
          <li
            key={item.id}
            style={{
              padding: 14,
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
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  #{item.itemNumber} · {item.partName || "(unnamed)"}{" "}
                  {item.productCode && (
                    <span
                      style={{
                        fontWeight: 500,
                        color: "var(--lb-text-3)",
                        fontSize: 12,
                      }}
                    >
                      ({item.productCode})
                    </span>
                  )}
                </div>
                {item.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--lb-text-2)",
                      marginTop: 2,
                    }}
                  >
                    {item.description} · qty {item.quantity}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => recommend(item)}
                disabled={
                  recommending === item.id ||
                  (!item.partName.trim() && !item.description.trim())
                }
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: "var(--lb-accent)",
                  color: "var(--lb-accent-fg)",
                  border: "1px solid var(--lb-accent)",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor:
                    recommending === item.id ||
                    (!item.partName.trim() && !item.description.trim())
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    recommending === item.id ||
                    (!item.partName.trim() && !item.description.trim())
                      ? 0.5
                      : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {recommending === item.id ? "Claude thinking…" : "✨ Recommend"}
              </button>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <Cell
                label="Material"
                value={item.material || "—"}
                tone={item.material ? "set" : "empty"}
              />
              <Cell
                label="Process"
                value={item.process || "—"}
                tone={item.process ? "set" : "empty"}
              />
            </div>
            {item.aiRecommendation && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "rgba(124,58,237,0.10)",
                  border: "1px solid rgba(124,58,237,0.25)",
                  fontSize: 12.5,
                  color: "var(--lb-text-2)",
                  lineHeight: 1.55,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    color: "rgb(124,58,237)",
                    marginBottom: 4,
                  }}
                >
                  Claude rationale · {item.aiRecommendation.model}
                </div>
                <p style={{ margin: 0, color: "var(--lb-text)" }}>
                  {item.aiRecommendation.rationale}
                </p>
                {item.aiRecommendation.estimatedCostUsd && (
                  <p style={{ margin: "6px 0 0", fontWeight: 600 }}>
                    Est. unit cost: $
                    {item.aiRecommendation.estimatedCostUsd.toFixed(2)} USD
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onNext}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Next: Validation notes →
        </button>
      </div>
    </StepCard>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "set" | "empty";
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tone === "empty" ? "var(--lb-text-3)" : "var(--lb-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — FEA NOTES (notes for now; full auto-FEA is module 1h)
// ─────────────────────────────────────────────────────────────────────────────

function StepFea({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(project.feaNotes);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await updateFeaNotes(project.id, notes);
      router.refresh();
      ping("Notes saved");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      number={5}
      title="FEA / CFD Validation"
      blurb="Module 1h auto-meshes the part, infers boundary conditions, and runs structural / thermal / fatigue / CFD. Until then, capture your validation plan and external simulation links here."
      comingSoon
    >
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={save}
        placeholder={`e.g.
• Linear static FEA on main bracket — 6061-T6, 200 N at hole pattern, fixed at base flange.
• CFD on cooling-channel housing — air, 2 m/s inlet, target ΔT ≤ 8 °C.
• Linked Ansys report: https://…
• Pass criteria: FoS ≥ 2.0; max temperature ≤ 85 °C.`}
        rows={10}
        style={{
          padding: 14,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 13.5,
          lineHeight: 1.55,
          fontFamily: "inherit",
          resize: "vertical",
          width: "100%",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onNext}
          disabled={busy}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 13,
            fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Next: Installation manual →
        </button>
      </div>
    </StepCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — INSTALLATION MANUAL NOTES (full AI generator is module 1c)
// ─────────────────────────────────────────────────────────────────────────────

function StepManual({
  project,
  ping,
  onNext,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(project.manualNotes);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await updateManualNotes(project.id, notes);
      router.refresh();
      ping("Notes saved");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      number={6}
      title="Installation Manual"
      blurb="Module 1c will generate an interactive 3D manual, a printable PDF, and a narrated MP4 video — all from your mate-graph + BOM. Until then, capture the step sequence here."
      comingSoon
    >
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={save}
        placeholder={`e.g.
Step 1 — Mount Frame (Part 001) using 4× M5×12 bolts (Part 023). Torque 2.5 Nm.
Step 2 — Insert PCB (Part 005) into the frame slot, secure with retaining clip (Part 024).
Step 3 — Connect power harness (Part 014) per wiring diagram. Cable-tie to bracket.
…`}
        rows={10}
        style={{
          padding: 14,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 13.5,
          lineHeight: 1.55,
          fontFamily: "inherit",
          resize: "vertical",
          width: "100%",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onNext}
          disabled={busy}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 13,
            fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Next: Approve &amp; export →
        </button>
      </div>
    </StepCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — APPROVAL + JSON MANIFEST EXPORT (functional)
// ─────────────────────────────────────────────────────────────────────────────

function StepApproval({
  project,
  ping,
}: {
  project: DesignProject;
  ping: (msg: string) => void;
}) {
  const router = useRouter();
  const [approvalNotes, setApprovalNotes] = useState(project.approvalNotes);
  const [busy, setBusy] = useState(false);
  const isApproved = project.status === "approved";

  async function approve() {
    setBusy(true);
    try {
      await approveDesignProject(project.id, approvalNotes);
      router.refresh();
      ping("Approved");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    if (!confirm("Reopen this project as a draft? You can re-approve it later.")) return;
    setBusy(true);
    try {
      await reopenDesignProject(project.id);
      router.refresh();
      ping("Reopened");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Reopen failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadManifest() {
    try {
      const { filename, content } = await buildProjectManifest(project.id);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      ping("Manifest downloaded");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Export failed");
    }
  }

  const completeness = [
    { label: "CAD uploaded", done: project.cadFiles.length > 0 },
    {
      label: "Drawing settings",
      done:
        !!project.drawingSettings.standard &&
        !!project.drawingSettings.units &&
        !!project.drawingSettings.sheetSize,
    },
    { label: "BOM lines", done: project.bomItems.length > 0 },
    {
      label: "Material/process",
      done:
        project.bomItems.length > 0 &&
        project.bomItems.every((b) => b.material.trim() && b.process.trim()),
    },
    { label: "FEA notes", done: project.feaNotes.trim().length > 0 },
    { label: "Manual notes", done: project.manualNotes.trim().length > 0 },
  ];

  return (
    <StepCard
      number={7}
      title="Approve & Export"
      blurb="Final sign-off + JSON manifest of every artifact for handoff to Stage 2 sourcing."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 8,
        }}
      >
        {completeness.map((c) => (
          <div
            key={c.label}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: c.done
                ? "rgba(34,197,94,0.12)"
                : "rgba(120,113,108,0.10)",
              border: c.done
                ? "1px solid rgba(34,197,94,0.30)"
                : "1px solid var(--lb-border)",
              fontSize: 12.5,
              color: c.done ? "rgb(22,163,74)" : "var(--lb-text-3)",
              fontWeight: 600,
            }}
          >
            {c.done ? "✓" : "○"} {c.label}
          </div>
        ))}
      </div>

      <textarea
        value={approvalNotes}
        onChange={(e) => setApprovalNotes(e.target.value)}
        placeholder="Approval notes — anything the next stage (Stage 2 sourcing) should know. Suppliers see this in the brief."
        rows={4}
        disabled={isApproved}
        style={{
          padding: 14,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 13.5,
          lineHeight: 1.55,
          fontFamily: "inherit",
          resize: "vertical",
          width: "100%",
        }}
      />

      {isApproved && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "rgba(34,197,94,0.14)",
            border: "1px solid rgba(34,197,94,0.30)",
            color: "rgb(22,163,74)",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          ✓ Approved
          {project.approvedAt && (
            <span
              style={{
                fontWeight: 500,
                color: "var(--lb-text-2)",
                marginLeft: 8,
              }}
            >
              {new Date(project.approvedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={downloadManifest}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            color: "var(--lb-text)",
            border: "1px solid var(--lb-border)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ⬇ Download JSON manifest
        </button>
        {isApproved ? (
          <button
            type="button"
            onClick={reopen}
            disabled={busy}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              background: "transparent",
              color: "rgb(220,38,38)",
              border: "1px solid rgba(220,38,38,0.30)",
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Reopen as draft
          </button>
        ) : (
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            style={{
              padding: "10px 22px",
              borderRadius: 8,
              background: "rgb(22,163,74)",
              color: "#fff",
              border: "1px solid rgb(22,163,74)",
              fontSize: 13.5,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              boxShadow: "0 0 0 2px rgba(34,197,94,0.18)",
            }}
          >
            {busy ? "Approving…" : "✓ Approve package"}
          </button>
        )}
      </div>
    </StepCard>
  );
}
