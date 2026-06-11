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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  addAssemblyChildAction,
  addUserStandard,
  deletePart,
  extractHardwareFromUrlAction,
  getAssemblyTree,
  linkInventoryToSupplierAction,
  listInventoryPickerOptions,
  removeAssemblyChildAction,
  saveHardwarePart,
  savePartCode,
  suggestTemplateAction,
  updatePart,
  type AssemblyTreeNode,
  type Configuration,
  type InventoryPickerRow,
  type PartRow,
  type StandardRow,
  type SupplierOption,
} from "./actions";

// Three fixed classification codes; every generated full-code starts
// with one of these.
const CLASSIFICATIONS: Array<{
  value: "FAB" | "PHS" | "TLG";
  label: string;
}> = [
  { value: "FAB", label: "FAB · Fabricated in-house" },
  { value: "PHS", label: "PHS · Purchased" },
  { value: "TLG", label: "TLG · Tooling" },
];

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
  supplierOptions,
  productOptions,
}: {
  standards: StandardRow[];
  parts: PartRow[];
  scanResult: ScanResult;
  supplierOptions: SupplierOption[];
  productOptions: string[];
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
          productOptions={productOptions}
          onAddStandard={(s) => setStandards((prev) => [...prev, s])}
          onSaved={(p) => setParts((prev) => [p, ...prev])}
        />
      )}
      {tab === "part" && (
        <PartIdTab
          supplierOptions={supplierOptions}
          productOptions={productOptions}
          onSaved={(p) => setParts((prev) => [p, ...prev])}
        />
      )}
      {tab === "database" && (
        <DatabaseTab
          parts={parts}
          supplierOptions={supplierOptions}
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
            value={`${(36 ** 6 - parts.length).toLocaleString()} of 2.18B`}
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
    { id: "part", label: "Part/Assembly ID Generator" },
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
  productOptions,
  onAddStandard,
  onSaved,
}: {
  standards: StandardRow[];
  productOptions: string[];
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
        <p
          style={{
            fontSize: 13,
            color: "var(--lb-text-3)",
            marginTop: 0,
            marginBottom: 14,
          }}
        >
          Hardware code layout:{" "}
          <code>CLS-XXXXXX-P|A-NOMENCLATURE</code>. The nomenclature itself
          follows the family&apos;s standard from the OneDrive HARDWARES
          folder.
        </p>
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
          <HardwareForm
            standard={selected}
            productOptions={productOptions}
            onSaved={onSaved}
          />
        )}
      </section>
    </div>
  );
}

