"use client";

// OrdersTab — the RFQ → quote → PO workflow centre. Has three modes:
//   1. list   — every RFQ with status / quote-count / project info
//   2. create — multi-line RFQ wizard (mirrors the buyer's Excel template)
//   3. detail — single RFQ: items, recipients (with magic-link URLs to copy),
//               side-by-side quote comparison with auto-recommendation,
//               award button, generated PO chips
//
// Buyer can only one mode at a time. Mode switches via local state — no URL
// routing yet (keeps the tab self-contained inside the ERP wrapper).

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Supplier, SupplierContact } from "@/db/schema";
import { upload } from "@vercel/blob/client";
import {
  awardRfq,
  createRfq,
  deleteRfq,
  deleteRfqRecipient,
  extendRfqRecipientToken,
  getRfqDetail,
  inviteSupplierBatchToRfq,
  listRfqs,
  reissueRfqRecipientToken,
  revokeRfqRecipient,
  type RfqDetailPayload,
  type RfqItemInput,
  type RfqListRow,
} from "./rfq-actions";
import { parseRfqItemsFromUpload } from "./rfq-extract-actions";
import { parseIfcUpload } from "./ifc-actions";
import { renderIfcMultipart } from "./ifc-render";
import {
  COMPARE_WEIGHTS,
  CURRENCY_OPTIONS,
  PO_STATUS_META,
  QUOTE_STATUS_META,
  RFQ_STAGE_META,
  RFQ_STATUS_META,
  TRANSPORT_MODE_META,
  TRANSPORT_MODE_ORDER,
  fmtMoney,
} from "./_orders-constants";
import IncotermSelect from "./IncotermSelect";
import RfqEmailDraftDialog from "./RfqEmailDraftDialog";
import ProcurementReviewQueue from "./ProcurementReviewQueue";

type FullSupplier = Supplier & {
  isStarred?: boolean;
  // Optional — passed from /suppliers/page.tsx so the picker can show every
  // known contact email per company and let the buyer multi-select.
  contacts?: SupplierContact[];
};

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "detail"; rfqId: number };

