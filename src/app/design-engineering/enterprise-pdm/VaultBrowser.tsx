"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { VaultFile } from "../actions";

// Extension → CAD vendor / family label. Used for the filter pill row and
// per-file badge so the user can grok at a glance whether they're looking
// at a SolidWorks file or a STEP / IGES neutral format.
type Vendor =
  | "STEP / IGES / Neutral"
  | "STL / OBJ / Mesh"
  | "glTF / 3MF"
  | "SolidWorks"
  | "Autodesk Inventor / Fusion"
  | "NX / Creo / CATIA"
  | "Parasolid / JT"
  | "Other";

function vendorFor(name: string, mime: string | null): Vendor {
  const n = name.toLowerCase();
  if (/\.(step|stp|stpx|iges|igs)$/.test(n)) return "STEP / IGES / Neutral";
  if (/\.(stl|obj)$/.test(n)) return "STL / OBJ / Mesh";
  if (/\.(glb|gltf|3mf)$/.test(n)) return "glTF / 3MF";
  if (/\.(sldprt|sldasm|slddrw)$/.test(n)) return "SolidWorks";
  if (/\.(ipt|iam|idw|f3d|fusion)$/.test(n)) return "Autodesk Inventor / Fusion";
  if (/\.(prt|asm|catpart|catproduct)$/.test(n)) return "NX / Creo / CATIA";
  if (/\.(x_t|x_b|jt)$/.test(n)) return "Parasolid / JT";
  if (mime && mime.includes("step")) return "STEP / IGES / Neutral";
  return "Other";
}