function HardwareForm({
  standard,
  productOptions,
  onSaved,
}: {
  standard: StandardRow;
  productOptions: string[];
  onSaved: (p: PartRow) => void;
}) {
  const [classification, setClassification] = useState<
    "FAB" | "PHS" | "TLG"
  >("PHS");
  const [partOrAssembly, setPartOrAssembly] = useState<"P" | "A">("P");
  const [nomenclature, setNomenclature] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [product, setProduct] = useState("");
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
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
        setNomenclature(r.nomenclature.toUpperCase());
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
          classification,
          partOrAssembly,
          nomenclature,
          name: name.trim() || null,
          description: description.trim() || null,
          product: product.trim() || null,
          configurations,
        });
        setGeneratedCode(r.fullCode);
        onSaved({
          id: r.id,
          uniqueId: r.uniqueId,
          kind: "hardware",
          classCode: classification,
          partOrAssembly,
          fullCode: r.fullCode,
          standardName: standard.name,
          name: name.trim() || null,
          description: description.trim() || null,
          product: product.trim() || null,
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

      <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Class code</span>
          <select
            value={classification}
            onChange={(e) =>
              setClassification(e.target.value as "FAB" | "PHS" | "TLG")
            }
            style={INPUT}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label style={FIELD}>
          <span style={LABEL}>Part or Assembly</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPartOrAssembly("P")}
              style={
                partOrAssembly === "P" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE
              }
            >
              P · Part
            </button>
            <button
              type="button"
              onClick={() => setPartOrAssembly("A")}
              style={
                partOrAssembly === "A" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE
              }
            >
              A · Assembly
            </button>
          </div>
        </label>
      </div>

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
            Nomenclature — uppercase ({standard.template})
          </span>
          <input
            value={nomenclature}
            onChange={(e) => setNomenclature(e.target.value.toUpperCase())}
            placeholder={standard.template}
            style={{
              ...INPUT,
              fontFamily: "var(--lb-font-mono, monospace)",
              textTransform: "uppercase",
            }}
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

      <ProductInput
        value={product}
        onChange={setProduct}
        productOptions={productOptions}
      />

      <ConfigurationsEditor
        label="Configurations (optional)"
        configs={configurations}
        setConfigs={setConfigurations}
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
          {saving
            ? "Saving…"
            : `Generate ${classification}-XXXXXX-${partOrAssembly} code`}
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
  const [suggestUrl, setSuggestUrl] = useState("");
  const [suggesting, startSuggest] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function runSuggest() {
    setErr(null);
    startSuggest(async () => {
      try {
        const r = await suggestTemplateAction({ url: suggestUrl });
        if (r.name && !name) setName(r.name);
        setTemplate(r.template);
        setSpecText(r.specText);
        // classCode in this dialog is the FAMILY abbreviation used
        // inside the nomenclature's TYPE list — leave it for the user
        // to confirm, but seed a guess from the first 2 chars of the
        // family name if blank.
        if (!classCode && r.name) {
          setClassCode(
            r.name
              .replace(/[^A-Za-z]/g, "")
              .slice(0, 2)
              .toUpperCase(),
          );
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Suggestion failed");
      }
    });
  }

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
        Paste a representative product URL below and Claude will draft
        a preliminary template + body for you to review.
      </p>
      <div style={ROW}>
        <label style={FIELD}>
          <span style={LABEL}>Suggest from a product URL (optional)</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={suggestUrl}
              onChange={(e) => setSuggestUrl(e.target.value)}
              placeholder="https://vendor.com/cable-gland-product/"
              style={INPUT}
            />
            <button
              type="button"
              disabled={suggesting || !suggestUrl.trim()}
              onClick={runSuggest}
              style={SECONDARY_BTN}
            >
              {suggesting ? "Drafting…" : "AI draft"}
            </button>
          </div>
        </label>
      </div>
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
          <span style={LABEL}>Family abbreviation (2–4 letters)</span>
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

// ── Part/Assembly ID Generator ──────────────────────────────────────────

function PartIdTab({
  supplierOptions,
  productOptions,
  onSaved,
}: {
  supplierOptions: SupplierOption[];
  productOptions: string[];
  onSaved: (p: PartRow) => void;
}) {
  const [classification, setClassification] = useState<
    "FAB" | "PHS" | "TLG"
  >("FAB");
  const [shape, setShape] = useState<"rect" | "circ">("rect");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [product, setProduct] = useState("");
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [diameter, setDiameter] = useState<string>("");
  const [length, setLength] = useState<string>("");
  const [kind, setKind] = useState<"part" | "assembly">("part");
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [supplierUrl, setSupplierUrl] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [saving, start] = useTransition();

  function runSave() {
    setErr(null);
    start(async () => {
      try {
        const r = await savePartCode({
          classification,
          shape,
          name: name.trim() || null,
          description: description.trim() || null,
          widthMm:
            shape === "rect" && width.trim()
              ? Math.round(Number(width))
              : null,
          heightMm:
            shape === "rect" && height.trim()
              ? Math.round(Number(height))
              : null,
          diameterMm:
            shape === "circ" && diameter.trim()
              ? Math.round(Number(diameter))
              : null,
          lengthMm: length.trim() ? Math.round(Number(length)) : null,
          kind,
          configurations,
          product: product.trim() || null,
          supplierId:
            classification === "PHS" && typeof supplierId === "number"
              ? supplierId
              : null,
          supplierProductUrl:
            classification === "PHS" && supplierUrl.trim()
              ? supplierUrl.trim()
              : null,
        });
        setGeneratedCode(r.fullCode);
        onSaved({
          id: r.id,
          uniqueId: r.uniqueId,
          kind: "part",
          classCode: classification,
          partOrAssembly: kind === "assembly" ? "A" : "P",
          fullCode: r.fullCode,
          standardName: null,
          name: name.trim() || null,
          description: description.trim() || null,
          product: product.trim() || null,
          configurations,
          inventoryItemId: null,
          createdAt: new Date().toISOString(),
        });
        setName("");
        setDescription("");
        setProduct("");
        setWidth("");
        setHeight("");
        setDiameter("");
        setLength("");
        setConfigurations([]);
        setSupplierId("");
        setSupplierUrl("");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <section style={PANEL}>
      <h2 style={SECTION_TITLE}>Generate a Part / Assembly ID</h2>
      <p style={{ fontSize: 13, color: "var(--lb-text-3)", marginTop: 0 }}>
        Allocates a fresh 6-character A-Z + 0-9 ID. Code shape depends on
        the part geometry:
      </p>
      <ul
        style={{
          fontSize: 12.5,
          color: "var(--lb-text-3)",
          margin: "4px 0 14px 18px",
          padding: 0,
        }}
      >
        <li>
          Rectangular: <code>CLS-XXXXXX-WXXXX-HXXXX-LXXXX-DISPLAY_NAME</code>
        </li>
        <li>
          Circular: <code>CLS-XXXXXX-DXXXX-LXXXX-DISPLAY_NAME</code>
        </li>
        <li>
          Leave a dimension blank and it stays as literal{" "}
          <code>WXXXX</code> / <code>HXXXX</code> / <code>LXXXX</code> /{" "}
          <code>DXXXX</code> in the code. All segments are uppercased
          automatically.
        </li>
        <li>
          When class code is <strong>PHS</strong>, picking a supplier
          also writes a row into the supplier catalogue. Skip the
          supplier and you can link it later from{" "}
          <code>/suppliers</code>.
        </li>
      </ul>

      <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr 1fr" }}>
        <label style={FIELD}>
          <span style={LABEL}>Class code</span>
          <select
            value={classification}
            onChange={(e) =>
              setClassification(e.target.value as "FAB" | "PHS" | "TLG")
            }
            style={INPUT}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
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
          <span style={LABEL}>Display name (appears in the code)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Front bracket → FRONT_BRACKET"
            style={INPUT}
          />
        </label>
      </div>

      {classification === "PHS" && (
        <div style={{ ...ROW, gridTemplateColumns: "1fr 2fr" }}>
          <label style={FIELD}>
            <span style={LABEL}>Supplier (catalogue link)</span>
            <select
              value={supplierId === "" ? "" : String(supplierId)}
              onChange={(e) =>
                setSupplierId(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              style={INPUT}
            >
              <option value="">Skip — set later from /suppliers</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.origin ? ` · ${s.origin}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Vendor product URL (optional)</span>
            <input
              value={supplierUrl}
              onChange={(e) => setSupplierUrl(e.target.value)}
              placeholder="https://mcmaster.com/91290A192"
              style={INPUT}
            />
          </label>
        </div>
      )}

      <div style={ROW}>
        <label style={FIELD}>
          <span style={LABEL}>Shape</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setShape("rect")}
              style={shape === "rect" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}
            >
              Rectangular (W · H · L)
            </button>
            <button
              type="button"
              onClick={() => setShape("circ")}
              style={shape === "circ" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}
            >
              Circular (D · L)
            </button>
          </div>
        </label>
      </div>

      {shape === "rect" ? (
        <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr 1fr" }}>
          <label style={FIELD}>
            <span style={LABEL}>Width (mm)</span>
            <input
              value={width}
              onChange={(e) =>
                setWidth(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="blank → XXXX"
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
              placeholder="blank → XXXX"
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
              placeholder="blank → XXXX"
              style={INPUT}
            />
          </label>
        </div>
      ) : (
        <div style={{ ...ROW, gridTemplateColumns: "1fr 1fr" }}>
          <label style={FIELD}>
            <span style={LABEL}>Diameter (mm)</span>
            <input
              value={diameter}
              onChange={(e) =>
                setDiameter(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="blank → XXXX"
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
              placeholder="blank → XXXX"
              style={INPUT}
            />
          </label>
        </div>
      )}

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

      <ProductInput
        value={product}
        onChange={setProduct}
        productOptions={productOptions}
      />

      <ConfigurationsEditor
        label="Configurations (optional)"
        configs={configurations}
        setConfigs={setConfigurations}
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
  supplierOptions,
  onUpdate,
  onDelete,
}: {
  parts: PartRow[];
  supplierOptions: SupplierOption[];
  onUpdate: (updated: Partial<PartRow> & { id: number }) => void;
  onDelete: (id: number) => void;
}) {
  const [filter, setFilter] = useState("");
  const [productView, setProductView] = useState<string>("__all__");
  const [dropError, setDropError] = useState<string | null>(null);
  // After a drag-drop add we want the assembly tree section to refresh.
  // We bump a counter and pass it down as a `refreshKey` prop so the
  // section refetches its tree when the value changes.
  const [refreshKey, setRefreshKey] = useState(0);

  const productList = useMemo(() => {
    const set = new Set<string>();
    let hasNone = false;
    for (const p of parts) {
      const v = (p.product ?? "").trim();
      if (v) set.add(v);
      else hasNone = true;
    }
    return { products: Array.from(set).sort(), hasNone };
  }, [parts]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return parts.filter((p) => {
      if (productView === "__none__") {
        if ((p.product ?? "").trim()) return false;
      } else if (productView !== "__all__") {
        if ((p.product ?? "").trim() !== productView) return false;
      }
      if (!q) return true;
      return (
        p.fullCode.toLowerCase().includes(q) ||
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.uniqueId.toLowerCase().includes(q)
      );
    });
  }, [parts, filter, productView]);

  async function handleDrop(args: {
    draggedItemId: number;
    targetItemId: number;
  }) {
    setDropError(null);
    try {
      await addAssemblyChildAction({
        parentInventoryItemId: args.targetItemId,
        childInventoryItemId: args.draggedItemId,
        quantity: 1,
      });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDropError(e instanceof Error ? e.message : "Drop failed");
    }
  }

  return (
    <section style={PANEL}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h2 style={SECTION_TITLE}>
          {parts.length === 0
            ? "No codes yet"
            : `${filtered.length} of ${parts.length} code${parts.length === 1 ? "" : "s"}`}
        </h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={productView}
            onChange={(e) => setProductView(e.target.value)}
            style={{ ...INPUT, minWidth: 220 }}
            aria-label="Product view"
          >
            <option value="__all__">
              All products ({parts.length})
            </option>
            {productList.hasNone && (
              <option value="__none__">No product set</option>
            )}
            {productList.products.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by code, name, description…"
            style={{ ...INPUT, maxWidth: 320 }}
          />
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--lb-text-3)", margin: "0 0 12px" }}>
        Tip: drag a card onto an assembly card to link it as a child.
        Dropping onto a regular part promotes it to an assembly.
      </p>
      {dropError && (
        <div style={{ marginBottom: 10 }}>
          <ErrorBox message={dropError} />
        </div>
      )}
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
              supplierOptions={supplierOptions}
              refreshKey={refreshKey}
              onDrop={handleDrop}
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
  supplierOptions,
  refreshKey,
  onDrop,
  onUpdate,
  onDelete,
}: {
  part: PartRow;
  supplierOptions: SupplierOption[];
  refreshKey: number;
  onDrop: (args: {
    draggedItemId: number;
    targetItemId: number;
  }) => void;
  onUpdate: (updated: Partial<PartRow> & { id: number }) => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(part.name ?? "");
  const [description, setDescription] = useState(part.description ?? "");
  const [product, setProduct] = useState(part.product ?? "");
  const [chips, setChips] = useState<Configuration[]>(part.configurations);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  function save() {
    setErr(null);
    start(async () => {
      try {
        await updatePart({
          id: part.id,
          name: name.trim() || null,
          description: description.trim() || null,
          product: product.trim() || null,
          configurations: chips,
        });
        onUpdate({
          id: part.id,
          name: name.trim() || null,
          description: description.trim() || null,
          product: product.trim() || null,
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

  const liRef = useRef<HTMLLIElement>(null);
  const canDrag = part.inventoryItemId != null;

  return (
    <li
      ref={liRef}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag || part.inventoryItemId == null) return;
        e.dataTransfer.setData(
          "application/x-lb-inventory-item",
          String(part.inventoryItemId),
        );
        e.dataTransfer.effectAllowed = "link";
        // Use the whole row as the drag image so the entire card
        // visually moves with the cursor rather than just the spot
        // the user grabbed. Offset puts the cursor near the grab
        // point.
        if (liRef.current) {
          const rect = liRef.current.getBoundingClientRect();
          const offsetX = Math.min(40, e.clientX - rect.left);
          const offsetY = Math.min(40, e.clientY - rect.top);
          e.dataTransfer.setDragImage(liRef.current, offsetX, offsetY);
        }
        // Small async flip so the browser captures the drag image
        // before we dim the original.
        requestAnimationFrame(() => setIsDragging(true));
      }}
      onDragEnd={() => setIsDragging(false)}
      onDragOver={(e) => {
        const ok = e.dataTransfer.types.includes(
          "application/x-lb-inventory-item",
        );
        if (!ok || part.inventoryItemId == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when we actually leave the li, not when entering
        // a child element. relatedTarget is null when leaving the
        // window entirely.
        if (
          !e.relatedTarget ||
          !(e.relatedTarget instanceof Node) ||
          !liRef.current?.contains(e.relatedTarget)
        ) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (part.inventoryItemId == null) return;
        const raw = e.dataTransfer.getData(
          "application/x-lb-inventory-item",
        );
        const draggedItemId = Number(raw);
        if (!draggedItemId || draggedItemId === part.inventoryItemId) {
          return;
        }
        onDrop({
          draggedItemId,
          targetItemId: part.inventoryItemId,
        });
      }}
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        border: dragOver
          ? "1px solid var(--lb-accent)"
          : "1px solid var(--lb-border)",
        background: dragOver
          ? "color-mix(in srgb, var(--lb-accent) 8%, var(--lb-bg))"
          : "var(--lb-bg)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: canDrag ? (isDragging ? "grabbing" : "grab") : "default",
        opacity: isDragging ? 0.45 : 1,
        transform: dragOver
          ? "translateY(-1px) scale(1.003)"
          : isDragging
            ? "scale(0.985)"
            : "scale(1)",
        boxShadow: dragOver
          ? "0 8px 24px -8px color-mix(in srgb, var(--lb-accent) 50%, transparent), 0 0 0 4px color-mix(in srgb, var(--lb-accent) 18%, transparent)"
          : isDragging
            ? "0 2px 6px rgba(0,0,0,0.05)"
            : "none",
        transition:
          "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 200ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 160ms ease, border-color 160ms ease, opacity 160ms ease",
        willChange: isDragging ? "transform, opacity" : "auto",
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
        <div style={{ minWidth: 0, display: "flex", alignItems: "flex-start", gap: 10 }}>
          {canDrag && (
            <span
              aria-hidden
              title="Drag to link as a child of another assembly"
              style={{
                display: "inline-flex",
                flexDirection: "column",
                gap: 2,
                color: "var(--lb-text-3)",
                fontSize: 12,
                lineHeight: 1,
                marginTop: 3,
                userSelect: "none",
                opacity: 0.7,
                transition: "opacity 120ms ease",
              }}
            >
              <span>⋮⋮</span>
            </span>
          )}
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
              flexWrap: "wrap",
            }}
          >
            <span>
              {part.kind === "hardware" ? "Hardware" : "Part/Assembly"} · ID{" "}
              <strong>{part.uniqueId}</strong>
            </span>
            {part.standardName && <span>· {part.standardName}</span>}
            {part.product && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 8px",
                  borderRadius: 999,
                  background:
                    "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
                  color: "var(--lb-accent)",
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                {part.product}
              </span>
            )}
            <span>· created {new Date(part.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        </div>
        <div
          style={{ display: "flex", gap: 8 }}
          onMouseDown={(e) => {
            // Stop the li's drag from initiating when the user is
            // pressing a button — we want clicks to work cleanly.
            e.stopPropagation();
          }}
        >
          <button
            type="button"
            draggable={false}
            onClick={() => navigator.clipboard.writeText(part.fullCode)}
            style={LINK_BTN}
            title="Copy code to clipboard"
          >
            Copy
          </button>
          {part.inventoryItemId != null && (
            <button
              type="button"
              draggable={false}
              onClick={() => setLinkPickerOpen((v) => !v)}
              style={LINK_BTN}
              title="Link to a supplier catalogue entry"
            >
              {linkPickerOpen ? "Cancel" : "Link supplier"}
            </button>
          )}
          <button
            type="button"
            draggable={false}
            onClick={() => setEditing((v) => !v)}
            style={LINK_BTN}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            draggable={false}
            onClick={remove}
            disabled={busy}
            style={{ ...LINK_BTN, color: "#dc2626" }}
          >
            Delete
          </button>
        </div>
      </div>

      {linkPickerOpen && part.inventoryItemId != null && (
        <LinkToSupplierRow
          inventoryItemId={part.inventoryItemId}
          supplierOptions={supplierOptions}
          onClose={() => setLinkPickerOpen(false)}
        />
      )}

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
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginTop: 4,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: "var(--lb-text-3)",
                }}
              >
                Configurations
              </div>
              {part.configurations.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "baseline",
                    padding: "4px 0",
                    fontSize: 12.5,
                  }}
                >
                  <span
                    style={{
                      ...CHIP_STYLE,
                      minWidth: 64,
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {c.name}
                  </span>
                  {c.description ? (
                    <span style={{ color: "var(--lb-text-2)" }}>
                      {c.description}
                    </span>
                  ) : (
                    <span style={{ color: "var(--lb-text-3)" }}>
                      No description
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {part.partOrAssembly === "A" && part.inventoryItemId != null && (
        <AssemblyContentsSection
          inventoryItemId={part.inventoryItemId}
          refreshKey={refreshKey}
        />
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
          <label style={FIELD}>
            <span style={LABEL}>Product / line</span>
            <input
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="e.g. Lightline-X"
              style={INPUT}
            />
          </label>
          <ConfigurationsEditor
            label="Configurations"
            configs={chips}
            setConfigs={setChips}
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

// ── Assembly contents (tree + add/remove) ───────────────────────────────

function AssemblyContentsSection({
  inventoryItemId,
  refreshKey,
}: {
  inventoryItemId: number;
  refreshKey: number;
}) {
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<AssemblyTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const t = await getAssemblyTree({ inventoryItemId });
      setTree(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load tree");
    } finally {
      setLoading(false);
    }
  };

  function toggle() {
    if (!open) reload();
    setOpen((v) => !v);
  }

  // When the parent DatabaseTab bumps refreshKey (e.g. after a
  // drag-drop link), reload if we're currently open.
  useEffect(() => {
    if (open) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <div
      style={{
        borderTop: "1px dashed var(--lb-border)",
        paddingTop: 10,
        marginTop: 4,
      }}
    >
      <button
        type="button"
        onClick={toggle}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--lb-accent)",
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? "▾" : "▸"} Assembly contents
        {tree?.buildableFromStock != null && (
          <span
            style={{
              marginLeft: 10,
              padding: "2px 10px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              background:
                tree.buildableFromStock > 0
                  ? "rgba(16,185,129,0.14)"
                  : "rgba(239,68,68,0.12)",
              color:
                tree.buildableFromStock > 0 ? "#10b981" : "#dc2626",
              border: `1px solid ${
                tree.buildableFromStock > 0
                  ? "rgba(16,185,129,0.40)"
                  : "rgba(239,68,68,0.40)"
              }`,
            }}
          >
            Can build {tree.buildableFromStock}
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {loading && (
            <div style={{ fontSize: 12, color: "var(--lb-text-3)" }}>
              Loading tree…
            </div>
          )}
          {err && <ErrorBox message={err} />}
          {tree && (
            <>
              <TreeView node={tree} root />
              <AddChildRow
                parentInventoryItemId={inventoryItemId}
                directChildren={tree.children}
                onAdded={reload}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TreeView({ node, root }: { node: AssemblyTreeNode; root?: boolean }) {
  const isAssembly = node.kind === "assembly";
  const lacks =
    !root &&
    node.quantity > 0 &&
    node.stock + (node.buildableFromStock ?? 0) < node.quantity;
  return (
    <ul
      style={{
        listStyle: "none",
        paddingLeft: root ? 0 : 16,
        margin: 0,
        borderLeft: root ? "none" : "1px solid var(--lb-border)",
      }}
    >
      <li
        style={{
          padding: "6px 8px",
          borderRadius: 8,
          background: root ? "transparent" : "var(--lb-bg-elev)",
          marginLeft: root ? 0 : 6,
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 13 }}>{isAssembly ? "🧩" : "🔧"}</span>
        <code style={{ fontSize: 12.5, fontWeight: 700 }}>{node.code}</code>
        {node.name && (
          <span style={{ fontSize: 12, color: "var(--lb-text-2)" }}>
            · {node.name}
          </span>
        )}
        {!root && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--lb-text-2)",
              padding: "1px 7px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
            }}
          >
            × {node.quantity}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: lacks ? "#dc2626" : "var(--lb-text-3)",
            marginLeft: "auto",
          }}
          title={
            isAssembly
              ? `${node.stock} on hand · ${node.buildableFromStock ?? 0} more buildable`
              : `${node.stock} on hand`
          }
        >
          stock {node.stock}
          {isAssembly && node.buildableFromStock != null && (
            <span style={{ marginLeft: 4, color: "var(--lb-text-3)" }}>
              (+{node.buildableFromStock} buildable)
            </span>
          )}
        </span>
      </li>
      {node.children.map((c) => (
        <TreeView key={`${node.itemId}-${c.itemId}`} node={c} />
      ))}
    </ul>
  );
}

function AddChildRow({
  parentInventoryItemId,
  directChildren,
  onAdded,
}: {
  parentInventoryItemId: number;
  directChildren: AssemblyTreeNode[];
  onAdded: () => void;
}) {
  const [options, setOptions] = useState<InventoryPickerRow[]>([]);
  const [childId, setChildId] = useState<number | "">("");
  const [qty, setQty] = useState<string>("1");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();

  async function loadOptions() {
    setLoading(true);
    try {
      const opts = await listInventoryPickerOptions({
        excludeItemId: parentInventoryItemId,
      });
      setOptions(opts);
    } finally {
      setLoading(false);
    }
  }

  function add() {
    if (typeof childId !== "number") {
      setErr("Pick a child first");
      return;
    }
    setErr(null);
    start(async () => {
      try {
        await addAssemblyChildAction({
          parentInventoryItemId,
          childInventoryItemId: childId,
          quantity: Math.max(1, Math.floor(Number(qty) || 1)),
        });
        setChildId("");
        setQty("1");
        onAdded();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not add child");
      }
    });
  }

  function remove(childInventoryItemId: number) {
    if (!confirm("Remove this child from the assembly?")) return;
    setErr(null);
    start(async () => {
      try {
        await removeAssemblyChildAction({
          parentInventoryItemId,
          childInventoryItemId,
        });
        onAdded();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not remove child");
      }
    });
  }

  return (
    <div
      style={{
        marginTop: 14,
        padding: 12,
        borderRadius: 10,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          Add a child to this assembly
        </span>
        {!options.length && (
          <button
            type="button"
            onClick={loadOptions}
            disabled={loading}
            style={LINK_BTN}
          >
            {loading ? "Loading…" : "Load picker"}
          </button>
        )}
      </div>
      {options.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 80px auto",
            gap: 8,
            alignItems: "center",
          }}
        >
          <select
            value={childId === "" ? "" : String(childId)}
            onChange={(e) =>
              setChildId(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            style={INPUT}
          >
            <option value="">Choose a part or assembly…</option>
            {options.map((o) => (
              <option key={o.itemId} value={o.itemId}>
                {o.kind === "assembly" ? "🧩" : "🔧"} {o.code}
                {o.name ? ` · ${o.name}` : ""} · stock {o.stock}
              </option>
            ))}
          </select>
          <input
            value={qty}
            onChange={(e) =>
              setQty(e.target.value.replace(/[^0-9]/g, ""))
            }
            placeholder="Qty"
            style={INPUT}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending || childId === ""}
            style={PRIMARY_BTN}
          >
            {pending ? "Adding…" : "Add"}
          </button>
        </div>
      )}
      {err && (
        <div style={{ marginTop: 8 }}>
          <ErrorBox message={err} />
        </div>
      )}
      {directChildren.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: "var(--lb-text-3)",
            }}
          >
            Direct children
          </span>
          <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
            {directChildren.map((c) => (
              <li
                key={c.itemId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  fontSize: 12.5,
                }}
              >
                <span>{c.kind === "assembly" ? "🧩" : "🔧"}</span>
                <code style={{ fontWeight: 700 }}>{c.code}</code>
                <span style={{ color: "var(--lb-text-3)" }}>
                  × {c.quantity}
                </span>
                <button
                  type="button"
                  onClick={() => remove(c.itemId)}
                  style={{
                    marginLeft: "auto",
                    fontSize: 11,
                    color: "#dc2626",
                    background: "transparent",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: 999,
                    padding: "2px 8px",
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
    </div>
  );
}

// ── Shared building blocks ───────────────────────────────────────────────

function ConfigurationsEditor({
  label,
  configs,
  setConfigs,
}: {
  label: string;
  configs: Configuration[];
  setConfigs: (next: Configuration[]) => void;
}) {
  function add() {
    setConfigs([...configs, { name: "", description: null }]);
  }
  function updateAt(i: number, patch: Partial<Configuration>) {
    setConfigs(configs.map((c, j) => (i === j ? { ...c, ...patch } : c)));
  }
  function removeAt(i: number) {
    setConfigs(configs.filter((_, j) => j !== i));
  }
  return (
    <label style={FIELD}>
      <span style={LABEL}>{label}</span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 10,
          borderRadius: 8,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
        }}
      >
        {configs.length === 0 && (
          <span
            style={{
              fontSize: 12,
              color: "var(--lb-text-3)",
              padding: "4px 2px",
            }}
          >
            No configurations yet — click <strong>+ Add configuration</strong>{" "}
            to add one. Each gets a name and a description.
          </span>
        )}
        {configs.map((c, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(120px, 1fr) minmax(160px, 2fr) auto",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <input
              value={c.name}
              onChange={(e) =>
                updateAt(i, { name: e.target.value.toUpperCase() })
              }
              placeholder="e.g. ENC"
              aria-label={`Configuration ${i + 1} name`}
              style={{
                ...INPUT,
                fontFamily: "var(--lb-font-mono, monospace)",
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            />
            <input
              value={c.description ?? ""}
              onChange={(e) =>
                updateAt(i, {
                  description: e.target.value ? e.target.value : null,
                })
              }
              placeholder="Description (optional)"
              aria-label={`Configuration ${i + 1} description`}
              style={INPUT}
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label={`Remove configuration ${i + 1}`}
              style={{
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 600,
                background: "transparent",
                border: "1px solid var(--lb-border)",
                borderRadius: 8,
                color: "var(--lb-text-3)",
                cursor: "pointer",
              }}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          style={{
            alignSelf: "flex-start",
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 700,
            background: "transparent",
            border: "1px dashed var(--lb-accent)",
            color: "var(--lb-accent)",
            borderRadius: 999,
            cursor: "pointer",
          }}
        >
          + Add configuration
        </button>
      </div>
    </label>
  );
}

// Free-form product / line input with a datalist of known values so
// users can either pick an existing label or type a brand new one.
function ProductInput({
  value,
  onChange,
  productOptions,
}: {
  value: string;
  onChange: (next: string) => void;
  productOptions: string[];
}) {
  const id = `products-${Math.abs(
    Array.from(productOptions.join("|")).reduce(
      (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
      productOptions.length,
    ),
  )}`;
  return (
    <label style={FIELD}>
      <span style={LABEL}>Product / line (optional)</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={id}
        placeholder="e.g. Lightline-X"
        style={INPUT}
      />
      <datalist id={id}>
        {productOptions.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </label>
  );
}

// Inline supplier-link picker — opens under a row in the database
// table. Choose a supplier, optionally paste a vendor URL, click Link
// and we create a supplier_products row tying the inventory item to
// the supplier's catalogue.
function LinkToSupplierRow({
  inventoryItemId,
  supplierOptions,
  onClose,
}: {
  inventoryItemId: number;
  supplierOptions: SupplierOption[];
  onClose: () => void;
}) {
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function run() {
    if (typeof supplierId !== "number") {
      setErr("Pick a supplier first");
      return;
    }
    setErr(null);
    start(async () => {
      try {
        await linkInventoryToSupplierAction({
          inventoryItemId,
          supplierId,
          productUrl: url.trim() || null,
        });
        setDone(true);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Link failed");
      }
    });
  }

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        border: "1px solid var(--lb-accent)",
        background:
          "color-mix(in srgb, var(--lb-accent) 6%, transparent)",
      }}
    >
      {done ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 13,
            color: "#10b981",
          }}
        >
          <span>Linked to supplier catalogue ✓</span>
          <button type="button" onClick={onClose} style={LINK_BTN}>
            Close
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto",
            gap: 8,
            alignItems: "center",
          }}
        >
          <select
            value={supplierId === "" ? "" : String(supplierId)}
            onChange={(e) =>
              setSupplierId(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            style={INPUT}
          >
            <option value="">Pick a supplier…</option>
            {supplierOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.origin ? ` · ${s.origin}` : ""}
              </option>
            ))}
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Vendor URL (optional)"
            style={INPUT}
          />
          <button
            type="button"
            onClick={run}
            disabled={pending || supplierId === ""}
            style={PRIMARY_BTN}
          >
            {pending ? "Linking…" : "Link"}
          </button>
        </div>
      )}
      {err && (
        <div style={{ marginTop: 8 }}>
          <ErrorBox message={err} />
        </div>
      )}
    </div>
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
const TOGGLE_ACTIVE: React.CSSProperties = {
  flex: 1,
  padding: "9px 14px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 8,
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  border: "1px solid var(--lb-accent)",
  cursor: "pointer",
};
const TOGGLE_INACTIVE: React.CSSProperties = {
  flex: 1,
  padding: "9px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text-2)",
  border: "1px solid var(--lb-border)",
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