export default function OrdersTab({
  suppliers,
  canEdit,
}: {
  suppliers: FullSupplier[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [rfqs, setRfqs] = useState<RfqListRow[] | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  function ping(msg: string, err?: boolean) {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 2800);
  }

  // Eager-load the list when the user first opens the tab.
  useEffect(() => {
    if (rfqs !== null) return;
    setLoading(true);
    listRfqs()
      .then((r) => setRfqs(r))
      .catch((e) => ping(e instanceof Error ? e.message : "Load failed", true))
      .finally(() => setLoading(false));
  }, [rfqs]);

  function refresh() {
    setLoading(true);
    listRfqs()
      .then((r) => setRfqs(r))
      .catch((e) => ping(e instanceof Error ? e.message : "Load failed", true))
      .finally(() => setLoading(false));
    router.refresh();
  }

  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "10px 16px",
            borderRadius: 8,
            background: toast.err ? "#dc2626" : "rgba(15,23,42,0.95)",
            color: "#fff",
            fontSize: 13,
            zIndex: 80,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          }}
        >
          {toast.msg}
        </div>
      )}

      {mode.kind === "list" && (
        <ListView
          rfqs={rfqs ?? []}
          loading={loading}
          canEdit={canEdit}
          onCreate={() => setMode({ kind: "create" })}
          onOpen={(id) => setMode({ kind: "detail", rfqId: id })}
          onDelete={async (id) => {
            if (!confirm("Delete this RFQ and all associated quotes? Cannot be undone.")) return;
            try {
              await deleteRfq(id);
              ping("RFQ deleted");
              refresh();
            } catch (e) {
              ping(e instanceof Error ? e.message : "Delete failed", true);
            }
          }}
        />
      )}

      {mode.kind === "create" && (
        <CreateView
          canEdit={canEdit}
          suppliers={suppliers}
          onCancel={() => setMode({ kind: "list" })}
          onCreated={(id) => {
            ping("RFQ created");
            setMode({ kind: "detail", rfqId: id });
            refresh();
          }}
          ping={ping}
        />
      )}

      {mode.kind === "detail" && (
        <DetailView
          rfqId={mode.rfqId}
          suppliers={suppliers}
          canEdit={canEdit}
          onBack={() => {
            setMode({ kind: "list" });
            refresh();
          }}
          ping={ping}
          refresh={refresh}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST VIEW
// ─────────────────────────────────────────────────────────────────────────────

function ListView({
  rfqs,
  loading,
  canEdit,
  onCreate,
  onOpen,
  onDelete,
}: {
  rfqs: RfqListRow[];
  loading: boolean;
  canEdit: boolean;
  onCreate: () => void;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  // Project filter + free-text search. "all" = show every project; any other
  // value = restrict to that exact projectNum. Search is case-insensitive
  // and matches against project number, project name, RFQ number, or niche.
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  // Procurement-review queue modal. Open from the header so Imen can pick
  // up pending drafts without leaving the Orders tab.
  const [procurementOpen, setProcurementOpen] = useState(false);

  const projectOptions = useMemo(() => {
    const seen = new Map<string, { num: string; name: string | null; count: number }>();
    for (const r of rfqs) {
      const key = r.projectNum;
      const existing = seen.get(key);
      if (existing) existing.count += 1;
      else seen.set(key, { num: r.projectNum, name: r.projectName, count: 1 });
    }
    return Array.from(seen.values()).sort((a, b) => a.num.localeCompare(b.num));
  }, [rfqs]);

  const filteredRfqs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rfqs.filter((r) => {
      if (projectFilter !== "all" && r.projectNum !== projectFilter) return false;
      if (!q) return true;
      const hay = [r.projectNum, r.projectName ?? "", r.rfqNumber, r.niche ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rfqs, projectFilter, search]);

  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "clamp(22px, 2.6vw, 28px)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            Orders — RFQ & PO
          </h1>
          <p style={{ fontSize: 13, color: "var(--lb-text-2)", margin: "6px 0 0", maxWidth: 720 }}>
            One workflow from RFQ to PO. Create an RFQ, invite suppliers (or just one if you're committed), let them submit quotes via the vendor portal, compare side-by-side, award, and auto-generate the PO. Every step pings the team.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canEdit && (
            <button
              type="button"
              onClick={() => setProcurementOpen(true)}
              style={{
                ...btnPrimary,
                background: "var(--lb-bg-elev)",
                color: "var(--lb-text)",
                border: "1px solid var(--lb-border)",
              }}
              title="Review RFQ emails routed through procurement for approval"
            >
              ⌛ Procurement review
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onCreate}
              style={btnPrimary}
            >
              + New RFQ
            </button>
          )}
        </div>
      </header>
      <ProcurementReviewQueue
        open={procurementOpen}
        onClose={() => setProcurementOpen(false)}
      />

      <section
        style={{
          padding: 16,
          borderRadius: 12,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* Project filter + search bar */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              color: "var(--lb-text)",
              border: "1px solid var(--lb-border)",
              fontSize: 12.5,
              fontWeight: 600,
              minWidth: 180,
            }}
          >
            <option value="all">All projects ({rfqs.length})</option>
            {projectOptions.map((p) => (
              <option key={p.num} value={p.num}>
                {p.name ? `${p.num} · ${p.name}` : p.num} ({p.count})
              </option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search project, RFQ #, niche…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 200,
              padding: "8px 14px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              color: "var(--lb-text)",
              border: "1px solid var(--lb-border)",
              fontSize: 13,
            }}
          />
          {(projectFilter !== "all" || search) && (
            <button
              type="button"
              onClick={() => { setProjectFilter("all"); setSearch(""); }}
              style={btnGhost}
            >
              Clear filters
            </button>
          )}
          <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
            Showing {filteredRfqs.length} of {rfqs.length}
          </span>
        </div>
        {loading ? (
          <Empty>Loading…</Empty>
        ) : rfqs.length === 0 ? (
          <Empty>No RFQs yet. Click <b>+ New RFQ</b> to create your first one.</Empty>
        ) : filteredRfqs.length === 0 ? (
          <Empty>No RFQs match the current filter.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <Th>RFQ #</Th>
                  <Th>Project</Th>
                  <Th>Niche</Th>
                  <Th>Stage</Th>
                  <Th>Status</Th>
                  <Th>Transport</Th>
                  <Th style={{ textAlign: "right" }}>Items</Th>
                  <Th style={{ textAlign: "right" }}>Invited</Th>
                  <Th style={{ textAlign: "right" }}>Quotes</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filteredRfqs.map((r) => {
                  const st = RFQ_STATUS_META[r.status];
                  const sg = RFQ_STAGE_META[r.stage];
                  const tm = TRANSPORT_MODE_META[r.transportMode];
                  return (
                    <tr
                      key={r.id}
                      style={{ borderTop: "1px solid var(--lb-border)", cursor: "pointer" }}
                      onClick={() => onOpen(r.id)}
                    >
                      <Td><strong>{r.rfqNumber}</strong></Td>
                      <Td>
                        <div style={{ fontWeight: 600 }}>{r.projectName ?? "—"}</div>
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{r.projectNum}</div>
                      </Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>{r.niche ?? "—"}</Td>
                      <Td><Pill label={sg.label} color={sg.color} /></Td>
                      <Td><Pill label={st.label} color={st.color} /></Td>
                      <Td style={{ color: "var(--lb-text-2)" }}>
                        {tm.icon} {tm.label}
                      </Td>
                      <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.itemCount}</Td>
                      <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.recipientCount}</Td>
                      <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.quoteCount}</Td>
                      <Td style={{ color: "var(--lb-text-3)" }}>
                        {new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}
                            style={miniBtnStyle("#dc2626")}
                          >
                            ✕
                          </button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE VIEW — wizard-ish single form with editable line items
// ─────────────────────────────────────────────────────────────────────────────

function CreateView({
  canEdit,
  suppliers,
  onCancel,
  onCreated,
  ping,
}: {
  canEdit: boolean;
  suppliers: FullSupplier[];
  onCancel: () => void;
  onCreated: (id: number) => void;
  ping: (msg: string, err?: boolean) => void;
}) {
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [projectNum, setProjectNum] = useState("");
  const [projectName, setProjectName] = useState("");
  const [niche, setNiche] = useState("");
  const [stage, setStage] = useState<"selection" | "committed">("selection");
  const [currency, setCurrency] = useState("USD");
  const [incoterms, setIncoterms] = useState("FOB");
  const [transport, setTransport] = useState<keyof typeof TRANSPORT_MODE_META>("any");
  const [deadline, setDeadline] = useState("");
  const [notes, setNotes] = useState("");

  const [items, setItems] = useState<RfqItemInput[]>([
    { clientRef: "", description: "", qty: 1, securityStock: 0 },
  ]);

  // Suppliers staged to receive the RFQ. Each entry is either an existing
  // supplier (supplierId set) or a brand-new email-only invite.
  const [stagedSuppliers, setStagedSuppliers] = useState<StagedSupplier[]>([]);

  // AI auto-fill state — buyer uploads an existing RFQ template (Excel
  // or PDF) and Claude extracts project info + line items into the form.
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  // Progress bar — phase + percentage + the human-readable status line.
  // null while idle; populated for the whole upload → parse → render → upload
  // pipeline so the user always sees how far along they are.
  const [progress, setProgress] = useState<{
    phase: "uploading" | "parsing" | "rendering" | "uploading-thumb";
    pct: number;
    message: string;
  } | null>(null);
  // AbortController shared across the entire AutoFill pipeline. The user
  // can hit Cancel mid-upload / mid-parse / mid-render and we'll bail at
  // the next checkpoint.
  const cancelTokenRef = useRef<AbortController | null>(null);
  function cancelAutoFill() {
    cancelTokenRef.current?.abort();
    setProgress(null);
    setExtracting(false);
    setExtractMsg("Cancelled.");
  }
  async function handleAutoFill(file: File) {
    // Fresh cancel token per run; the previous one (if any) is replaced
    // here so cancelAutoFill() always aborts the LATEST run.
    cancelTokenRef.current = new AbortController();
    setExtracting(true);
    setExtractMsg(null);
    setProgress({ phase: "uploading", pct: 0, message: "Starting upload…" });
    try {
      const isIfc = /\.ifc$/i.test(file.name);
      const pathname = `ai-temp/rfq-extract/${crypto.randomUUID()}-${safeAiName(file.name)}`;
      // Browsers don't agree on an IFC MIME — Chrome sends "" or
      // "application/octet-stream" via the file picker. Pin the upload to
      // octet-stream so the blob route's allowed-list always matches.
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: isIfc ? "application/octet-stream" : (file.type || undefined),
        onUploadProgress: (e) => {
          // Source-file upload counts as the first 30% of the overall
          // progress bar — the IFC parse + render still ahead of us.
          if (cancelTokenRef.current?.signal.aborted) return;
          setProgress({
            phase: "uploading",
            pct: Math.round((e.percentage ?? 0) * 0.3),
            message: `Uploading ${file.name}…`,
          });
        },
      });

      if (cancelTokenRef.current?.signal.aborted) throw new Error("Cancelled");

      if (isIfc) {
        // IFC path — parse the bill of parts server-side, then render the
        // isometric thumbnail client-side: ONE whole-assembly PNG plus
        // one per-part PNG so every inventory card has its own picture.
        setProgress({ phase: "parsing", pct: 30, message: "Parsing IFC… (server-side, ~5-20s)" });
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = await parseIfcUpload({ url: blob.url, fileName: file.name });
        if (cancelTokenRef.current?.signal.aborted) throw new Error("Cancelled");

        // Render WHOLE-assembly + per-part isometric PNGs in one model
        // load. Each group keyed by partNumber (or "__assembly__" for the
        // overview) → Blob. Failures inside renderIfcMultipart for a
        // single group are non-fatal — the card just won't have a thumb.
        const ASSEMBLY_KEY = "__assembly__";
        const renderGroups = [
          { key: ASSEMBLY_KEY }, // whole IFC
          ...parsed.parts.map((p) => ({
            key: p.partNumber,
            expressIds: p.expressIds,
          })),
        ];
        const pngBlobs = new Map<string, Blob>();
        try {
          setProgress({ phase: "rendering", pct: 40, message: `Rendering isometric views (1/${renderGroups.length})…` });
          const blobs = await renderIfcMultipart({
            bytes,
            size: 800,
            groups: renderGroups,
            onProgress: (key, done, total) => {
              if (cancelTokenRef.current?.signal.aborted) return;
              setProgress({
                phase: "rendering",
                pct: 40 + Math.round((done / total) * 30),
                message: `Rendering isometric views (${done}/${total})…`,
              });
            },
          });
          for (const [k, v] of blobs) pngBlobs.set(k, v);
        } catch (e) {
          if (cancelTokenRef.current?.signal.aborted) throw e;
          console.warn("[ifc] render failed:", e);
        }
        if (cancelTokenRef.current?.signal.aborted) throw new Error("Cancelled");

        // Upload each rendered PNG. Use Promise.all so 13 uploads run in
        // parallel (Vercel Blob handles concurrent uploads fine).
        setProgress({ phase: "uploading-thumb", pct: 75, message: `Uploading ${pngBlobs.size} isometric thumbnail${pngBlobs.size === 1 ? "" : "s"}…` });
        const uploadedThumbs = new Map<string, { url: string; pathname: string }>();
        await Promise.all(
          Array.from(pngBlobs.entries()).map(async ([key, pngBlob]) => {
            try {
              const thumbPath = `ai-temp/ifc-thumbs/${crypto.randomUUID()}.png`;
              const up = await upload(thumbPath, pngBlob, {
                access: "public",
                handleUploadUrl: "/api/blob/upload",
                contentType: "image/png",
              });
              uploadedThumbs.set(key, { url: up.url, pathname: up.pathname });
            } catch (e) {
              console.warn(`[ifc] thumb upload failed for "${key}":`, e);
            }
          }),
        );
        if (cancelTokenRef.current?.signal.aborted) throw new Error("Cancelled");

        const assemblyThumb = uploadedThumbs.get(ASSEMBLY_KEY);
        const assemblyThumbUrl = assemblyThumb?.url;
        const assemblyThumbPath = assemblyThumb?.pathname;

        // If the file is an assembly, mint an inventory code for it now
        // (client-side via a placeholder ref). The server uses the same
        // ref to link parts under it. The server then dedupes by IFC
        // assembly name so re-uploading the SAME file goes to the SAME
        // inventory row instead of creating fresh assemblies each time.
        const assemblyRef = parsed.isAssembly
          ? `LB-ASSY-${Date.now().toString(36).toUpperCase()}`
          : undefined;

        const newItems: RfqItemInput[] = parsed.parts.map((p) => {
          const partThumb = uploadedThumbs.get(p.partNumber);
          // Fall back to the whole-assembly PNG if the part-specific render
          // failed — better a generic picture than no picture at all.
          const thumbUrl = partThumb?.url ?? assemblyThumbUrl;
          const thumbPath = partThumb?.pathname ?? assemblyThumbPath;
          return {
            productCode: p.partNumber,
            description: p.description?.trim() || p.partNumber,
            qty: Math.max(1, p.qty),
            securityStock: Math.max(0, Math.round(p.qty * 0.25)),
            specifications: undefined,
            lightbaseRef: undefined,
            weightG: p.weightG,
            surfaceAreaMm2: p.surfaceAreaMm2,
            volumeMm3: p.volumeMm3,
            material: p.material,
            densityGCm3: p.densityGCm3,
            // Per-part thumbnail for THIS line's inventory card.
            thumbnailUrl: thumbUrl,
            thumbnailPathname: thumbPath,
            ifcSourceUrl: blob.url,
            ifcSourceName: file.name,
            assemblyLightbaseRef: assemblyRef,
            ifcAssemblyName: parsed.assemblyName ?? undefined,
            // Whole-assembly thumbnail — same on every line so the server
            // can attach it to the parent assembly's inventory row.
            assemblyThumbnailUrl: assemblyThumbUrl,
            assemblyThumbnailPathname: assemblyThumbPath,
            // Attach the per-part render to the line's Product Photos so
            // the printed RFQ shows a picture of THIS screw / lens /
            // bracket — not the whole assembly on every row.
            attachments: thumbUrl
              ? [{
                  kind: "photo",
                  name: `${p.partNumber} (isometric)`,
                  url: thumbUrl,
                  blobPathname: thumbPath,
                  contentType: "image/png",
                }]
              : undefined,
          };
        });

        if (newItems.length > 0) setItems(newItems);
        if (!projectName.trim() && parsed.assemblyName) setProjectName(parsed.assemblyName);
        const summary = parsed.isAssembly
          ? `assembly "${parsed.assemblyName ?? "unnamed"}" with ${newItems.length} unique part${newItems.length === 1 ? "" : "s"}`
          : `${newItems.length} part${newItems.length === 1 ? "" : "s"}`;
        const warn = parsed.warnings.length > 0 ? ` · ⚠ ${parsed.warnings.join(" / ")}` : "";
        setExtractMsg(`✓ IFC parsed: ${summary}${warn}. Review and edit below before saving.`);
        return;
      }

      // Excel / PDF path — original AI extractor.
      const parsed = await parseRfqItemsFromUpload({ url: blob.url, fileName: file.name });
      // Merge into the form — only overwrite blank fields so the user's
      // typing isn't clobbered.
      if (!projectNum.trim() && parsed.projectNum) setProjectNum(parsed.projectNum);
      if (!projectName.trim() && parsed.projectName) setProjectName(parsed.projectName);
      if (!niche.trim() && parsed.niche) setNiche(parsed.niche);
      if (parsed.targetCurrency) setCurrency(parsed.targetCurrency);
      if (parsed.incoterms) setIncoterms(parsed.incoterms);
      if (parsed.transportMode) setTransport(parsed.transportMode);
      if (!notes.trim() && parsed.notes) setNotes(parsed.notes);
      if (parsed.items.length > 0) setItems(parsed.items);
      setExtractMsg(
        `✓ Auto-filled ${parsed.items.length} line item${parsed.items.length === 1 ? "" : "s"}. Review and edit below before saving.`,
      );
    } catch (err) {
      // Cancellation is normal — surface it quietly, don't shout "failed".
      if (cancelTokenRef.current?.signal.aborted || (err instanceof Error && err.message === "Cancelled")) {
        setExtractMsg("Cancelled.");
      } else {
        setExtractMsg(
          `Auto-fill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      setExtracting(false);
      setProgress(null);
    }
  }

  function addLine() {
    setItems((s) => [...s, { clientRef: "", description: "", qty: 1, securityStock: 0 }]);
  }
  function removeLine(i: number) {
    setItems((s) => s.filter((_, idx) => idx !== i));
  }
  function updateLine(i: number, patch: Partial<RfqItemInput>) {
    setItems((s) => s.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  function submit() {
    if (!canEdit) return;
    if (!projectNum.trim()) {
      setErr("Project number is required");
      return;
    }
    const cleanItems = items.filter((it) => it.description.trim());
    if (cleanItems.length === 0) {
      setErr("At least one line item with a description is required");
      return;
    }
    setBusy(true);
    setErr(null);
    startTransition(async () => {
      try {
        const r = await createRfq({
          projectNum,
          projectName: projectName || undefined,
          niche: niche || undefined,
          stage,
          targetCurrency: currency,
          incoterms,
          transportMode: transport,
          quoteDeadline: deadline || null,
          notes: notes || undefined,
          items: cleanItems,
        });
        // Auto-invite every staged supplier in one shot. Each StagedSupplier
        // is one company with N emails — fire one batch call per company so
        // every email becomes its own recipient/magic-link, all linked to
        // the same supplier record.
        let lastUrl = "";
        let invitedSuppliers = 0;
        let invitedEmails = 0;
        for (const s of stagedSuppliers) {
          if (s.emails.length === 0) {
            ping(`${s.name} has no email — skipped`, true);
            continue;
          }
          try {
            const res = await inviteSupplierBatchToRfq({
              rfqId: r.rfqId,
              supplierId: s.supplierId,
              newSupplierName: s.supplierId == null ? (s.newSupplierName ?? s.name) : undefined,
              contactName: s.contactName,
              emails: s.emails,
            });
            invitedSuppliers += 1;
            invitedEmails += res.invites.length;
            const last = res.invites[res.invites.length - 1];
            if (last) lastUrl = last.portalUrl;
          } catch (err) {
            ping(`Invite to ${s.name} failed: ${err instanceof Error ? err.message : err}`, true);
          }
        }
        if (invitedSuppliers > 0 && lastUrl) {
          try { await navigator.clipboard.writeText(lastUrl); } catch {}
          ping(`RFQ created · ${invitedSuppliers} supplier${invitedSuppliers === 1 ? "" : "s"} (${invitedEmails} email${invitedEmails === 1 ? "" : "s"}) invited · last link copied`);
        }
        // Inventory dedup summary — only show when the RFQ linked to any
        // existing parts so the user knows the IFC didn't spawn dupes.
        if (r.inventoryReused > 0) {
          ping(
            `📦 Inventory: linked to ${r.inventoryReused} existing part${r.inventoryReused === 1 ? "" : "s"}` +
            (r.inventoryCreated > 0 ? ` · ${r.inventoryCreated} new` : ""),
          );
        }
        onCreated(r.rfqId);
      } catch (e) {
        // Surface the actual server-action error in both the form banner
        // AND the console so debugging is fast on the first try.
        console.error("[OrdersTab] createRfq failed:", e);
        const msg = e instanceof Error ? e.message : String(e);
        setErr(`Create failed: ${msg}`);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <button type="button" onClick={onCancel} style={btnGhost}>← Cancel</button>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>New RFQ</h1>
      </header>

      {/* AI auto-fill — drop in an existing RFQ Excel or PDF and Claude
          extracts the project info + every line item. The form fields below
          stay editable; nothing's saved until you click Create. */}
      <section style={{ ...panelStyle, borderColor: "rgba(124,58,237,0.45)", background: "rgba(124,58,237,0.04)" }}>
        <h3 style={panelH3}>
          ⚡ Auto-fill from upload
          <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontWeight: 500, marginLeft: 8 }}>
            (drop an Excel / PDF — AI extracts items · or drop a .ifc — parser extracts parts, qty, weight, surface area, volume, material + renders isometric view)
          </span>
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label
            style={{
              ...btnPrimary,
              cursor: extracting ? "wait" : "pointer",
              opacity: extracting ? 0.6 : 1,
              background: "#7c3aed",
              border: "1px solid #7c3aed",
            }}
          >
            {extracting ? "Working…" : "📂 Choose Excel / PDF / IFC"}
            <input
              type="file"
              accept=".xlsx,.xls,.csv,application/pdf,.ifc"
              style={{ display: "none" }}
              disabled={extracting}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) handleAutoFill(f);
              }}
            />
          </label>
          {extracting && (
            <button
              type="button"
              onClick={cancelAutoFill}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                background: "transparent",
                color: "#dc2626",
                border: "1px solid rgba(220,38,38,0.5)",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              ✕ Cancel
            </button>
          )}
          {extractMsg && !progress && (
            <span style={{ fontSize: 12, color: extractMsg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>
              {extractMsg}
            </span>
          )}
        </div>
        {progress && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--lb-text-2)" }}>{progress.message}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--lb-text)", fontVariantNumeric: "tabular-nums" }}>
                {Math.max(0, Math.min(100, Math.round(progress.pct)))}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={Math.round(progress.pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{
                position: "relative",
                width: "100%",
                height: 8,
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${Math.max(0, Math.min(100, progress.pct))}%`,
                  background:
                    "linear-gradient(90deg, rgba(124,58,237,0.9), rgba(8,145,178,0.9))",
                  transition: "width 250ms ease-out",
                }}
              />
            </div>
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={panelH3}>Project</h3>
        <div style={gridCols(3)}>
          <Field label="Project number *">
            <input value={projectNum} onChange={(e) => setProjectNum(e.target.value)} placeholder="1425" style={inputStyle} />
          </Field>
          <Field label="Project name">
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Ledco" style={inputStyle} />
          </Field>
          <Field label="Niche / category">
            <input value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="LED panels" style={inputStyle} />
          </Field>
        </div>
        <div style={gridCols(3)}>
          <Field label="Stage">
            <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)} style={inputStyle}>
              {(Object.entries(RFQ_STAGE_META) as Array<[typeof stage, { label: string }]>).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <Hint>{RFQ_STAGE_META[stage].description}</Hint>
          </Field>
          <Field label="Currency">
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Incoterms">
            <IncotermSelect value={incoterms} onChange={setIncoterms} />
          </Field>
        </div>
        <div style={gridCols(3)}>
          <Field label="Transport preference">
            <select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)} style={inputStyle}>
              {TRANSPORT_MODE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {TRANSPORT_MODE_META[m].icon} {TRANSPORT_MODE_META[m].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quote deadline">
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Internal notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="anything else…" style={inputStyle} />
          </Field>
        </div>
      </section>

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={panelH3}>Line items</h3>
          <button type="button" onClick={addLine} style={btnGhost}>+ Add line</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it, i) => (
            <div
              key={i}
              style={{
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--lb-border)",
                background: "var(--lb-bg)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={gridCols(6)}>
                <Field label="Lightbase Ref.">
                  <input
                    value={it.lightbaseRef ?? ""}
                    onChange={(e) => updateLine(i, { lightbaseRef: e.target.value })}
                    placeholder="leave blank to auto-generate"
                    style={{
                      ...inputStyle,
                      // Subtle visual hint when filled in — "this is an
                      // existing part" — vs blank "this will be a new part".
                      borderColor: it.lightbaseRef?.trim()
                        ? "rgba(8,145,178,0.55)"
                        : "var(--lb-border)",
                    }}
                  />
                </Field>
                <Field label="Client ref">
                  <input value={it.clientRef ?? ""} onChange={(e) => updateLine(i, { clientRef: e.target.value })} placeholder="L18SM" style={inputStyle} />
                </Field>
                <Field label="Product code">
                  <input value={it.productCode ?? ""} onChange={(e) => updateLine(i, { productCode: e.target.value })} placeholder="PAL22-125D…" style={inputStyle} />
                </Field>
                <div style={{ gridColumn: "span 3" }}>
                  <Field label="Description *">
                    <input value={it.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="2X2 PANEL, 120-347V, 5000K, SURFACE MOUNT" style={inputStyle} />
                  </Field>
                </div>
              </div>
              <div style={gridCols(6)}>
                <Field label="Qty">
                  <input type="number" min={1} value={it.qty} onChange={(e) => updateLine(i, { qty: Number(e.target.value) })} style={inputStyle} />
                </Field>
                <Field label="Security stock">
                  <input type="number" min={0} value={it.securityStock ?? 0} onChange={(e) => updateLine(i, { securityStock: Number(e.target.value) })} style={inputStyle} />
                </Field>
                <Field label="Target unit price">
                  <input type="number" step="0.01" value={it.targetUnitPrice ?? ""} onChange={(e) => updateLine(i, { targetUnitPrice: e.target.value === "" ? null : Number(e.target.value) })} placeholder="optional" style={inputStyle} />
                </Field>
                <div style={{ gridColumn: "span 2" }}>
                  <Field label="Product URL">
                    <input value={it.productUrl ?? ""} onChange={(e) => updateLine(i, { productUrl: e.target.value })} placeholder="https://…" style={inputStyle} />
                  </Field>
                </div>
                <div style={{ alignSelf: "end" }}>
                  {items.length > 1 && (
                    <button type="button" onClick={() => removeLine(i)} style={miniBtnStyle("#dc2626")}>Remove</button>
                  )}
                </div>
              </div>
              {/* IFC-extracted physical properties — also editable manually
                  for parts entered by hand. Auto-populated by the IFC
                  AutoFill flow; nothing goes into specifications. */}
              <div style={gridCols(4)}>
                <Field label="Material">
                  <input
                    value={it.material ?? ""}
                    onChange={(e) => updateLine(i, { material: e.target.value })}
                    placeholder="e.g. 316 Stainless Steel"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Weight (g)">
                  <input
                    type="number"
                    step="any"
                    value={it.weightG ?? ""}
                    onChange={(e) => updateLine(i, { weightG: e.target.value === "" ? null : Number(e.target.value) })}
                    placeholder="0.00"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Surface area (mm²)">
                  <input
                    type="number"
                    step="any"
                    value={it.surfaceAreaMm2 ?? ""}
                    onChange={(e) => updateLine(i, { surfaceAreaMm2: e.target.value === "" ? null : Number(e.target.value) })}
                    placeholder="0.00"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Volume (mm³)">
                  <input
                    type="number"
                    step="any"
                    value={it.volumeMm3 ?? ""}
                    onChange={(e) => updateLine(i, { volumeMm3: e.target.value === "" ? null : Number(e.target.value) })}
                    placeholder="0.00"
                    style={inputStyle}
                  />
                </Field>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <LineAttachmentBucket
                  kind="photo"
                  label="Product photos"
                  hint="Drop or pick images. Shown inline on the printed RFQ."
                  rfqIndex={i}
                  attachments={(it.attachments ?? []).filter((a) => a.kind === "photo")}
                  onAdd={(att) => updateLine(i, { attachments: [...(it.attachments ?? []), att] })}
                  onRemove={(idx) => {
                    const filtered = (it.attachments ?? []).filter((_, j) => j !== idx);
                    updateLine(i, { attachments: filtered });
                  }}
                />
                <LineAttachmentBucket
                  kind="doc"
                  label="Docs / catalog (PDF, Excel)"
                  hint="Multiple datasheets, spec sheets, catalogs, etc."
                  rfqIndex={i}
                  attachments={(it.attachments ?? []).filter((a) => a.kind === "doc")}
                  onAdd={(att) => updateLine(i, { attachments: [...(it.attachments ?? []), att] })}
                  onRemove={(idx) => {
                    // Note: idx is the position inside the doc-only filtered
                    // list. Translate back into the global attachments array.
                    const all = it.attachments ?? [];
                    let docCount = -1;
                    const next = all.filter((a) => {
                      if (a.kind !== "doc") return true;
                      docCount += 1;
                      return docCount !== idx;
                    });
                    updateLine(i, { attachments: next });
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                TOTAL QTY: <b>{(it.qty ?? 0) + (it.securityStock ?? 0)}</b>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={panelStyle}>
        <h3 style={panelH3}>
          Send to suppliers
          <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontWeight: 500, marginLeft: 8 }}>
            (search your directory or add a new supplier by email — invites go out when you save)
          </span>
        </h3>
        <SupplierPicker
          suppliers={suppliers}
          staged={stagedSuppliers}
          onChange={setStagedSuppliers}
        />
        <Hint>
          Magic-link URLs are generated on save and the last one is copied to your clipboard. Paste it into your email to the supplier (outbound email auto-send is wired separately).
        </Hint>
      </section>

      {err && (
        <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,0.1)", color: "#dc2626", fontSize: 13 }}>{err}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onCancel} disabled={busy} style={btnGhost}>Cancel</button>
        <button type="button" onClick={submit} disabled={busy || !canEdit} style={btnPrimary}>
          {busy ? "Creating…" : stagedSuppliers.length > 0 ? `Create RFQ & invite ${stagedSuppliers.length} supplier${stagedSuppliers.length === 1 ? "" : "s"}` : "Create RFQ"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL VIEW — items, recipients, quote comparison, award
// ─────────────────────────────────────────────────────────────────────────────

function DetailView({
  rfqId,
  suppliers,
  canEdit,
  onBack,
  ping,
  refresh,
}: {
  rfqId: number;
  suppliers: FullSupplier[];
  canEdit: boolean;
  onBack: () => void;
  ping: (msg: string, err?: boolean) => void;
  refresh: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [data, setData] = useState<RfqDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [awarding, setAwarding] = useState<number | null>(null);

  function load() {
    setLoading(true);
    getRfqDetail(rfqId)
      .then((d) => setData(d))
      .catch((e) => ping(e instanceof Error ? e.message : "Load failed", true))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  // Re-fetch whenever the buyer comes back to the tab — this is how we
  // catch a supplier's decline / quote submission while the buyer was
  // looking at this RFQ. Without this, the panel stays stale until the
  // buyer leaves and comes back via the list.
  useEffect(() => {
    function onFocus() { load(); }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  function award(quoteId: number) {
    if (!canEdit) return;
    if (!confirm("Award this RFQ to that quote and generate the PO?")) return;
    setAwarding(quoteId);
    startTransition(async () => {
      try {
        const r = await awardRfq({ rfqId, quoteId });
        ping(`Awarded — PO ${r.poNumber} drafted`);
        load();
        refresh();
        router.push(`/suppliers/po/${r.poId}`);
      } catch (e) {
        ping(e instanceof Error ? e.message : "Award failed", true);
      } finally {
        setAwarding(null);
      }
    });
  }

  // ── Hooks must run in the same order every render ──
  // useMemo / useEffect can never sit AFTER an early return, otherwise the
  // hook count changes on load → "Rendered more hooks than during the
  // previous render" → component crashes the whole tab.
  //
  // So compute the recommendation up front using a safe payload, then
  // early-return below if we don't have data yet.
  const safeQuotes = data?.quotes ?? [];
  const safeItems = data?.items ?? [];
  const submittedQuotes = useMemo(
    () => safeQuotes.filter((q) => q.status === "submitted"),
    [safeQuotes],
  );
  const recommendedId = useMemo(
    () => recommendQuote(submittedQuotes, safeItems, suppliers),
    [submittedQuotes, safeItems, suppliers],
  );

  if (loading || !data) {
    return (
      <>
        <button type="button" onClick={onBack} style={btnGhost}>← Back to list</button>
        <Empty>{loading ? "Loading…" : "RFQ not found"}</Empty>
      </>
    );
  }

  const { rfq, items, recipients, quotes, pos } = data;
  const st = RFQ_STATUS_META[rfq.status];
  const sg = RFQ_STAGE_META[rfq.stage];
  const tm = TRANSPORT_MODE_META[rfq.transportMode];
  // Re-bind to the unwrapped values for clarity below. submittedQuotes /
  // recommendedId were computed above with the same data; they're stable.
  void quotes;
  void items;

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button type="button" onClick={onBack} style={{ ...btnGhost, alignSelf: "flex-start" }}>← Back to list</button>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>
            {rfq.rfqNumber}
            <span style={{ fontSize: 14, color: "var(--lb-text-3)", marginLeft: 10 }}>
              · {rfq.projectName ?? rfq.projectNum} · {rfq.niche ?? "—"}
            </span>
          </h1>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill label={sg.label} color={sg.color} />
            <Pill label={st.label} color={st.color} />
            <Pill label={`${tm.icon} ${tm.label}`} color={tm.color} />
            <Pill label={`${rfq.targetCurrency}${rfq.incoterms ? ` · ${rfq.incoterms}` : ""}`} color="#6b7280" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={load} style={btnGhost} disabled={loading}>
            {loading ? "↻ Refreshing…" : "↻ Refresh"}
          </button>
          <a href={`/suppliers/rfq/${rfq.id}`} target="_blank" rel="noopener noreferrer" style={btnGhost}>
            🖨 Print / PDF
          </a>
          <a href={`/api/rfq/${rfq.id}/xlsx`} download style={btnGhost}>
            📊 Download Excel
          </a>
        </div>
      </header>

      {/* Items */}
      <section style={panelStyle}>
        <h3 style={panelH3}>Line items ({items.length})</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Client ref</Th>
                <Th>Product code</Th>
                <Th>Description</Th>
                <Th style={{ textAlign: "right" }}>Qty</Th>
                <Th style={{ textAlign: "right" }}>Sec.stock</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} style={{ borderTop: "1px solid var(--lb-border)" }}>
                  <Td>{it.lineNo}</Td>
                  <Td><strong>{it.clientRef ?? "—"}</strong></Td>
                  <Td style={{ color: "var(--lb-text-2)" }}>{it.productCode ?? "—"}</Td>
                  <Td>
                    <div>{it.description}</div>
                    {it.specifications && <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{it.specifications}</div>}
                    {it.productUrl && (
                      <a href={it.productUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "var(--lb-accent)" }}>
                        {it.productUrl} ↗
                      </a>
                    )}
                  </Td>
                  <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{it.qty}</Td>
                  <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{it.securityStock}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Invite suppliers */}
      {canEdit && (
        <section style={panelStyle}>
          <h3 style={panelH3}>
            Invite suppliers
            <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontWeight: 500, marginLeft: 8 }}>
              (search your directory or add a new one by email)
            </span>
          </h3>
          <InvitePanel
            rfqId={rfqId}
            suppliers={suppliers}
            ping={ping}
            onInvited={() => { load(); refresh(); }}
          />
        </section>
      )}

      {/* Recipients */}
      <section style={panelStyle}>
        <h3 style={panelH3}>
          Invited ({recipients.length})
          <span style={{ fontSize: 11, color: "var(--lb-text-3)", fontWeight: 500, marginLeft: 8 }}>
            (revoke, re-issue, or extend any supplier's portal access)
          </span>
        </h3>
        {recipients.length === 0 ? (
          <Empty>No suppliers invited yet.</Empty>
        ) : (
          <RecipientsTable
            rfqId={data.rfq.id}
            recipients={recipients}
            quotes={data.quotes}
            canEdit={canEdit}
            ping={ping}
            onChanged={() => { load(); refresh(); }}
          />
        )}
      </section>

      {/* Quotes — compare side by side */}
      <section style={panelStyle}>
        <h3 style={panelH3}>Quotes ({quotes.length})</h3>
        {quotes.length === 0 ? (
          <Empty>Waiting on the first supplier to submit a quote.</Empty>
        ) : (
          <QuoteCompareTable
            quotes={quotes}
            items={items}
            recommendedId={recommendedId}
            currency={rfq.targetCurrency}
            canEdit={canEdit && rfq.status !== "awarded"}
            awardingId={awarding}
            onAward={award}
          />
        )}
      </section>

      {/* Generated POs */}
      {pos.length > 0 && (
        <section style={panelStyle}>
          <h3 style={panelH3}>Purchase Orders</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pos.map((po) => {
              const m = PO_STATUS_META[po.status];
              return (
                <Link
                  key={po.id}
                  href={`/suppliers/po/${po.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textDecoration: "none",
                  }}
                >
                  <strong>{po.poNumber}</strong>
                  <Pill label={m.label} color={m.color} />
                  <span style={{ color: "var(--lb-text-3)", fontSize: 12 }}>
                    {po.supplierName} · {fmtMoney(Number(po.totalAmount), po.currency)}
                  </span>
                  <span style={{ marginLeft: "auto", color: "var(--lb-text-3)", fontSize: 12 }}>→</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE COMPARISON TABLE — also computes the recommendation
// ─────────────────────────────────────────────────────────────────────────────

function safeAiName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";
}

function recommendQuote(
  quotes: RfqDetailPayload["quotes"],
  items: RfqDetailPayload["items"],
  suppliers: FullSupplier[],
): number | null {
  if (quotes.length === 0) return null;
  // Compute landed unit cost (avg over items) + lead time + stock coverage.
  const scored = quotes.map((q) => {
    const lineByItem = new Map(q.lines.map((l) => [l.rfqItemId, l]));
    let totalLanded = 0;
    let count = 0;
    let stockCoverage = 0;
    for (const it of items) {
      const l = lineByItem.get(it.id);
      if (!l) continue;
      const unit = Number(l.unitPrice ?? 0);
      const ship = Number(q.shippingCost ?? 0) / Math.max(1, items.length);
      totalLanded += unit + ship / it.qty;
      count += 1;
      if (l.availableStock != null && l.availableStock >= it.qty) stockCoverage += 1;
    }
    const avgLanded = count ? totalLanded / count : Number.POSITIVE_INFINITY;
    const stockPct = items.length ? stockCoverage / items.length : 0;
    const isStarred = suppliers.find((s) => s.id === q.supplierId)?.isStarred ? 1 : 0;
    return { q, avgLanded, leadTime: q.leadTimeDays ?? 999, stockPct, isStarred };
  });
  const minLanded = Math.min(...scored.map((s) => s.avgLanded));
  const maxLanded = Math.max(...scored.map((s) => s.avgLanded));
  const minLead = Math.min(...scored.map((s) => s.leadTime));
  const maxLead = Math.max(...scored.map((s) => s.leadTime));
  function norm(v: number, min: number, max: number) {
    if (max === min) return 0;
    return (v - min) / (max - min);
  }
  const ranked = scored.map((s) => {
    const c = norm(s.avgLanded, minLanded, maxLanded);             // 0 best
    const l = norm(s.leadTime, minLead, maxLead);                   // 0 best
    const stk = 1 - s.stockPct;                                     // 0 best
    const star = 1 - s.isStarred;                                   // 0 best
    const score =
      COMPARE_WEIGHTS.landedUnitCost * c +
      COMPARE_WEIGHTS.leadTimeDays * l +
      COMPARE_WEIGHTS.stockCoverage * stk +
      COMPARE_WEIGHTS.starredSupplier * star;
    return { ...s, score };
  });
  ranked.sort((a, b) => a.score - b.score);
  return ranked[0]?.q.id ?? null;
}

function QuoteCompareTable({
  quotes,
  items,
  recommendedId,
  currency,
  canEdit,
  awardingId,
  onAward,
}: {
  quotes: RfqDetailPayload["quotes"];
  items: RfqDetailPayload["items"];
  recommendedId: number | null;
  currency: string;
  canEdit: boolean;
  awardingId: number | null;
  onAward: (quoteId: number) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            <Th>Supplier</Th>
            <Th>Status</Th>
            <Th style={{ textAlign: "right" }}>Currency</Th>
            <Th style={{ textAlign: "right" }}>Lead time</Th>
            <Th style={{ textAlign: "right" }}>Ship cost</Th>
            <Th>Incoterms</Th>
            <Th>Validity</Th>
            <Th>Country</Th>
            {items.map((it) => (
              <Th key={it.id} style={{ textAlign: "right" }}>
                #{it.lineNo} {it.clientRef ?? ""}
              </Th>
            ))}
            <Th>Files</Th>
            {canEdit && <Th />}
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => {
            const m = QUOTE_STATUS_META[q.status];
            const lineByItem = new Map(q.lines.map((l) => [l.rfqItemId, l]));
            const isRec = q.id === recommendedId;
            return (
              <tr
                key={q.id}
                style={{
                  borderTop: "1px solid var(--lb-border)",
                  background: isRec ? "rgba(22,163,74,0.06)" : "transparent",
                }}
              >
                <Td>
                  <strong>{q.companyName}</strong>
                  {isRec && (
                    <span style={{
                      marginLeft: 6,
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "rgba(22,163,74,0.18)",
                      color: "#16a34a",
                      fontWeight: 800,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                    }}>
                      Recommended
                    </span>
                  )}
                  {q.contactName && <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>{q.contactName}</div>}
                  {q.manufacturerName && <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>MFG: {q.manufacturerName}</div>}
                </Td>
                <Td><Pill label={m.label} color={m.color} /></Td>
                <Td style={{ textAlign: "right" }}>{q.currency}</Td>
                <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{q.leadTimeDays}d</Td>
                <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(Number(q.shippingCost), q.currency)}</Td>
                <Td>{q.incoterms ?? "—"}</Td>
                <Td>{q.validityUntil ?? "—"}</Td>
                <Td>{q.countryOfOrigin ?? "—"}</Td>
                {items.map((it) => {
                  const l = lineByItem.get(it.id);
                  return (
                    <Td key={it.id} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {l ? fmtMoney(Number(l.unitPrice), q.currency) : "—"}
                      {l?.moq && l.moq > 1 && (
                        <div style={{ fontSize: 10, color: "var(--lb-text-3)" }}>MOQ {l.moq}</div>
                      )}
                    </Td>
                  );
                })}
                <Td>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {/* Always show "View quote PDF" — links to source PDF
                        when supplier uploaded one, else to the generated view. */}
                    <a
                      href={q.sourcePdfUrl ?? `/suppliers/quote/${q.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "var(--lb-accent)", fontWeight: 700 }}
                      title={q.sourcePdfUrl ? `Supplier uploaded: ${q.sourcePdfName ?? "PDF"}` : "Open generated quote view"}
                    >
                      {q.sourcePdfUrl ? "📄 Quote PDF" : "📄 View quote"}
                    </a>
                    {q.attachments.map((a) => (
                      <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "var(--lb-accent)" }}>
                        {a.kind === "datasheet" ? "📋" : a.kind === "certification" ? "🛡" : a.kind === "brochure" ? "📚" : "📎"} {a.name.slice(0, 16)}
                      </a>
                    ))}
                  </div>
                </Td>
                {canEdit && (
                  <Td>
                    {q.status === "submitted" ? (
                      <button
                        type="button"
                        disabled={awardingId !== null}
                        onClick={() => onAward(q.id)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 6,
                          background: isRec ? "#16a34a" : "var(--lb-accent)",
                          color: "#fff",
                          border: 0,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {awardingId === q.id ? "Awarding…" : "Award · gen PO"}
                      </button>
                    ) : (
                      <span style={{ fontSize: 10.5, color: "var(--lb-text-3)" }}>
                        {q.status === "draft" ? "supplier still editing" : "—"}
                      </span>
                    )}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--lb-text-3)" }}>
        Recommendation weights: landed cost {(COMPARE_WEIGHTS.landedUnitCost * 100).toFixed(0)}% · lead time {(COMPARE_WEIGHTS.leadTimeDays * 100).toFixed(0)}% · stock coverage {(COMPARE_WEIGHTS.stockCoverage * 100).toFixed(0)}% · starred {(COMPARE_WEIGHTS.starredSupplier * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS + STYLES
// ─────────────────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 12,
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const panelH3: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: "-0.01em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 13,
  outline: "none",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  border: "1px solid var(--lb-accent)",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
};

const btnGhost: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 999,
  background: "transparent",
  color: "var(--lb-text-2)",
  border: "1px solid var(--lb-border)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function miniBtnStyle(color: string): React.CSSProperties {
  return {
    padding: "3px 9px",
    borderRadius: 6,
    background: `${color}15`,
    color,
    border: `1px solid ${color}55`,
    fontSize: 10.5,
    fontWeight: 700,
    cursor: "pointer",
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--lb-text-2)" }}>
      <span style={{ fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", fontSize: 10.5, color: "var(--lb-text-3)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

// Per-line attachment dropzone used inside the New-RFQ wizard. Uploads
// straight to Vercel Blob via the client SDK so the file is hosted before
// the RFQ row even exists; the attachment is then staged in memory and
// flushed to rfq_item_attachments by createRfq.
function LineAttachmentBucket({
  kind,
  label,
  hint,
  rfqIndex,
  attachments,
  onAdd,
  onRemove,
}: {
  kind: "photo" | "doc";
  label: string;
  hint: string;
  rfqIndex: number;
  attachments: Array<{
    kind: "photo" | "doc";
    name: string;
    url: string;
    blobPathname?: string;
    contentType?: string;
    size?: number;
  }>;
  onAdd: (a: {
    kind: "photo" | "doc";
    name: string;
    url: string;
    blobPathname?: string;
    contentType?: string;
    size?: number;
  }) => void;
  onRemove: (idx: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const safe = (file.name || "file")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 100) || "file";
        const pathname = `rfq-items/pending/${Date.now()}-${rfqIndex}-${crypto.randomUUID()}-${safe}`;
        const blob = await upload(pathname, file, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: file.type || undefined,
        });
        onAdd({
          kind,
          name: file.name,
          url: blob.url,
          blobPathname: blob.pathname,
          contentType: file.type || undefined,
          size: file.size,
        });
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <Field label={label}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <label
            style={{
              ...btnGhost,
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
              padding: "6px 12px",
            }}
          >
            {busy ? "Uploading…" : kind === "photo" ? "🖼 Add photo(s)" : "📎 Add doc(s)"}
            <input
              type="file"
              multiple
              accept={kind === "photo" ? "image/*" : ".pdf,.xlsx,.xls,.csv,application/pdf"}
              style={{ display: "none" }}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files;
                handleFiles(f);
                e.target.value = "";
              }}
            />
          </label>
          <Hint>{hint}</Hint>
        </div>
        {attachments.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {attachments.map((a, j) => (
              <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)", fontSize: 11 }}>
                {a.kind === "photo" ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    <img src={a.url} alt={a.name} style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, display: "block" }} />
                  </a>
                ) : (
                  <span>📄</span>
                )}
                <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lb-text)", textDecoration: "none", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name}
                </a>
                <button type="button" onClick={() => onRemove(j)} style={{ background: "transparent", color: "#dc2626", border: 0, cursor: "pointer", fontSize: 12, padding: 0 }}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: 11, color: "var(--lb-text-3)" }}>{children}</p>;
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10.5,
      padding: "2px 8px",
      borderRadius: 5,
      background: `${color}22`,
      color,
      fontWeight: 800,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "20px 12px", borderRadius: 10, border: "1px dashed var(--lb-border)", textAlign: "center", color: "var(--lb-text-3)", fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function gridCols(n: number): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gap: 10 };
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{
      textAlign: "left",
      padding: "8px 10px",
      fontSize: 10.5,
      fontWeight: 800,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      color: "var(--lb-text-3)",
      borderBottom: "1px solid var(--lb-border)",
      ...style,
    }}>
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{ padding: "8px 10px", verticalAlign: "top", ...style }}>{children}</td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RecipientsTable — Invited list with per-row access control. The buyer can:
//   • copy the portal URL (most common — paste into email)
//   • re-issue the token (kills the old URL, generates a new one — handy
//     if the supplier's contact left or the link leaked)
//   • extend the token expiry (+60 days)
//   • revoke (status → expired, old URL stops working, row preserved)
//   • delete the recipient entirely (cascades to any draft quote)
// ─────────────────────────────────────────────────────────────────────────────

function RecipientsTable({
  rfqId,
  recipients,
  quotes,
  canEdit,
  ping,
  onChanged,
}: {
  rfqId: number;
  recipients: RfqDetailPayload["recipients"];
  quotes: RfqDetailPayload["quotes"];
  canEdit: boolean;
  ping: (msg: string, err?: boolean) => void;
  onChanged: () => void;
}) {
  // Compose-dialog state. Per-recipient so multiple emails can be drafted
  // sequentially without losing the previous form's content (the dialog
  // is single-instance though — only one open at a time).
  const [emailFor, setEmailFor] = useState<{
    recipientId: number;
    supplierId: number | null;
    toEmail: string;
    toName: string | null;
    magicLinkUrl: string | null;
    isRegistered: boolean;
  } | null>(null);
  // Build a recipientId → declineReason lookup so we can show the reason
  // inline on the Invited table (the decline reason lives in the quote's
  // notes; we strip the "Declined: " prefix when displaying).
  const declineReasonByRecipient = useMemo(() => {
    const m = new Map<number, string>();
    for (const q of quotes) {
      if (q.status === "declined" && q.notes) {
        m.set(q.recipientId, q.notes.replace(/^Declined:\s*/, "").trim());
      }
    }
    return m;
  }, [quotes]);
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);

  function run<T>(id: number, label: string, fn: () => Promise<T>, onResult?: (r: T) => void) {
    setBusyId(id);
    startTransition(async () => {
      try {
        const r = await fn();
        ping(label);
        if (onResult) onResult(r);
        onChanged();
      } catch (e) {
        ping(e instanceof Error ? e.message : "Action failed", true);
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            <Th>Email</Th>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Invited</Th>
            <Th>Expires</Th>
            <Th>Portal URL</Th>
            {canEdit && <Th style={{ textAlign: "right" }}>Access control</Th>}
          </tr>
        </thead>
        <tbody>
          {recipients.map((r) => {
            const m = QUOTE_STATUS_META[r.status];
            const busy = busyId === r.id;
            const expiresAt = r.tokenExpiresAt ? new Date(r.tokenExpiresAt) : null;
            const isExpired = !!expiresAt && expiresAt < new Date();
            const isRevoked = r.status === "expired";
            return (
              <tr
                key={r.id}
                style={{
                  borderTop: "1px solid var(--lb-border)",
                  opacity: busy ? 0.55 : isRevoked ? 0.7 : 1,
                }}
              >
                <Td>
                  <strong>{r.inviteEmail}</strong>
                  {r.status === "declined" && declineReasonByRecipient.has(r.id) && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: "4px 8px",
                        borderRadius: 6,
                        background: "rgba(220,38,38,0.10)",
                        border: "1px solid rgba(220,38,38,0.30)",
                        color: "#dc2626",
                        fontSize: 11,
                        fontStyle: "italic",
                        maxWidth: 360,
                      }}
                      title="Reason provided by the supplier when they declined"
                    >
                      ✕ Reason: {declineReasonByRecipient.get(r.id)}
                    </div>
                  )}
                  {r.status === "declined" && !declineReasonByRecipient.has(r.id) && (
                    <div style={{ marginTop: 4, fontSize: 11, color: "#dc2626", fontStyle: "italic" }}>
                      ✕ Declined — no reason given
                    </div>
                  )}
                </Td>
                <Td style={{ color: "var(--lb-text-2)" }}>{r.inviteName ?? "—"}</Td>
                <Td><Pill label={m.label} color={m.color} /></Td>
                <Td style={{ color: "var(--lb-text-3)" }}>
                  {new Date(r.invitedAt).toLocaleString()}
                  {r.viewedAt && (
                    <div style={{ fontSize: 10 }}>viewed {new Date(r.viewedAt).toLocaleString()}</div>
                  )}
                </Td>
                <Td style={{ color: isExpired ? "#dc2626" : "var(--lb-text-3)", fontWeight: isExpired ? 700 : 400 }}>
                  {expiresAt
                    ? `${expiresAt.toLocaleDateString()} ${isExpired ? "(expired)" : ""}`
                    : "—"}
                </Td>
                <Td>
                  {isRevoked ? (
                    <span style={{ color: "var(--lb-text-3)", fontSize: 11, fontStyle: "italic" }}>
                      revoked — re-issue to send a fresh link
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(r.portalUrl); ping("Portal URL copied"); }}
                      style={{ ...miniBtnStyle("#0891b2"), maxWidth: 260, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={r.portalUrl}
                    >
                      📋 {r.portalUrl}
                    </button>
                  )}
                </Td>
                {canEdit && (
                  <Td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(
                          r.id,
                          "New link copied · old link no longer works",
                          () => reissueRfqRecipientToken({ recipientId: r.id }),
                          async (res) => { try { await navigator.clipboard.writeText(res.portalUrl); } catch {} },
                        )}
                        style={miniBtnStyle("#7c3aed")}
                        title="Generate a new token; the old URL stops working immediately. Use when a contact leaves or the link leaks."
                      >
                        ↻ Re-issue
                      </button>
                      {!isRevoked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => run(
                            r.id,
                            "Expiry extended by 60 days",
                            () => extendRfqRecipientToken({ recipientId: r.id }),
                          )}
                          style={miniBtnStyle("#16a34a")}
                          title="Push the token expiry out by 60 days. Same URL keeps working."
                        >
                          +60d
                        </button>
                      )}
                      {!isRevoked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (!confirm(`Revoke ${r.inviteEmail}'s portal access? The link will stop working immediately. You can re-issue a new link afterwards.`)) return;
                            run(
                              r.id,
                              "Access revoked",
                              () => revokeRfqRecipient({ recipientId: r.id }),
                            );
                          }}
                          style={miniBtnStyle("#ea580c")}
                          title="Disable this magic link now. Use when a contact leaves the supplier."
                        >
                          🚫 Revoke
                        </button>
                      )}
                      {!isRevoked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEmailFor({
                              recipientId: r.id,
                              supplierId: r.supplierId,
                              toEmail: r.inviteEmail,
                              toName: r.inviteName,
                              magicLinkUrl: r.portalUrl,
                              isRegistered: r.supplierId != null,
                            });
                          }}
                          style={miniBtnStyle("#2563eb")}
                          title="Compose and send (or route through procurement) the RFQ email to this contact."
                        >
                          ✉ Email
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`Delete ${r.inviteEmail} from this RFQ? Their draft/submitted quote (if any) is also removed. This cannot be undone.`)) return;
                          run(
                            r.id,
                            "Recipient deleted",
                            () => deleteRfqRecipient({ recipientId: r.id }),
                          );
                        }}
                        style={miniBtnStyle("#dc2626")}
                        title="Remove the recipient entirely. Cascades to their quote."
                      >
                        ✕
                      </button>
                    </div>
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <RfqEmailDraftDialog
        open={emailFor != null}
        rfqId={rfqId}
        recipientId={emailFor?.recipientId ?? null}
        supplierId={emailFor?.supplierId ?? null}
        defaultToEmail={emailFor?.toEmail ?? ""}
        defaultToName={emailFor?.toName ?? null}
        magicLinkUrl={emailFor?.magicLinkUrl ?? null}
        isRegistered={emailFor?.isRegistered ?? false}
        onClose={() => setEmailFor(null)}
        onSent={(status) => {
          setEmailFor(null);
          if (status === "sent") ping("RFQ email sent");
          else if (status === "pending_procurement_review")
            ping("Sent for procurement review");
          onChanged();
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SupplierPicker — typeahead picker over the suppliers DB + "add new by
// email". Returns a staged list so the buyer can queue up several at once.
// Uses a controlled chip list above the search box for already-staged
// entries (mirrors how GitHub / Linear handle multi-select with search).
// ─────────────────────────────────────────────────────────────────────────────

// One staged invite = one supplier (existing or to-be-created) + N emails.
// The buyer can stack multiple companies, each with multiple contact emails;
// every email becomes its own rfq_recipient when the batch action fires.
export type StagedSupplier = {
  // Stable client-side key for React reconciliation and chip diffing.
  key: string;
  // Either supplierId set (existing) OR newSupplierName set (will be created).
  supplierId: number | null;
  newSupplierName?: string;
  name: string;
  contactName?: string;
  emails: string[];
  category?: string | null;
  isStarred?: boolean;
};

function makeKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function SupplierPicker({
  suppliers,
  staged,
  onChange,
}: {
  suppliers: FullSupplier[];
  staged: StagedSupplier[];
  onChange: (next: StagedSupplier[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmailDraft, setNewEmailDraft] = useState("");
  const [newEmails, setNewEmails] = useState<string[]>([]);

  // Already-staged supplier ids (so the directory search hides them).
  const stagedSupplierIds = useMemo(
    () => new Set(staged.filter((s) => s.supplierId != null).map((s) => s.supplierId!)),
    [staged],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return suppliers
        .filter((s) => s.isStarred && !stagedSupplierIds.has(s.id))
        .slice(0, 8);
    }
    return suppliers
      .filter((s) => {
        if (stagedSupplierIds.has(s.id)) return false;
        const knownEmails = (s.contacts ?? []).map((c) => c.email).join(" ");
        return `${s.name} ${s.email ?? ""} ${knownEmails} ${s.category ?? ""} ${s.origin ?? ""}`
          .toLowerCase()
          .includes(q);
      })
      .slice(0, 12);
  }, [query, suppliers, stagedSupplierIds]);

  function addExisting(s: FullSupplier) {
    if (stagedSupplierIds.has(s.id)) return;
    // Seed with the primary contact email if there is one; otherwise empty.
    const primary = (s.contacts ?? []).find((c) => c.isPrimary) ?? s.contacts?.[0];
    const seedEmail = primary?.email ?? s.email ?? "";
    onChange([
      ...staged,
      {
        key: makeKey(`s${s.id}`),
        supplierId: s.id,
        name: s.name,
        emails: seedEmail ? [seedEmail.toLowerCase()] : [],
        category: s.category,
        isStarred: s.isStarred,
      },
    ]);
    setQuery("");
  }

  function addNewSupplier() {
    const name = newName.trim();
    const draft = newEmailDraft.trim().toLowerCase();
    const collected = [...newEmails];
    if (draft && draft.includes("@") && !collected.includes(draft)) collected.push(draft);
    if (!name) {
      alert("Company name is required");
      return;
    }
    if (collected.length === 0) {
      alert("Add at least one email");
      return;
    }
    onChange([
      ...staged,
      {
        key: makeKey("new"),
        supplierId: null,
        newSupplierName: name,
        name,
        emails: collected,
      },
    ]);
    setNewName("");
    setNewEmailDraft("");
    setNewEmails([]);
  }

  function removeStaged(key: string) {
    onChange(staged.filter((s) => s.key !== key));
  }
  function updateStaged(key: string, patch: Partial<StagedSupplier>) {
    onChange(staged.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
  function removeEmail(key: string, email: string) {
    updateStaged(key, {
      emails: (staged.find((s) => s.key === key)?.emails ?? []).filter((e) => e !== email),
    });
  }
  function addEmailToStaged(key: string, email: string) {
    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes("@")) return;
    const target = staged.find((s) => s.key === key);
    if (!target) return;
    if (target.emails.includes(clean)) return;
    updateStaged(key, { emails: [...target.emails, clean] });
  }

  function pushNewEmailDraft() {
    const e = newEmailDraft.trim().toLowerCase();
    if (!e || !e.includes("@")) return;
    if (newEmails.includes(e)) {
      setNewEmailDraft("");
      return;
    }
    setNewEmails([...newEmails, e]);
    setNewEmailDraft("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Staged supplier cards — each card = one company + N email chips
          + an inline "add another email" input. */}
      {staged.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {staged.map((s) => (
            <StagedSupplierCard
              key={s.key}
              entry={s}
              knownContacts={
                s.supplierId != null
                  ? (suppliers.find((x) => x.id === s.supplierId)?.contacts ?? [])
                  : []
              }
              onRemoveSupplier={() => removeStaged(s.key)}
              onRemoveEmail={(em) => removeEmail(s.key, em)}
              onAddEmail={(em) => addEmailToStaged(s.key, em)}
              onUpdateContactName={(n) => updateStaged(s.key, { contactName: n })}
            />
          ))}
        </div>
      )}

      {/* Search box + dropdown */}
      <div style={{ position: "relative" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          placeholder={`Search ${suppliers.length} suppliers by name, email, category, origin…`}
          style={inputStyle}
        />
        {(focused || query) && matches.length > 0 && (
          <div
            role="listbox"
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              maxHeight: 280,
              overflowY: "auto",
              zIndex: 20,
            }}
          >
            {!query && (
              <div style={{ padding: "6px 12px", fontSize: 10.5, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 700, borderBottom: "1px solid var(--lb-border)" }}>
                ★ Current suppliers
              </div>
            )}
            {matches.map((s) => {
              const contactCount = (s.contacts ?? []).length;
              return (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addExisting(s)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    background: "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--lb-bg)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {s.isStarred && <span style={{ color: "#facc15", flexShrink: 0 }}>★</span>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                      {s.email ?? "no email on file"}
                      {contactCount > 1 && ` · ${contactCount} contacts`}
                      {s.category ? ` · ${s.category}` : ""}
                      {s.origin ? ` · ${s.origin}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>+ Add</span>
                </button>
              );
            })}
          </div>
        )}
        {focused && query && matches.length === 0 && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              padding: 12,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 10,
              fontSize: 12,
              color: "var(--lb-text-3)",
              zIndex: 20,
            }}
          >
            No match in the directory. Add a new supplier below ↓
          </div>
        )}
      </div>

      {/* Add NEW supplier — company name + chip-list of emails */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px dashed var(--lb-border)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--lb-text-3)", letterSpacing: 0.4, textTransform: "uppercase" }}>
          + Add a brand-new supplier (multiple emails allowed)
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Field label="Company name *">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme Lighting" style={inputStyle} />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field label="Contact email — press Enter to add">
              <input
                type="email"
                value={newEmailDraft}
                onChange={(e) => setNewEmailDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    pushNewEmailDraft();
                  }
                }}
                placeholder="sales@acme.com"
                style={inputStyle}
              />
            </Field>
          </div>
        </div>
        {newEmails.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {newEmails.map((e) => (
              <span
                key={e}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: "rgba(8,145,178,0.15)",
                  border: "1px solid rgba(8,145,178,0.4)",
                  color: "var(--lb-text)",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {e}
                <button
                  type="button"
                  onClick={() => setNewEmails(newEmails.filter((x) => x !== e))}
                  style={{ background: "transparent", border: 0, color: "var(--lb-text-3)", cursor: "pointer", padding: 0, fontSize: 12 }}
                  aria-label="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={addNewSupplier}
            disabled={!newName.trim() || (newEmails.length === 0 && !newEmailDraft.trim().includes("@"))}
            style={btnGhost}
          >
            + Add supplier to invite list
          </button>
          <Hint>
            Every email entered becomes a portal contact on the same company. Press Enter / comma between emails.
          </Hint>
        </div>
      </div>
    </div>
  );
}

// Per-staged-supplier card — shows the chosen company name + every email
// they're being invited to, plus an inline "add another email" input and
// quick-add chips for the supplier's other known contacts (when an existing
// supplier was picked from the directory).
function StagedSupplierCard({
  entry,
  knownContacts,
  onRemoveSupplier,
  onRemoveEmail,
  onAddEmail,
  onUpdateContactName,
}: {
  entry: StagedSupplier;
  knownContacts: SupplierContact[];
  onRemoveSupplier: () => void;
  onRemoveEmail: (email: string) => void;
  onAddEmail: (email: string) => void;
  onUpdateContactName: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const unselectedKnown = knownContacts.filter(
    (c) => !entry.emails.includes(c.email.toLowerCase()),
  );
  const isNew = entry.supplierId == null;
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: isNew ? "rgba(16,185,129,0.06)" : "rgba(8,145,178,0.06)",
        border: `1px solid ${isNew ? "rgba(16,185,129,0.4)" : "rgba(8,145,178,0.4)"}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {entry.isStarred && <span style={{ color: "#facc15" }}>★</span>}
        <strong style={{ fontSize: 13, color: "var(--lb-text)" }}>
          {entry.name}
        </strong>
        {isNew && (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 800,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              padding: "2px 6px",
              borderRadius: 4,
              background: "rgba(16,185,129,0.2)",
              color: "#10b981",
            }}
          >
            New
          </span>
        )}
        {!isNew && entry.category && (
          <span style={{ fontSize: 10.5, color: "var(--lb-text-3)" }}>· {entry.category}</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--lb-text-3)" }}>
          {entry.emails.length} email{entry.emails.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onRemoveSupplier}
          aria-label="Remove supplier"
          style={{
            background: "transparent",
            border: 0,
            color: "#dc2626",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            padding: "0 6px",
          }}
        >
          ✕ Remove
        </button>
      </div>

      {/* Email chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {entry.emails.length === 0 && (
          <span style={{ fontSize: 11, color: "#dc2626", fontStyle: "italic" }}>
            ⚠ No emails — add at least one below
          </span>
        )}
        {entry.emails.map((em) => (
          <span
            key={em}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text)",
              fontSize: 11.5,
            }}
          >
            {em}
            <button
              type="button"
              onClick={() => onRemoveEmail(em)}
              aria-label="Remove email"
              style={{ background: "transparent", border: 0, color: "var(--lb-text-3)", cursor: "pointer", padding: 0, fontSize: 12 }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* Quick-add chips for OTHER known contacts on this supplier */}
      {unselectedKnown.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: "var(--lb-text-3)" }}>Other contacts:</span>
          {unselectedKnown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onAddEmail(c.email)}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                background: "transparent",
                border: "1px dashed var(--lb-border)",
                color: "var(--lb-text-2)",
                fontSize: 11,
                cursor: "pointer",
              }}
              title={c.role ?? undefined}
            >
              + {c.email}
              {c.role && (
                <span style={{ color: "var(--lb-text-3)", fontSize: 10 }}> ({c.role})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Add another email + optional contact name */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              if (draft.trim().includes("@")) {
                onAddEmail(draft.trim());
                setDraft("");
              }
            }
          }}
          placeholder="add another email…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <button
          type="button"
          onClick={() => {
            if (draft.trim().includes("@")) {
              onAddEmail(draft.trim());
              setDraft("");
            }
          }}
          disabled={!draft.trim().includes("@")}
          style={btnGhost}
        >
          + Add email
        </button>
        {isNew && (
          <input
            type="text"
            value={entry.contactName ?? ""}
            onChange={(e) => onUpdateContactName(e.target.value)}
            placeholder="Contact name (optional)"
            style={{ ...inputStyle, flex: 1, minWidth: 180 }}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InvitePanel — picker + "Send invites" button used inside the RFQ detail
// view (i.e. after an RFQ has been created). Stages a list, dispatches one
// inviteSupplierToRfq call per entry, then clears.
// ─────────────────────────────────────────────────────────────────────────────

function InvitePanel({
  rfqId,
  suppliers,
  ping,
  onInvited,
}: {
  rfqId: number;
  suppliers: FullSupplier[];
  ping: (msg: string, err?: boolean) => void;
  onInvited: () => void;
}) {
  const [, startTransition] = useTransition();
  const [staged, setStaged] = useState<StagedSupplier[]>([]);
  const [busy, setBusy] = useState(false);

  function send() {
    if (staged.length === 0) return;
    const bad = staged.find((s) => s.emails.length === 0);
    if (bad) {
      ping(`Add an email for "${bad.name}" before sending`, true);
      return;
    }
    setBusy(true);
    startTransition(async () => {
      let lastUrl = "";
      let suppliersSent = 0;
      let emailsSent = 0;
      for (const s of staged) {
        try {
          const res = await inviteSupplierBatchToRfq({
            rfqId,
            supplierId: s.supplierId,
            newSupplierName: s.supplierId == null ? (s.newSupplierName ?? s.name) : undefined,
            contactName: s.contactName,
            emails: s.emails,
          });
          suppliersSent += 1;
          emailsSent += res.invites.length;
          const last = res.invites[res.invites.length - 1];
          if (last) lastUrl = last.portalUrl;
        } catch (e) {
          ping(`Invite to ${s.name} failed: ${e instanceof Error ? e.message : e}`, true);
        }
      }
      if (suppliersSent > 0) {
        try { await navigator.clipboard.writeText(lastUrl); } catch {}
        ping(`Invited ${suppliersSent} supplier${suppliersSent === 1 ? "" : "s"} (${emailsSent} email${emailsSent === 1 ? "" : "s"}) · last link copied`);
        setStaged([]);
        onInvited();
      }
      setBusy(false);
    });
  }

  return (
    <>
      <SupplierPicker suppliers={suppliers} staged={staged} onChange={setStaged} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Hint>
          Each email generates its own magic-link URL — the last one is copied to your clipboard.
        </Hint>
        <button
          type="button"
          onClick={send}
          disabled={busy || staged.length === 0}
          style={{ ...btnPrimary, opacity: busy || staged.length === 0 ? 0.6 : 1 }}
        >
          {busy ? "Sending…" : staged.length === 0
            ? "Pick at least one supplier"
            : `Send ${staged.reduce((n, s) => n + s.emails.length, 0)} invite${staged.reduce((n, s) => n + s.emails.length, 0) === 1 ? "" : "s"}`}
        </button>
      </div>
    </>
  );
}