const VENDOR_COLOR: Record<Vendor, string> = {
  "STEP / IGES / Neutral": "#2563eb",
  "STL / OBJ / Mesh": "#16a34a",
  "glTF / 3MF": "#0891b2",
  "SolidWorks": "#dc2626",
  "Autodesk Inventor / Fusion": "#ea580c",
  "NX / Creo / CATIA": "#7c3aed",
  "Parasolid / JT": "#db2777",
  Other: "#6b7280",
};

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtRelative(iso: string) {
  const t = new Date(iso).getTime();
  const dh = (Date.now() - t) / (1000 * 60 * 60);
  if (dh < 1) return "just now";
  if (dh < 24) return `${Math.round(dh)}h ago`;
  if (dh < 24 * 30) return `${Math.round(dh / 24)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function VaultBrowser({ files }: { files: VaultFile[] }) {
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<Vendor | "all">("all");
  const [projectStatus, setProjectStatus] = useState<
    "all" | "draft" | "in-review" | "approved"
  >("all");

  const enriched = useMemo(
    () =>
      files.map((f) => ({
        ...f,
        vendor: vendorFor(f.name, f.mime),
      })),
    [files],
  );

  const vendorCounts = useMemo(() => {
    const m = new Map<Vendor, number>();
    for (const f of enriched) m.set(f.vendor, (m.get(f.vendor) ?? 0) + 1);
    return m;
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched.filter((f) => {
      if (vendor !== "all" && f.vendor !== vendor) return false;
      if (projectStatus !== "all" && f.projectStatus !== projectStatus)
        return false;
      if (
        q &&
        !`${f.name} ${f.projectName}`.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [enriched, query, vendor, projectStatus]);

  const totalBytes = filtered.reduce((s, f) => s + f.size, 0);

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {/* HERO */}
      <header
        style={{
          padding: "22px 26px",
          borderRadius: 14,
          background:
            "linear-gradient(155deg, rgba(124,58,237,0.10), var(--lb-bg-elev))",
          border: "1px solid rgba(124,58,237,0.28)",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <span
            style={{
              background: "#7c3aed",
              color: "#fff",
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 1.2,
              padding: "3px 10px",
              borderRadius: 5,
              textTransform: "uppercase",
            }}
          >
            Stage 5i · Enterprise PDM
          </span>
        </div>
        <h1
          style={{
            fontSize: "clamp(26px, 3.2vw, 38px)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          CAD Vault
        </h1>
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
            margin: "10px 0 0",
            maxWidth: 740,
          }}
        >
          Every CAD file across every project in one searchable repository.
          The full enterprise PDM (multi-site replication, ECO/ECN/ECR
          workflows, BOM-aware revision propagation, cross-CAD vault for
          SolidWorks + Inventor + Catia + NX + Creo in a single repo) ships
          with module 5i — this is the functional MVP.
        </p>
      </header>

      {/* STATS */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        <Stat label="Files in vault" value={files.length} />
        <Stat label="Currently showing" value={filtered.length} />
        <Stat label="Total size" value={fmtBytes(totalBytes)} isText />
        <Stat label="Vendor families" value={vendorCounts.size} />
      </section>

      {/* FILTERS */}
      <section
        style={{
          padding: "14px 18px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by filename or project…"
            style={{
              flex: 1,
              minWidth: 220,
              padding: "10px 14px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              fontSize: 13.5,
            }}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(
              ["all", "draft", "in-review", "approved"] as const
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setProjectStatus(s)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background:
                    projectStatus === s ? "var(--lb-accent)" : "var(--lb-bg)",
                  color:
                    projectStatus === s
                      ? "var(--lb-accent-fg)"
                      : "var(--lb-text-2)",
                  border:
                    projectStatus === s
                      ? "1px solid var(--lb-accent)"
                      : "1px solid var(--lb-border)",
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "capitalize",
                  cursor: "pointer",
                }}
              >
                {s === "all" ? "All statuses" : s}
              </button>
            ))}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--lb-text-3)",
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginRight: 4,
            }}
          >
            Vendor family
          </span>
          <VendorPill
            label={`All (${files.length})`}
            active={vendor === "all"}
            color="var(--lb-text-2)"
            onClick={() => setVendor("all")}
          />
          {Array.from(vendorCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([v, c]) => (
              <VendorPill
                key={v}
                label={`${v} (${c})`}
                active={vendor === v}
                color={VENDOR_COLOR[v]}
                onClick={() => setVendor(v)}
              />
            ))}
        </div>
      </section>

      {/* FILE TABLE */}
      <section
        style={{
          padding: "16px 20px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "40px 20px",
              borderRadius: 10,
              border: "1px dashed var(--lb-border)",
              textAlign: "center",
              color: "var(--lb-text-2)",
              fontSize: 14,
            }}
          >
            {files.length === 0
              ? "No CAD files in the vault yet. Upload one inside any project to populate this view."
              : "No files match the current filters."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Project</Th>
                  <Th>Vendor</Th>
                  <Th style={{ textAlign: "right" }}>Size</Th>
                  <Th>Updated</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr
                    key={f.blobPathname}
                    style={{ borderTop: "1px solid var(--lb-border)" }}
                  >
                    <Td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span aria-hidden style={{ fontSize: 16 }}>
                          📐
                        </span>
                        <span style={{ fontWeight: 600 }}>{f.name}</span>
                      </div>
                    </Td>
                    <Td>
                      <Link
                        href={`/design-engineering/projects/${f.projectId}`}
                        style={{
                          color: "var(--lb-accent)",
                          fontWeight: 600,
                          textDecoration: "none",
                        }}
                      >
                        {f.projectName}
                      </Link>
                    </Td>
                    <Td>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 5,
                          background: `${VENDOR_COLOR[f.vendor]}22`,
                          color: VENDOR_COLOR[f.vendor],
                        }}
                      >
                        {f.vendor}
                      </span>
                    </Td>
                    <Td style={{ textAlign: "right", color: "var(--lb-text-2)" }}>
                      {fmtBytes(f.size)}
                    </Td>
                    <Td style={{ color: "var(--lb-text-3)" }}>
                      {fmtRelative(f.uploadedAt)}
                    </Td>
                    <Td>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          padding: "2px 8px",
                          borderRadius: 5,
                          letterSpacing: 0.8,
                          textTransform: "uppercase",
                          background:
                            f.projectStatus === "approved"
                              ? "rgba(34,197,94,0.18)"
                              : f.projectStatus === "in-review"
                                ? "rgba(234,179,8,0.18)"
                                : "rgba(120,113,108,0.16)",
                          color:
                            f.projectStatus === "approved"
                              ? "rgb(22,163,74)"
                              : f.projectStatus === "in-review"
                                ? "rgb(161,98,7)"
                                : "rgb(87,83,78)",
                        }}
                      >
                        {f.projectStatus}
                      </span>
                    </Td>
                    <Td>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: "5px 12px",
                          borderRadius: 6,
                          background: "var(--lb-bg)",
                          border: "1px solid var(--lb-border)",
                          color: "var(--lb-text)",
                          fontSize: 11.5,
                          fontWeight: 600,
                          textDecoration: "none",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ⬇ Download
                      </a>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* COMING SOON ECO PANEL */}
      <section
        style={{
          padding: "18px 22px",
          borderRadius: 14,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            ECO / ECN / ECR workflow
          </h2>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1,
              padding: "2px 8px",
              borderRadius: 5,
              background: "rgba(234,88,12,0.18)",
              color: "rgb(234,88,12)",
              textTransform: "uppercase",
            }}
          >
            Coming soon
          </span>
        </div>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--lb-text-2)",
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          Engineering Change Orders propagate BOM-aware revisions across every
          project that references the changed part. Multi-site vault
          replication keeps remote offices in sync. The cross-CAD vault
          (Stage 5i hard-mode) puts SolidWorks + Inventor + Catia + NX + Creo
          + Onshape files in one repo with consistent revision history.
        </p>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  isText,
}: {
  label: string;
  value: number | string;
  isText?: boolean;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: isText ? 16 : 22,
          fontWeight: 800,
          color: "var(--lb-text)",
          marginTop: 4,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function VendorPill({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: 999,
        background: active ? color : "var(--lb-bg)",
        color: active ? "#fff" : color,
        border: active ? `1px solid ${color}` : `1px solid ${color}55`,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 10px",
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

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: "10px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}
