"use client";

// Single-file client UI for the Nomenclature page. Kept inline because
// every section reads the same standards/parts state and shares the
// same handful of helpers (chip editor, copy-to-clipboard, etc.).
//
// Three tabs:
//   • Hardware       — pick standard, fill template, paste URL, save
//   • Part ID        — generate alphanumeric, classify, save
//   • Database       — paginated list of every generated code, edit
//                       name + description + configurations, delete
//                       (delete frees the unique ID for reuse)

import { useMemo, useState, useTransition } from "react";
import {
  addUserStandard,
  deletePart,
  extractHardwareFromUrlAction,
  saveHardwarePart,
  savePartCode,
  updatePart,
  type PartRow,
  type StandardRow,
} from "./actions";

type ScanResult = {
  scanned: number;
  imported: number;
  skipped: number;
  errors: Array<{ path: string; message: string }>;
} | null;

type Tab = "hardware" | "part" | "database";

export default function NomenclatureGenerator({
  standards: initialStandards,
  parts: initialParts,
  scanResult,
}: {
  standards: StandardRow[];
  parts: PartRow[];
  scanResult: ScanResult;
}) {
  const [tab, setTab] = useState<Tab>("hardware");
  const [standards, setStandards] = useState<StandardRow[]>(initialStandards);
  const [parts, setParts] = useState<PartRow[]>(initialParts);

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
      <Hero scanResult={scanResult} parts={parts} standards={standards} />

      <Tabs tab={tab} setTab={setTab} parts={parts} />

      {tab === "hardware" && (
        <HardwareTab
          standards={standards}
          onAddStandard={(s) => setStandards((prev) => [...prev, s])}
          onSaved={(p) => setParts((prev) => [p, ...prev])}
        />
      )}
      {tab === "part" && (
        <PartIdTab onSaved={(p) => setParts((prev) => [p, ...prev])} />
      )}
      {tab === "database" && (
        <DatabaseTab
          parts={parts}
          onUpdate={(updated) =>
            setParts((prev) =>
              prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
            )
          }
          onDelete={(id) =>
            setParts((prev) => prev.filter((p) => p.id !== id))
          }
        />
      )}
    </div>
  );
}

// ── Hero + tabs ──────────────────────────────────────────────────────────

function Hero({
  scanResult,
  parts,
  standards,
}: {
  scanResult: ScanResult;
  parts: PartRow[];
  standards: StandardRow[];
}) {
  return (
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
            fontSize: "clamp(26px, 3.2vw, 38px)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          Nomenclature Generator
        </h1>
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
            margin: "10px 0 0",
            maxWidth: 760,
          }}
        >
          Generate consistent part codes for hardware and assemblies. The
          hardware tab follows the standards in the OneDrive HARDWARES
          folder; the Part ID tab allocates a unique alphanumeric per
          assembly / configuration / part. Every code is added to the
          inventory automatically.
        </p>
        <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Kpi label="Standards loaded" value={standards.length} />
          <Kpi label="Codes generated" value={parts.length} />
          <Kpi
            label="Free IDs"
            value={`${(36 ** 4 - parts.length).toLocaleString()} of 1.68M`}
          />
        </div>
      </div>
      <a
        href="?rescan=1"
        style={{
          alignSelf: "flex-start",
          padding: "9px 16px",
          fontSize: 13,
          fontWeight: 700,
          borderRadius: 999,
          color: "var(--lb-text)",
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          textDecoration: "none",
        }}
        title="Re-read the NOMENCLATURE_*.txt files from OneDrive"
      >
        Re-scan folder
      </a>
      {scanResult && (
        <div
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 10,
            background: scanResult.errors.length
              ? "rgba(234,88,12,0.10)"
              : "rgba(16,185,129,0.10)",
            border: scanResult.errors.length
              ? "1px solid rgba(234,88,12,0.40)"
              : "1px solid rgba(16,185,129,0.40)",
            color: scanResult.errors.length ? "#ea580c" : "#10b981",
            fontSize: 12.5,
          }}
        >
          Folder scan — {scanResult.imported} imported,{" "}
          {scanResult.skipped} skipped of {scanResult.scanned} found.
          {scanResult.errors.length > 0 && (
            <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
              {scanResult.errors.slice(0, 3).map((e, i) => (
                <li key={i}>
                  <code>{e.path}</code>: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </header>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 14px",
        borderRadius: 10,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        minWidth: 110,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 17, fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function Tabs({
  tab,
  setTab,
  parts,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  parts: PartRow[];
}) {
  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "hardware", label: "Hardware Generator" },
    { id: "part", label: "Part ID Generator" },
    { id: "database", label: "Database", badge: parts.length },
  ];
  return (
    <nav
      style={{
        display: "flex",
        gap: 4,
        padding: 4,
        borderRadius: 12,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        width: "fit-content",
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setTab(t.id)}
          style={{
            padding: "8px 14px",
            fontSize: 13,
            fontWeight: 700,
            borderRadius: 8,
            border: "none",
            background: tab === t.id ? "var(--lb-accent)" : "transparent",
            color:
              tab === t.id ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {t.label}
          {t.badge != null && (
            <span
              style={{
                padding: "1px 7px",
                borderRadius: 999,
                background:
                  tab === t.id
                    ? "rgba(255,255,255,0.18)"
                    : "var(--lb-border)",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

// ── Hardware Generator ───────────────────────────────────────────────────

function HardwareTab({
  standards,
  onAddStandard,
  onSaved,
}: {
  standards: StandardRow[];
  onAddStandard: (s: StandardRow) => void;
  onSaved: (p: PartRow) => void;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string>(
    standards[0]?.slug ?? "",
  );
  const selected = useMemo(
    () => standards.find((s) => s.slug === selectedSlug) ?? null,
    [standards, selectedSlug],
  );

  return (
    <div style={GRID}>
      <section style={PANEL}>
        <h2 style={SECTION_TITLE}>Pick a hardware family</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 8,
            marginBottom: 16,
          }}
        >
          {standards.map((s) => (
            <button
              key={s.slug}
              type="button"
              onClick={() => setSelectedSlug(s.slug)}
              style={{
                padding: "12px 10px",
                borderRadius: 10,
                border:
                  selectedSlug === s.slug
                    ? "1px solid var(--lb-accent)"
                    : "1px solid var(--lb-border)",
                background:
                  selectedSlug === s.slug
                    ? "color-mix(in srgb, var(--lb-accent) 12%, transparent)"
                    : "var(--lb-bg)",
                color: "var(--lb-text)",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: 0.6,
                  color: "var(--lb-accent)",
                  textTransform: "uppercase",
                }}
              >
                {s.classCode}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
                {s.name}
              </div>
              {s.userCreated && (
                <div
                  style={{ fontSize: 10, color: "var(--lb-text-3)", marginTop: 4 }}
                >
                  User-created
                </div>
              )}
            </button>
          ))}
          <NewFamilyButton onAdd={onAddStandard} />
        </div>

        {selected && (
          <HardwareForm standard={selected} onSaved={onSaved} />
        )}
      </section>
    </div>
  );
}

function HardwareForm({
  standard,
  onSaved,
}: {
  standard: StandardRow;
  onSaved: (p: PartRow) => void;
}) {
  const [nomenclature, setNomenclature] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [configurations, setConfigurations] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [aiNotes, setAiNotes] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [extracting, startExtract] = useTransition();
  const [saving, startSave] = useTransition();

  function runExtract() {
    setErr(null);
    setAiNotes(null);
    startExtract(async () => {
      try {
        const r = await extractHardwareFromUrlAction({
          standardId: standard.id,
          url,
        });
        setNomenclature(r.nomenclature);
        if (r.name && !name) setName(r.name);
        setAiNotes(r.notes ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Extraction failed");
      }
    });
  }

  function runSave() {
    setErr(null);
    startSave(async () => {
      try {
        const r = await saveHardwarePart({
          standardId: standard.id,
          nomenclature,
          name: name.trim() || null,
          description: description.trim() || null,
          configurations,
        });
        setGeneratedCode(r.fullCode);
        onSaved({
          id: r.id,
          uniqueId: r.uniqueId,
          kind: "hardware",
          classCode: standard.classCode,
          fullCode: r.fullCode,
          standardName: standard.name,
          name: name.trim() || null,
          description: description.trim() || null,
          configurations,
          inventoryItemId: null,
          createdAt: new Date().toISOString(),
        });
        setNomenclature("");
        setName("");
        setDescription("");
        setConfigurations([]);
        setUrl("");
        setAiNotes(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <details
        style={{
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          borderRadius: 10,
          padding: "10px 14px",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 700,
            color: "var(--lb-text-2)",
          }}
        >
          Show the {standard.name} standard
        </summary>
        <pre
          style={{
            marginTop: 10,
            fontSize: 11.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            color: "var(--lb-text-3)",
          }}
        >
          {standard.specText}
        </pre>
      </details>

      <div style={ROW}>
        <label style={FIELD}>
          <span style={LABEL}>Paste product URL (AI fills below)</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.mcmaster.com/91290A192/"
              style={INPUT}
            />
            <button
              type="button"
              disabled={extracting || !url.trim()}
              onClick={runExtract}
              style={SECONDARY_BTN}
            >
              {extracting ? "Reading…" : "Extract"}
            </button>
          </div>
        </label>
      </div>

      <div style={ROW}>
        <label style={FIELD}>
          <span style={LABEL}>
            Nomenclature ({standard.template})
          </span>
          <input
            value={nomenclature}
            onChange={(e) => setNomenclature(e.target.value)}
            placeholder={standard.template}
            style={{ ...INPUT, fontFamily: "var(--lb-font-mono, monospace)" }}
          />
          {aiNotes && (
            <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 4 }}>
              AI notes: {aiNotes}
            </div>
          )}
        </label>
      </div>

      <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Display name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`e.g. M5 Phillips wood screw, SS`}
            style={INPUT}
          />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Description (optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Free-text notes, spec sheets, vendor SKUs"
            style={INPUT}
          />
        </label>
      </div>

      <ChipEditor
        label="Configurations (optional)"
        chips={configurations}
        setChips={setConfigurations}
      />

      {err && <ErrorBox message={err} />}
      {generatedCode && (
        <SuccessBox code={generatedCode} />
      )}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={runSave}
          disabled={saving || !nomenclature.trim()}
          style={PRIMARY_BTN}
        >
          {saving ? "Saving…" : `Generate ${standard.classCode} code`}
        </button>
      </div>
    </div>
  );
}

function NewFamilyButton({
  onAdd,
}: {
  onAdd: (s: StandardRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [classCode, setClassCode] = useState("");
  const [template, setTemplate] = useState("TYPE-DIA-LONGUEUR-(MATERIAU)");
  const [specText, setSpecText] = useState(
    "TYPE\n? : ???\n\nMATERIAUX\nStainless Steel : SS\n\nEXEMPLES:\n",
  );
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: "12px 10px",
          borderRadius: 10,
          border: "1px dashed var(--lb-border)",
          background: "transparent",
          color: "var(--lb-text-3)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 13,
        }}
      >
        + New family
        <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 4 }}>
          e.g. Cable glands
        </div>
      </button>
    );
  }

  function runSave() {
    setErr(null);
    start(async () => {
      try {
        const r = await addUserStandard({
          name,
          classCode,
          template,
          specText,
        });
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        onAdd({
          id: r.id,
          slug,
          name,
          classCode: classCode.toUpperCase(),
          template,
          specText,
          userCreated: true,
        });
        setOpen(false);
        setName("");
        setClassCode("");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <div
      style={{
        gridColumn: "1 / -1",
        padding: 14,
        borderRadius: 10,
        border: "1px solid var(--lb-accent)",
        background:
          "color-mix(in srgb, var(--lb-accent) 6%, transparent)",
      }}
    >
      <h3 style={{ ...SECTION_TITLE, marginTop: 0 }}>Define a new family</h3>
      <p style={{ fontSize: 12.5, color: "var(--lb-text-3)", margin: "0 0 12px" }}>
        We&apos;ll save it to the database AND write a fresh
        <code> NOMENCLATURE_&lt;NAME&gt;.txt </code>
        into the OneDrive HARDWARES folder so the CAD team sees it.
      </p>
      <div style={{ ...ROW, gridTemplateColumns: "2fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Cable glands"
            style={INPUT}
          />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Class code (2–4 letters)</span>
          <input
            value={classCode}
            onChange={(e) =>
              setClassCode(e.target.value.toUpperCase().slice(0, 4))
            }
            placeholder="CG"
            style={{ ...INPUT, fontFamily: "var(--lb-font-mono, monospace)" }}
          />
        </label>
      </div>
      <label style={FIELD}>
        <span style={LABEL}>Template</span>
        <input
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          style={{ ...INPUT, fontFamily: "var(--lb-font-mono, monospace)" }}
        />
      </label>
      <label style={FIELD}>
        <span style={LABEL}>Standard body</span>
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          rows={8}
          style={{ ...INPUT, fontFamily: "var(--lb-font-mono, monospace)" }}
        />
      </label>
      {err && <ErrorBox message={err} />}
      <div style={{ marginTop: 10, display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setOpen(false)} style={SECONDARY_BTN}>
          Cancel
        </button>
        <button
          type="button"
          onClick={runSave}
          disabled={pending || !name.trim() || !classCode.trim()}
          style={PRIMARY_BTN}
        >
          {pending ? "Saving…" : "Save family"}
        </button>
      </div>
    </div>
  );
}

// ── Part ID Generator ────────────────────────────────────────────────────

function PartIdTab({
  onSaved,
}: {
  onSaved: (p: PartRow) => void;
}) {
  const [classCode, setClassCode] = useState("PART");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [length, setLength] = useState<string>("");
  const [kind, setKind] = useState<"part" | "assembly">("part");
  const [configurations, setConfigurations] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [saving, start] = useTransition();

  function runSave() {
    setErr(null);
    start(async () => {
      try {
        const r = await savePartCode({
          classCode,
          name: name.trim() || null,
          description: description.trim() || null,
          widthMm: width.trim() ? Math.round(Number(width)) : null,
          heightMm: height.trim() ? Math.round(Number(height)) : null,
          lengthMm: length.trim() ? Math.round(Number(length)) : null,
          kind,
          configurations,
        });
        setGeneratedCode(r.fullCode);
        onSaved({
          id: r.id,
          uniqueId: r.uniqueId,
          kind: "part",
          classCode: classCode.toUpperCase(),
          fullCode: r.fullCode,
          standardName: null,
          name: name.trim() || null,
          description: description.trim() || null,
          configurations,
          inventoryItemId: null,
          createdAt: new Date().toISOString(),
        });
        setName("");
        setDescription("");
        setWidth("");
        setHeight("");
        setLength("");
        setConfigurations([]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <section style={PANEL}>
      <h2 style={SECTION_TITLE}>Generate a Part / Assembly ID</h2>
      <p style={{ fontSize: 13, color: "var(--lb-text-3)", marginTop: 0 }}>
        Allocates a fresh 4-character alphanumeric and builds a code like{" "}
        <code>CLS-XXXX-WXXXX-HXXXX-LXXXX-DESCRIPTION</code>. Leave any
        dimension blank to drop it from the code.
      </p>

      <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Class code</span>
          <input
            value={classCode}
            onChange={(e) =>
              setClassCode(e.target.value.toUpperCase().slice(0, 6))
            }
            placeholder="PART / ASSY / CFG"
            style={{ ...INPUT, fontFamily: "var(--lb-font-mono, monospace)" }}
          />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "part" | "assembly")}
            style={INPUT}
          >
            <option value="part">Part / Configuration</option>
            <option value="assembly">Assembly</option>
          </select>
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Display name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Front bracket"
            style={INPUT}
          />
        </label>
      </div>

      <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Width (mm)</span>
          <input
            value={width}
            onChange={(e) =>
              setWidth(e.target.value.replace(/[^0-9.]/g, ""))
            }
            placeholder="0–9999"
            style={INPUT}
          />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Height (mm)</span>
          <input
            value={height}
            onChange={(e) =>
              setHeight(e.target.value.replace(/[^0-9.]/g, ""))
            }
            placeholder="0–9999"
            style={INPUT}
          />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Length (mm)</span>
          <input
            value={length}
            onChange={(e) =>
              setLength(e.target.value.replace(/[^0-9.]/g, ""))
            }
            placeholder="0–9999"
            style={INPUT}
          />
        </label>
      </div>

      <label style={FIELD}>
        <span style={LABEL}>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={INPUT}
          placeholder="Free-form text — appears at the tail of the code"
        />
      </label>

      <ChipEditor
        label="Configurations (optional)"
        chips={configurations}
        setChips={setConfigurations}
      />

      {err && <ErrorBox message={err} />}
      {generatedCode && <SuccessBox code={generatedCode} />}

      <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={runSave}
          disabled={saving}
          style={PRIMARY_BTN}
        >
          {saving ? "Allocating…" : "Generate ID"}
        </button>
      </div>
    </section>
  );
}

// ── Database tab ─────────────────────────────────────────────────────────

function DatabaseTab({
  parts,
  onUpdate,
  onDelete,
}: {
  parts: PartRow[];
  onUpdate: (updated: Partial<PartRow> & { id: number }) => void;
  onDelete: (id: number) => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter(
      (p) =>
        p.fullCode.toLowerCase().includes(q) ||
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.uniqueId.toLowerCase().includes(q),
    );
  }, [parts, filter]);

  return (
    <section style={PANEL}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h2 style={SECTION_TITLE}>
          {parts.length === 0
            ? "No codes yet"
            : `${parts.length} generated code${parts.length === 1 ? "" : "s"}`}
        </h2>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by code, name, description…"
          style={{ ...INPUT, maxWidth: 320 }}
        />
      </div>
      {filtered.length === 0 ? (
        <div
          style={{
            padding: "24px 18px",
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            textAlign: "center",
            color: "var(--lb-text-3)",
            fontSize: 13,
          }}
        >
          Nothing matches.
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((p) => (
            <PartRowItem
              key={p.id}
              part={p}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PartRowItem({
  part,
  onUpdate,
  onDelete,
}: {
  part: PartRow;
  onUpdate: (updated: Partial<PartRow> & { id: number }) => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(part.name ?? "");
  const [description, setDescription] = useState(part.description ?? "");
  const [chips, setChips] = useState<string[]>(part.configurations);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function save() {
    setErr(null);
    start(async () => {
      try {
        await updatePart({
          id: part.id,
          name: name.trim() || null,
          description: description.trim() || null,
          configurations: chips,
        });
        onUpdate({
          id: part.id,
          name: name.trim() || null,
          description: description.trim() || null,
          configurations: chips,
        });
        setEditing(false);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function remove() {
    if (
      !confirm(
        `Delete ${part.fullCode}? This frees the unique ID ${part.uniqueId} and archives the inventory row.`,
      )
    ) {
      return;
    }
    setErr(null);
    start(async () => {
      try {
        await deletePart({ id: part.id });
        onDelete(part.id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <li
      style={{
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg)",
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
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <code
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 0.2,
              color: "var(--lb-text)",
            }}
          >
            {part.fullCode}
          </code>
          <div
            style={{
              marginTop: 4,
              fontSize: 11.5,
              color: "var(--lb-text-3)",
              display: "flex",
              gap: 8,
            }}
          >
            <span>
              {part.kind === "hardware" ? "Hardware" : "Part/Assembly"} · ID{" "}
              <strong>{part.uniqueId}</strong>
            </span>
            {part.standardName && <span>· {part.standardName}</span>}
            <span>· created {new Date(part.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(part.fullCode)}
            style={LINK_BTN}
            title="Copy code to clipboard"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            style={LINK_BTN}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            style={{ ...LINK_BTN, color: "#dc2626" }}
          >
            Delete
          </button>
        </div>
      </div>

      {!editing && (part.name || part.description || part.configurations.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {part.name && (
            <div style={{ fontSize: 13.5 }}>
              <strong>{part.name}</strong>
            </div>
          )}
          {part.description && (
            <div style={{ fontSize: 13, color: "var(--lb-text-2)" }}>
              {part.description}
            </div>
          )}
          {part.configurations.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {part.configurations.map((c, i) => (
                <span key={i} style={CHIP_STYLE}>
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={FIELD}>
            <span style={LABEL}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={INPUT}
            />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={INPUT}
            />
          </label>
          <ChipEditor
            label="Configurations"
            chips={chips}
            setChips={setChips}
          />
          {err && <ErrorBox message={err} />}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={save} disabled={busy} style={PRIMARY_BTN}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Shared building blocks ───────────────────────────────────────────────

function ChipEditor({
  label,
  chips,
  setChips,
}: {
  label: string;
  chips: string[];
  setChips: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (chips.includes(trimmed)) {
      setDraft("");
      return;
    }
    setChips([...chips, trimmed]);
    setDraft("");
  }
  return (
    <label style={FIELD}>
      <span style={LABEL}>{label}</span>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: 8,
          borderRadius: 8,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
        }}
      >
        {chips.map((c, i) => (
          <span
            key={`${c}-${i}`}
            style={{ ...CHIP_STYLE, paddingRight: 6 }}
          >
            {c}
            <button
              type="button"
              onClick={() => setChips(chips.filter((_, j) => j !== i))}
              style={{
                background: "transparent",
                border: "none",
                marginLeft: 4,
                color: "inherit",
                cursor: "pointer",
                fontSize: 13,
              }}
              aria-label={`Remove ${c}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && chips.length) {
              setChips(chips.slice(0, -1));
            }
          }}
          placeholder={chips.length ? "" : "Add a configuration and press Enter"}
          style={{
            flex: 1,
            minWidth: 160,
            padding: 4,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--lb-text)",
            fontSize: 13,
          }}
        />
      </div>
    </label>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        background: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(239,68,68,0.35)",
        color: "#dc2626",
        fontSize: 12.5,
      }}
    >
      {message}
    </div>
  );
}

function SuccessBox({ code }: { code: string }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: "rgba(16,185,129,0.10)",
        border: "1px solid rgba(16,185,129,0.40)",
        color: "#10b981",
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span>
        Code generated: <code style={{ fontWeight: 700 }}>{code}</code> — also
        added to inventory.
      </span>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(code)}
        style={{
          background: "transparent",
          border: "1px solid currentColor",
          color: "inherit",
          padding: "4px 10px",
          borderRadius: 999,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Copy
      </button>
    </div>
  );
}

// ── Styles (kept inline so the page works without a CSS module) ──────────

const GRID: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const PANEL: React.CSSProperties = {
  padding: "20px 22px",
  borderRadius: 14,
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
};
const SECTION_TITLE: React.CSSProperties = {
  margin: "0 0 14px",
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: "-0.01em",
};
const ROW: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 12,
  marginBottom: 12,
};
const FIELD: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const LABEL: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--lb-text-3)",
};
const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  fontSize: 13.5,
  border: "1px solid var(--lb-border)",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  outline: "none",
};
const PRIMARY_BTN: React.CSSProperties = {
  padding: "9px 18px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  color: "#fff",
  border: "none",
  background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
  cursor: "pointer",
  boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
};
const SECONDARY_BTN: React.CSSProperties = {
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 999,
  color: "var(--lb-text)",
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  cursor: "pointer",
};
const LINK_BTN: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid var(--lb-border)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--lb-text-2)",
  cursor: "pointer",
};
const CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: 999,
  background: "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
  color: "var(--lb-accent)",
  fontSize: 12,
  fontWeight: 600,
};
