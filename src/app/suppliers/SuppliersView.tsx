"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  createSupplier,
  updateSupplier,
  deleteSupplier,
  upsertProjectEntry,
  deleteProjectEntry,
  addSupplierComment,
  deleteSupplierComment,
  addSupplierAttachment,
  deleteSupplierAttachment,
  type ProjectEntryInput,
} from "./actions";
import { CategoryChart, OriginChart } from "./SupplierCharts";
import type {
  Supplier,
  SupplierProjectEntry,
  SupplierComment,
  SupplierAttachment,
} from "@/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FullSupplier = Supplier & {
  projectEntries: SupplierProjectEntry[];
  comments: SupplierComment[];
  attachments: SupplierAttachment[];
};

const ATT_CATEGORIES = [
  { id: "specs", label: "Specifications & Datasheets", icon: "📋", color: "#2a5c9e", desc: "Product specs, technical datasheets, drawings" },
  { id: "quotes", label: "Quotes & Pricing", icon: "💰", color: "#1a8a4a", desc: "Price lists, RFQ responses, quotations" },
  { id: "contracts", label: "Contracts & NDAs", icon: "📜", color: "#7a4ab5", desc: "MSAs, NDAs, supply agreements, terms" },
  { id: "certs", label: "Certifications & Compliance", icon: "🛡", color: "#c07d0a", desc: "CE, UL, RoHS, REACH, ISO, FCC, CSA" },
  { id: "tests", label: "Test Reports & QC", icon: "🧪", color: "#1a7a8a", desc: "Photometric, IES, LM-80, IP ratings, QC reports" },
  { id: "catalogs", label: "Catalogs & Brochures", icon: "📚", color: "#c03030", desc: "Marketing materials, product catalogs" },
  { id: "invoices", label: "Invoices & POs", icon: "🧾", color: "#3a4a5e", desc: "Purchase orders, invoices, payment receipts" },
  { id: "comms", label: "Communications", icon: "✉️", color: "#5a6a7e", desc: "Important emails, letters, meeting notes" },
  { id: "media", label: "Photos & Media", icon: "🖼", color: "#7a4ab5", desc: "Product photos, factory tours, samples" },
  { id: "other", label: "Other", icon: "📁", color: "#7a8a9e", desc: "Miscellaneous documents" },
];

const SCORE_WEIGHTS = {
  quality: 0.3,
  onTime: 0.25,
  fillRate: 0.2,
  leadReliability: 0.15,
  costReliability: 0.1,
} as const;

const CATEGORIES = [
  "Acoustics", "Agency", "Agriculture/Tech", "Building Materials", "Buy/Sell Distribution",
  "Design Services", "Digital Services", "Distribution", "Drivers/Power", "Electrical",
  "Electronics", "Equipment", "Exhibition/Display", "Flooring", "Furniture", "Hardware",
  "LED/Components", "LED/Lighting", "Logistics/Freight", "Manufacturing",
  "Manufacturing / Logistics", "Materials", "Optics", "Sealing/Thermal", "Services", "Software",
];
const ORIGINS = [
  "Australia", "Austria", "Canada", "Canada/China", "China", "Finland", "Germany",
  "Global", "Indonesia", "Japan", "N/A", "Taiwan", "USA", "Vietnam",
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure compute functions (ported from original JS)
// ─────────────────────────────────────────────────────────────────────────────

function daysBetween(a: string | null, b: string | null) {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

type Metrics = {
  qualityPct: number | null;
  defectRate: number | null;
  fillRate: number | null;
  quotedLead: number | null;
  actualLead: number | null;
  leadVariance: number | null;
  onTime: boolean | null;
  costVariance: number | null;
  goodUnits: number;
  badUnits: number;
};

function computeProjectMetrics(pe: Partial<SupplierProjectEntry> & {
  expectedDelivery?: string | null;
  actualDelivery?: string | null;
  poDate?: string | null;
}): Metrics {
  const ordered = num(pe.orderedQuantity);
  const delivered = num(pe.deliveredQuantity);
  const defective = num(pe.defectiveQuantity);
  const returned = num(pe.returnedQuantity);
  const quoted = num(pe.quotedAmount);
  const actual = num(pe.actualAmount);

  const badUnits = Math.max(defective, returned);
  const goodUnits = Math.max(0, delivered - badUnits);
  const qualityPct = delivered > 0 ? (goodUnits / delivered) * 100 : null;
  const defectRate = delivered > 0 ? (defective / delivered) * 100 : null;
  const fillRate = ordered > 0 && delivered >= 0 ? Math.min(delivered / ordered, 1) * 100 : null;

  const quotedLead = num(pe.quotedLeadTime) > 0
    ? num(pe.quotedLeadTime)
    : daysBetween(pe.poDate ?? null, pe.expectedDelivery ?? null);
  const actualLead = num(pe.actualLeadTime) > 0
    ? num(pe.actualLeadTime)
    : daysBetween(pe.poDate ?? null, pe.actualDelivery ?? null);
  const leadVariance = quotedLead != null && actualLead != null ? actualLead - quotedLead : null;

  let onTime: boolean | null = null;
  if (pe.expectedDelivery && pe.actualDelivery) {
    onTime = new Date(pe.actualDelivery) <= new Date(pe.expectedDelivery);
  }

  const costVariance = quoted > 0 && actual > 0 ? ((actual - quoted) / quoted) * 100 : null;

  return { qualityPct, defectRate, fillRate, quotedLead, actualLead, leadVariance, onTime, costVariance, goodUnits, badUnits };
}

type Score = {
  score: number | null;
  grade: { letter: string; cls: string };
  confidence: string;
  confidenceClass: string;
  completedCount: number;
  totalPOs: number;
  activeProj: number;
  components: {
    quality: number | null;
    onTime: number | null;
    fillRate: number | null;
    leadReliability: number | null;
    costReliability: number | null;
  };
  totalSpend: number;
  totalReturned: number;
  totalDefective: number;
  totalOrdered: number;
  totalDelivered: number;
  primaryCurrency: string;
  avgLead: number | null;
};

function scoreToGrade(s: number | null): { letter: string; cls: string } {
  if (s == null || isNaN(s)) return { letter: "N/A", cls: "NA" };
  if (s >= 95) return { letter: "A+", cls: "Aplus" };
  if (s >= 90) return { letter: "A", cls: "A" };
  if (s >= 85) return { letter: "A-", cls: "Aminus" };
  if (s >= 80) return { letter: "B+", cls: "Bplus" };
  if (s >= 75) return { letter: "B", cls: "B" };
  if (s >= 70) return { letter: "B-", cls: "Bminus" };
  if (s >= 65) return { letter: "C+", cls: "Cplus" };
  if (s >= 60) return { letter: "C", cls: "C" };
  if (s >= 50) return { letter: "D", cls: "D" };
  return { letter: "F", cls: "F" };
}

function computeSupplierScore(s: FullSupplier): Score {
  const entries = (s.projectEntries || []).filter((p) => p.status !== "Cancelled");
  const completed = entries.filter((p) => ["Delivered", "Closed"].includes(p.status));
  const metrics = completed.map((e) => computeProjectMetrics(e));

  const qualities = metrics.map((m) => m.qualityPct).filter((v): v is number => v !== null);
  const qualityAvg = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null;
  const onTimes = metrics.map((m) => m.onTime).filter((v): v is boolean => v !== null);
  const onTimeRate = onTimes.length ? (onTimes.filter((o) => o).length / onTimes.length) * 100 : null;
  const fills = metrics.map((m) => m.fillRate).filter((v): v is number => v !== null);
  const fillAvg = fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : null;
  const leads = metrics.map((m) => m.leadVariance).filter((v): v is number => v !== null);
  const leadReliability = leads.length ? (leads.filter((v) => v <= 0).length / leads.length) * 100 : null;
  const costs = metrics.map((m) => m.costVariance).filter((v): v is number => v !== null);
  const costReliability = costs.length ? (costs.filter((v) => v <= 2).length / costs.length) * 100 : null;

  const components = { quality: qualityAvg, onTime: onTimeRate, fillRate: fillAvg, leadReliability, costReliability };
  let totalW = 0, sum = 0;
  (Object.keys(SCORE_WEIGHTS) as Array<keyof typeof SCORE_WEIGHTS>).forEach((k) => {
    const v = components[k];
    if (v !== null && !isNaN(v)) {
      sum += v * SCORE_WEIGHTS[k];
      totalW += SCORE_WEIGHTS[k];
    }
  });
  const score = totalW > 0 ? sum / totalW : null;

  const n = completed.length;
  let confidence = "No Data", confidenceClass = "none";
  if (n === 0) { confidence = "No Data"; confidenceClass = "none"; }
  else if (n < 3) { confidence = `Tentative · ${n} PO${n > 1 ? "s" : ""}`; confidenceClass = "tentative"; }
  else if (n < 6) { confidence = `Building · ${n} POs`; confidenceClass = "building"; }
  else if (n < 12) { confidence = `Established · ${n} POs`; confidenceClass = "established"; }
  else { confidence = `Proven · ${n} POs`; confidenceClass = "proven"; }

  const grade = scoreToGrade(score);
  const totalSpend = completed.reduce((acc, e) => acc + num(e.actualAmount), 0);
  const totalReturned = entries.reduce((acc, e) => acc + num(e.returnedQuantity), 0);
  const totalDefective = entries.reduce((acc, e) => acc + num(e.defectiveQuantity), 0);
  const totalOrdered = entries.reduce((acc, e) => acc + num(e.orderedQuantity), 0);
  const totalDelivered = entries.reduce((acc, e) => acc + num(e.deliveredQuantity), 0);
  const primaryCurrency = completed[0]?.currency || s.kpis?.currency || "USD";
  const leadsList = metrics.map((m) => m.actualLead).filter((x): x is number => x != null && x > 0);
  const avgLead = leadsList.length ? leadsList.reduce((a, b) => a + b, 0) / leadsList.length : null;
  const activeProj = entries.filter((p) => ["PO Issued", "In Production", "Shipped"].includes(p.status)).length;

  return {
    score, grade, confidence, confidenceClass,
    completedCount: n, totalPOs: entries.length, activeProj,
    components, totalSpend, totalReturned, totalDefective, totalOrdered, totalDelivered,
    primaryCurrency, avgLead,
  };
}

function colorFor(pct: number | null): "green" | "amber" | "red" | "blue" {
  if (pct == null) return "blue";
  if (pct >= 85) return "green";
  if (pct >= 65) return "amber";
  return "red";
}

function formatMoney(amt: number, cur: string) {
  const sym: Record<string, string> = { USD: "$", CAD: "C$", EUR: "€", CNY: "¥", JPY: "¥", GBP: "£", AUD: "A$" };
  const s = sym[cur] || "";
  if (amt >= 1_000_000) return `${s}${(amt / 1_000_000).toFixed(2)}M`;
  if (amt >= 1000) return `${s}${(amt / 1000).toFixed(1)}K`;
  return `${s}${amt.toFixed(0)}`;
}
function formatSize(b: number) {
  if (!b) return "—";
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 40;

export default function SuppliersView({
  initialData,
  canEdit,
}: {
  initialData: FullSupplier[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [data, setData] = useState<FullSupplier[]>(initialData);

  // Re-sync from server-rendered data on every revalidation.
  useEffect(() => { setData(initialData); }, [initialData]);

  const [searchName, setSearchName] = useState("");
  const [searchAll, setSearchAll] = useState("");
  const [fCat, setFCat] = useState("");
  const [fOrigin, setFOrigin] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fGrade, setFGrade] = useState("");
  const [fRisk, setFRisk] = useState("");
  const [sortCol, setSortCol] = useState("name");
  const [sortDir, setSortDir] = useState(1);
  const [pageNum, setPageNum] = useState(1);

  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "kpis" | "projects" | "comments" | "attachments">("details");

  const [showAddModal, setShowAddModal] = useState(false);
  const [showProjModal, setShowProjModal] = useState(false);
  const [editingProjId, setEditingProjId] = useState<number | null>(null);

  const [toastMsg, setToastMsg] = useState<{ msg: string; err?: boolean } | null>(null);
  function toast(msg: string, err = false) {
    setToastMsg({ msg, err });
    setTimeout(() => setToastMsg(null), 2400);
  }

  const active = useMemo(
    () => (activeId != null ? data.find((s) => s.id === activeId) ?? null : null),
    [data, activeId],
  );

  // ── Filtering + sort ──
  const filtered = useMemo(() => {
    const sName = searchName.toLowerCase().trim();
    const sAll = searchAll.toLowerCase().trim();
    let r = data.filter((s) => {
      if (sName && !s.name.toLowerCase().includes(sName)) return false;
      if (sAll) {
        const projs = (s.projectEntries || []).map((p) => p.projectNum).join(" ");
        const hay = [s.products, s.email, s.phone, s.website, projs, s.subCategory, s.notes].join(" ").toLowerCase();
        if (!hay.includes(sAll)) return false;
      }
      if (fCat && s.category !== fCat) return false;
      if (fOrigin && s.origin !== fOrigin) return false;
      if (fStatus && s.status !== fStatus) return false;
      if (fRisk && (s.kpis?.risk || "") !== fRisk) return false;
      if (fGrade) {
        const sc = computeSupplierScore(s).score;
        const min: Record<string, number> = { A: 85, B: 75, C: 65 };
        if (sc == null || sc < (min[fGrade] ?? 0)) return false;
      }
      return true;
    });

    r.sort((a, b) => {
      const ka = computeSupplierScore(a), kb = computeSupplierScore(b);
      let va: number | string, vb: number | string;
      if (sortCol === "_score" || sortCol === "_grade") { va = ka.score ?? -1; vb = kb.score ?? -1; }
      else if (sortCol === "_quality") { va = ka.components.quality ?? -1; vb = kb.components.quality ?? -1; }
      else if (sortCol === "_ontime") { va = ka.components.onTime ?? -1; vb = kb.components.onTime ?? -1; }
      else if (sortCol === "_fill") { va = ka.components.fillRate ?? -1; vb = kb.components.fillRate ?? -1; }
      else if (sortCol === "_lead") { va = ka.avgLead ?? 999; vb = kb.avgLead ?? 999; }
      else if (sortCol === "_spend") { va = ka.totalSpend; vb = kb.totalSpend; }
      else if (sortCol === "_proj") { va = ka.totalPOs; vb = kb.totalPOs; }
      else if (sortCol === "_conf") { va = ka.completedCount; vb = kb.completedCount; }
      else { va = (a[sortCol as keyof FullSupplier] as string ?? "").toString().toLowerCase();
             vb = (b[sortCol as keyof FullSupplier] as string ?? "").toString().toLowerCase(); }
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return r;
  }, [data, searchName, searchAll, fCat, fOrigin, fStatus, fGrade, fRisk, sortCol, sortDir]);

  // KPI strip aggregates
  const aggregates = useMemo(() => {
    let totalSpend = 0;
    const leads: number[] = [];
    let onTimeNum = 0, onTimeDen = 0;
    let fillSum = 0, fillCnt = 0;
    let scoreSum = 0, scoreCount = 0;
    filtered.forEach((s) => {
      const k = computeSupplierScore(s);
      if (k.score != null) { scoreSum += k.score; scoreCount++; }
      totalSpend += k.totalSpend;
      if (k.avgLead) leads.push(k.avgLead);
      (s.projectEntries || []).forEach((e) => {
        const m = computeProjectMetrics(e);
        if (m.onTime != null) { onTimeDen++; if (m.onTime) onTimeNum++; }
        if (m.fillRate != null) { fillSum += m.fillRate; fillCnt++; }
      });
    });
    return {
      avgScore: scoreCount ? scoreSum / scoreCount : null,
      onTime: onTimeDen ? (onTimeNum / onTimeDen) * 100 : null,
      fill: fillCnt ? fillSum / fillCnt : null,
      lead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
      totalSpend,
    };
  }, [filtered]);

  function resetFilters() {
    setSearchName(""); setSearchAll(""); setFCat(""); setFOrigin("");
    setFStatus(""); setFGrade(""); setFRisk(""); setPageNum(1);
  }
  function setSort(col: string) {
    if (sortCol === col) setSortDir(-sortDir);
    else { setSortCol(col); setSortDir(1); }
  }

  const start = (pageNum - 1) * PAGE_SIZE;
  const pageData = filtered.slice(start, start + PAGE_SIZE);

  // ── Side panel state (controlled-form fields) ──
  const [panelDetails, setPanelDetails] = useState<Partial<Supplier>>({});
  const [panelKpis, setPanelKpis] = useState<Record<string, string>>({});
  useEffect(() => {
    if (active) {
      setPanelDetails({ ...active });
      setPanelKpis({ ...(active.kpis ?? {}) });
    }
  }, [active]);

  function openPanel(id: number) {
    setActiveId(id);
    setActiveTab("details");
  }
  function closePanel() {
    setActiveId(null);
    setEditingProjId(null);
  }

  function runAction<T>(fn: () => Promise<T>, successMsg?: string) {
    startTransition(async () => {
      try {
        await fn();
        if (successMsg) toast(successMsg);
        router.refresh();
      } catch (e) {
        toast(e instanceof Error ? e.message : "Action failed", true);
      }
    });
  }

  function handleSavePanel() {
    if (!active) return;
    runAction(
      () => updateSupplier(active.id, { ...panelDetails, kpis: panelKpis }),
      `Saved ${panelDetails.name ?? active.name}`,
    );
  }
  function handleDeletePanel() {
    if (!active) return;
    if (!confirm("Delete this supplier?")) return;
    runAction(async () => {
      await deleteSupplier(active.id);
      closePanel();
    }, "Supplier deleted");
  }

  // ── Add modal state ──
  const [addForm, setAddForm] = useState({
    name: "", category: "", subCategory: "", origin: "", status: "Active",
    email: "", website: "", phone: "", products: "",
  });
  function handleSaveNew() {
    if (!addForm.name.trim()) return toast("Name is required", true);
    runAction(async () => {
      const s = await createSupplier({ ...addForm, onboarded: new Date().toISOString().slice(0, 10) });
      setShowAddModal(false);
      setAddForm({ name: "", category: "", subCategory: "", origin: "", status: "Active", email: "", website: "", phone: "", products: "" });
      if (s) setTimeout(() => setActiveId(s.id), 300);
    }, "Added supplier");
  }

  // ── Project entry modal ──
  const blankPE = (): ProjectEntryInput => ({
    projectNum: "", poNumber: "", status: "Quoted",
    quoteDate: "", poDate: "", expectedDelivery: "", actualDelivery: "",
    quotedLeadTime: 0, actualLeadTime: 0,
    orderedQuantity: 0, deliveredQuantity: 0, defectiveQuantity: 0, returnedQuantity: 0,
    quotedAmount: 0, actualAmount: 0,
    currency: active?.kpis?.currency || "USD",
    incoterms: active?.kpis?.incoterms || "",
    paymentTerms: active?.kpis?.paymentTerms || "",
    notes: "",
  });
  const [peForm, setPeForm] = useState<ProjectEntryInput>(blankPE());

  function openProjEntry(id: number | null) {
    if (!active) return;
    if (id) {
      const pe = active.projectEntries.find((p) => p.id === id);
      if (!pe) return;
      setPeForm({
        ...pe,
        // numerics: stored as strings (numeric column) → coerce
        quotedLeadTime: pe.quotedLeadTime,
        actualLeadTime: pe.actualLeadTime,
        orderedQuantity: pe.orderedQuantity,
        deliveredQuantity: pe.deliveredQuantity,
        defectiveQuantity: pe.defectiveQuantity,
        returnedQuantity: pe.returnedQuantity,
        quotedAmount: Number(pe.quotedAmount ?? 0),
        actualAmount: Number(pe.actualAmount ?? 0),
        notes: pe.notes ?? "",
      });
      setEditingProjId(id);
    } else {
      setPeForm(blankPE());
      setEditingProjId(null);
    }
    setShowProjModal(true);
  }

  function handleSaveProjEntry() {
    if (!active) return;
    if (!String(peForm.projectNum).trim()) return toast("Project # is required", true);
    runAction(
      () => upsertProjectEntry(active.id, { ...peForm, id: editingProjId ?? undefined }),
      "Project entry saved",
    );
    setShowProjModal(false);
  }
  function handleDeleteProjEntry() {
    if (!editingProjId) return;
    if (!confirm("Delete this project entry?")) return;
    runAction(() => deleteProjectEntry(editingProjId), "Entry deleted");
    setShowProjModal(false);
  }

  // Live preview for project entry modal
  const livePE = useMemo(() => computeProjectMetrics(peForm as Partial<SupplierProjectEntry>), [peForm]);

  // ── Comments ──
  const [newComment, setNewComment] = useState({ text: "", proj: "", author: "" });
  function handleAddComment() {
    if (!active || !newComment.text.trim()) return;
    runAction(async () => {
      await addSupplierComment(active.id, newComment.text, newComment.proj || null, newComment.author || null);
      setNewComment({ text: "", proj: "", author: "" });
    }, "Comment added");
  }

  // ── Attachments ──
  const [attSearch, setAttSearch] = useState("");
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  function toggleCat(id: string) {
    setCollapsedCats((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function uploadFiles(files: FileList | File[], catId: string) {
    if (!active) return;
    let successCount = 0;
    for (const f of Array.from(files)) {
      try {
        const pathname = `suppliers/${active.id}/${catId}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addSupplierAttachment(active.id, {
          catId, name: f.name, size: f.size, mimeType: f.type,
          url: blob.url, blobPathname: blob.pathname,
        });
        successCount++;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
    router.refresh();
    if (successCount > 0) toast(`${successCount} file${successCount > 1 ? "s" : ""} uploaded`);
  }

  function downloadAttachment(a: SupplierAttachment) {
    if (!a.url) return;
    const link = document.createElement("a");
    link.href = a.url;
    link.download = a.name;
    // Some browsers ignore download with cross-origin URLs — opening in new tab
    // is a safe fallback.
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  }

  // ── Export ──
  function handleExport() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suppliers_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Exported JSON");
  }

  // ── Render ──
  const score = active ? computeSupplierScore(active) : null;

  return (
    <>
      <style>{SUPPLIER_CSS}</style>
      <div className="sm-app">
        <div className="hdr">
          <div>
            <h1>Lightbase — Supplier Manager</h1>
            <p>Master Supplier List · Auto-Computed Performance Scoring · Project-Level KPI Tracking</p>
          </div>
          <div className="hdr-actions">
            <div className="badge"><span className="dot"></span><span>{data.length} Suppliers</span></div>
            {canEdit && <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>+ Add Supplier</button>}
            <button className="btn" onClick={handleExport}>Export JSON</button>
          </div>
        </div>

        {/* Filters */}
        <div className="search-row">
          <div className="search-group">
            <label>Supplier Name</label>
            <div className="search-wrap">
              <span className="ico">🔎</span>
              <input className="search-input" placeholder="Search by name..."
                value={searchName} onChange={(e) => { setSearchName(e.target.value); setPageNum(1); }} />
            </div>
          </div>
          <div className="search-group">
            <label>Everything Else</label>
            <div className="search-wrap">
              <span className="ico">🔎</span>
              <input className="search-input" placeholder="Products, projects, email, phone..."
                value={searchAll} onChange={(e) => { setSearchAll(e.target.value); setPageNum(1); }}
                style={{ minWidth: 280 }} />
            </div>
          </div>
          <div className="search-group">
            <label>Category</label>
            <select className="filter-sel" value={fCat} onChange={(e) => { setFCat(e.target.value); setPageNum(1); }}>
              <option value="">All</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="search-group">
            <label>Origin</label>
            <select className="filter-sel" value={fOrigin} onChange={(e) => { setFOrigin(e.target.value); setPageNum(1); }}>
              <option value="">All</option>
              {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="search-group">
            <label>Status</label>
            <select className="filter-sel" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPageNum(1); }}>
              <option value="">All</option>
              <option value="Active">Active</option>
              <option value="Historical">Historical</option>
            </select>
          </div>
          <div className="search-group">
            <label>Min Grade</label>
            <select className="filter-sel" value={fGrade} onChange={(e) => { setFGrade(e.target.value); setPageNum(1); }}>
              <option value="">Any</option>
              <option value="A">A or better</option>
              <option value="B">B or better</option>
              <option value="C">C or better</option>
            </select>
          </div>
          <div className="search-group">
            <label>Risk</label>
            <select className="filter-sel" value={fRisk} onChange={(e) => { setFRisk(e.target.value); setPageNum(1); }}>
              <option value="">All</option>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
            </select>
          </div>
          <div className="search-group" style={{ justifyContent: "flex-end" }}>
            <label>&nbsp;</label>
            <button className="btn btn-sm" onClick={resetFilters}>Reset</button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="kpi-row">
          <div className="kpi"><div className="kpi-label">Total</div><div className="kpi-val">{filtered.length}</div><div className="kpi-sub">of {data.length} total</div></div>
          <div className="kpi">
            <div className="kpi-label">Avg Grade</div>
            <div className="kpi-val">{aggregates.avgScore != null ? <span className={`grade grade-${scoreToGrade(aggregates.avgScore).cls}`} style={{ fontSize: 18 }}>{scoreToGrade(aggregates.avgScore).letter}</span> : "—"}</div>
            <div className="kpi-sub">{aggregates.avgScore != null ? `${aggregates.avgScore.toFixed(1)}/100 avg score` : "no scored suppliers"}</div>
          </div>
          <div className="kpi"><div className="kpi-label">On-Time</div><div className="kpi-val">{aggregates.onTime != null ? `${aggregates.onTime.toFixed(0)}%` : "—"}</div><div className="kpi-sub">across all POs</div></div>
          <div className="kpi"><div className="kpi-label">Fill Rate</div><div className="kpi-val">{aggregates.fill != null ? `${aggregates.fill.toFixed(0)}%` : "—"}</div><div className="kpi-sub">delivered/ordered</div></div>
          <div className="kpi"><div className="kpi-label">Avg Lead Time</div><div className="kpi-val">{aggregates.lead != null ? `${Math.round(aggregates.lead)}d` : "—"}</div><div className="kpi-sub">days actual</div></div>
          <div className="kpi"><div className="kpi-label">Total Spend</div><div className="kpi-val">{aggregates.totalSpend > 0 ? `$${(aggregates.totalSpend / 1000).toFixed(0)}K` : "—"}</div><div className="kpi-sub">closed POs</div></div>
        </div>

        {/* Charts */}
        <div className="chart-row">
          <div className="chart-card">
            <h3>Suppliers by Category <span className="hint">Click a bar to filter</span></h3>
            <div className="chart-canvas-wrap">
              <CategoryChart
                data={filtered}
                onSelect={(cat) => { setFCat(cat); setPageNum(1); }}
              />
            </div>
          </div>
          <div className="chart-card">
            <h3>Suppliers by Origin <span className="hint">Click a slice to filter</span></h3>
            <div className="chart-canvas-wrap">
              <OriginChart
                data={filtered}
                onSelect={(origin) => { setFOrigin(origin); setPageNum(1); }}
              />
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="tbl-card">
          <div className="tbl-hdr">
            <div style={{ display: "flex", alignItems: "center" }}>
              <h3>Supplier Directory</h3>
              <span className="tbl-count">{filtered.length} suppliers</span>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    ["_grade", "Grade"], ["name", "Supplier"], ["category", "Category"],
                    ["origin", "Origin"], ["_score", "Score"], ["_quality", "Quality"],
                    ["_ontime", "On-Time"], ["_fill", "Fill Rate"], ["_lead", "Lead Time"],
                    ["_spend", "Spend"], ["_proj", "POs"], ["_conf", "Confidence"],
                  ].map(([col, label]) => (
                    <th key={col} className={sortCol === col ? "sorted" : ""} onClick={() => setSort(col)}>
                      {label}{sortCol === col ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageData.map((s) => {
                  const k = computeSupplierScore(s);
                  const c = k.components;
                  const colorize = (v: number | null) =>
                    v == null ? "var(--t3)" : v >= 85 ? "var(--green)" : v >= 65 ? "var(--amber)" : "var(--red)";
                  return (
                    <tr key={s.id} onClick={() => openPanel(s.id)}>
                      <td><span className={`grade grade-${k.grade.cls}`}>{k.grade.letter}</span></td>
                      <td><strong>{s.name}</strong></td>
                      <td>{s.category}</td>
                      <td><span className="tag tag-origin">{s.origin || "—"}</span></td>
                      <td>{k.score != null ? <strong>{k.score.toFixed(0)}</strong> : <span style={{ color: "var(--t3)" }}>—</span>}</td>
                      <td><span style={{ color: colorize(c.quality), fontWeight: 600 }}>{c.quality != null ? `${c.quality.toFixed(0)}%` : "—"}</span></td>
                      <td><span style={{ color: colorize(c.onTime), fontWeight: 600 }}>{c.onTime != null ? `${c.onTime.toFixed(0)}%` : "—"}</span></td>
                      <td><span style={{ color: colorize(c.fillRate), fontWeight: 600 }}>{c.fillRate != null ? `${c.fillRate.toFixed(0)}%` : "—"}</span></td>
                      <td>{k.avgLead ? Math.round(k.avgLead) + "d" : (s.kpis?.leadTime || "—")}</td>
                      <td>{k.totalSpend > 0 ? formatMoney(k.totalSpend, k.primaryCurrency) : "—"}</td>
                      <td>{k.totalPOs ? <span className="tag tag-cat">{k.totalPOs}</span> : "—"}</td>
                      <td><span className={`confidence-pill conf-${k.confidenceClass}`}>{k.confidence}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pag">
            <span>{filtered.length ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}` : "No results"}</span>
            <div className="pag-btns">
              <button className="btn btn-sm" disabled={pageNum <= 1} onClick={() => setPageNum((n) => n - 1)}>← Prev</button>
              <button className="btn btn-sm" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setPageNum((n) => n + 1)}>Next →</button>
            </div>
          </div>
        </div>
      </div>

      {/* Side Panel */}
      {active && (
        <>
          <div className="panel-overlay show" onClick={closePanel} />
          <div className="panel show">
            <div className="panel-head">
              <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                <h2>{active.name}</h2>
              </div>
              <div className="head-grade">
                <span className={`grade grade-${score!.grade.cls}`}>{score!.grade.letter}</span>
                <span className={`confidence-pill conf-${score!.confidenceClass}`}>{score!.confidence}</span>
              </div>
              <button className="btn btn-ghost" onClick={closePanel} style={{ fontSize: 22 }}>×</button>
            </div>
            <div className="panel-tabs">
              {[
                ["details", "Details"],
                ["kpis", "📊 Performance"],
                ["projects", `📋 Projects (${active.projectEntries.length})`],
                ["comments", `💬 Comments (${active.comments.length})`],
                ["attachments", `📎 Attachments (${active.attachments.length})`],
              ].map(([k, label]) => (
                <div key={k} className={`panel-tab ${activeTab === k ? "active" : ""}`} onClick={() => setActiveTab(k as typeof activeTab)}>
                  {label}
                </div>
              ))}
            </div>
            <div className="panel-body">
              {activeTab === "details" && (
                <DetailsTab details={panelDetails} setDetails={setPanelDetails} canEdit={canEdit} />
              )}
              {activeTab === "kpis" && (
                <PerformanceTab supplier={active} score={score!} kpis={panelKpis} setKpis={setPanelKpis} canEdit={canEdit} />
              )}
              {activeTab === "projects" && (
                <ProjectsTab
                  supplier={active}
                  canEdit={canEdit}
                  onAdd={() => openProjEntry(null)}
                  onEdit={(id) => openProjEntry(id)}
                />
              )}
              {activeTab === "comments" && (
                <CommentsTab
                  supplier={active}
                  canEdit={canEdit}
                  newComment={newComment}
                  setNewComment={setNewComment}
                  onAdd={handleAddComment}
                  onDelete={(id) => runAction(() => deleteSupplierComment(id), "Comment deleted")}
                />
              )}
              {activeTab === "attachments" && (
                <AttachmentsTab
                  supplier={active}
                  canEdit={canEdit}
                  attSearch={attSearch}
                  setAttSearch={setAttSearch}
                  collapsedCats={collapsedCats}
                  toggleCat={toggleCat}
                  onUpload={uploadFiles}
                  onDelete={(id) => runAction(() => deleteSupplierAttachment(id), "Deleted")}
                  onDownload={downloadAttachment}
                />
              )}
            </div>
            <div className="panel-foot">
              {canEdit && <button className="btn btn-danger" onClick={handleDeletePanel}>Delete Supplier</button>}
              <button className="btn" onClick={closePanel}>Close</button>
              {canEdit && (activeTab === "details" || activeTab === "kpis") && (
                <button className="btn btn-primary" onClick={handleSavePanel}>Save Changes</button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="modal-overlay show" onClick={(e) => e.target === e.currentTarget && setShowAddModal(false)}>
          <div className="modal">
            <div className="modal-head"><h2>Add New Supplier</h2></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group"><label>Supplier Name *</label><input className="form-input" value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))} /></div>
                <div className="form-group"><label>Category *</label><select className="form-input" value={addForm.category} onChange={(e) => setAddForm((f) => ({ ...f, category: e.target.value }))}>
                  <option value="">—</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select></div>
                <div className="form-group"><label>Sub-Category</label><input className="form-input" value={addForm.subCategory} onChange={(e) => setAddForm((f) => ({ ...f, subCategory: e.target.value }))} /></div>
                <div className="form-group"><label>Origin</label><select className="form-input" value={addForm.origin} onChange={(e) => setAddForm((f) => ({ ...f, origin: e.target.value }))}>
                  <option value="">—</option>
                  {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select></div>
                <div className="form-group"><label>Status</label><select className="form-input" value={addForm.status} onChange={(e) => setAddForm((f) => ({ ...f, status: e.target.value }))}>
                  <option value="Active">Active</option><option value="Historical">Historical</option>
                </select></div>
                <div className="form-group"><label>Email</label><input className="form-input" value={addForm.email} onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))} /></div>
                <div className="form-group"><label>Website</label><input className="form-input" value={addForm.website} onChange={(e) => setAddForm((f) => ({ ...f, website: e.target.value }))} /></div>
                <div className="form-group"><label>Phone</label><input className="form-input" value={addForm.phone} onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))} /></div>
                <div className="form-group full"><label>Products</label><textarea className="form-input" value={addForm.products} onChange={(e) => setAddForm((f) => ({ ...f, products: e.target.value }))} /></div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveNew}>+ Add Supplier</button>
            </div>
          </div>
        </div>
      )}

      {/* Project Entry Modal */}
      {showProjModal && (
        <div className="modal-overlay show" onClick={(e) => e.target === e.currentTarget && setShowProjModal(false)}>
          <div className="modal">
            <div className="modal-head"><h2>{editingProjId ? `Edit Project Entry · ${peForm.projectNum}` : "Add Project Entry"}</h2></div>
            <div className="modal-body">
              <ProjectEntryFields form={peForm} setForm={setPeForm} live={livePE} />
            </div>
            <div className="modal-foot">
              {editingProjId != null && <button className="btn btn-danger" onClick={handleDeleteProjEntry}>Delete</button>}
              <button className="btn" onClick={() => setShowProjModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveProjEntry}>Save Entry</button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && <div className={`toast show ${toastMsg.err ? "error" : ""}`}>{toastMsg.msg}</div>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (tabs)
// ─────────────────────────────────────────────────────────────────────────────

function DetailsTab({
  details, setDetails, canEdit,
}: {
  details: Partial<Supplier>;
  setDetails: React.Dispatch<React.SetStateAction<Partial<Supplier>>>;
  canEdit: boolean;
}) {
  const set = (k: keyof Supplier) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setDetails((d) => ({ ...d, [k]: e.target.value }));
  const ro = !canEdit;
  return (
    <div className="form-grid">
      <div className="form-group"><label>Supplier Name</label><input className="form-input" value={details.name ?? ""} onChange={set("name")} disabled={ro} /></div>
      <div className="form-group"><label>Category</label><select className="form-input" value={details.category ?? ""} onChange={set("category")} disabled={ro}><option value="">—</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
      <div className="form-group"><label>Sub-Category</label><input className="form-input" value={details.subCategory ?? ""} onChange={set("subCategory")} disabled={ro} /></div>
      <div className="form-group"><label>Origin</label><select className="form-input" value={details.origin ?? ""} onChange={set("origin")} disabled={ro}><option value="">—</option>{ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
      <div className="form-group"><label>Status</label><select className="form-input" value={details.status ?? "Active"} onChange={set("status")} disabled={ro}><option value="Active">Active</option><option value="Historical">Historical</option></select></div>
      <div className="form-group"><label>Contact Name</label><input className="form-input" value={details.contactName ?? ""} onChange={set("contactName")} disabled={ro} /></div>
      <div className="form-group"><label>Email</label><input className="form-input" value={details.email ?? ""} onChange={set("email")} disabled={ro} /></div>
      <div className="form-group"><label>Website</label><input className="form-input" value={details.website ?? ""} onChange={set("website")} disabled={ro} /></div>
      <div className="form-group"><label>Phone</label><input className="form-input" value={details.phone ?? ""} onChange={set("phone")} disabled={ro} /></div>
      <div className="form-group"><label>Tested</label><select className="form-input" value={details.tested ?? ""} onChange={set("tested")} disabled={ro}><option value="">—</option><option>Yes</option><option>No</option></select></div>
      <div className="form-group"><label>Source</label><input className="form-input" value={details.source ?? ""} onChange={set("source")} disabled={ro} /></div>
      <div className="form-group"><label>Onboarded Date</label><input className="form-input" type="date" value={details.onboarded ?? ""} onChange={set("onboarded")} disabled={ro} /></div>
      <div className="form-group full"><label>Products</label><textarea className="form-input" value={details.products ?? ""} onChange={set("products")} disabled={ro} /></div>
      <div className="form-group full"><label>Internal Notes</label><textarea className="form-input" value={details.notes ?? ""} onChange={set("notes")} disabled={ro} placeholder="Strategic notes..." /></div>
    </div>
  );
}

function PerformanceTab({
  supplier, score, kpis, setKpis, canEdit,
}: {
  supplier: FullSupplier; score: Score;
  kpis: Record<string, string>;
  setKpis: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  canEdit: boolean;
}) {
  const ro = !canEdit;
  const setK = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setKpis((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      {score.score == null ? (
        <div className="score-hero no-data">
          <div className="grade-big">N/A</div>
          <div className="score-info">
            <div className="score-num">No completed POs yet</div>
            <div className="score-label">Score will compute as you log delivered/closed projects.</div>
            <div className="score-meta"><span>{supplier.projectEntries.length} entries logged</span><span>{score.activeProj} active</span></div>
          </div>
        </div>
      ) : (
        <div className="score-hero">
          <div className="grade-big">{score.grade.letter}</div>
          <div className="score-info">
            <div className="score-num">{score.score.toFixed(1)}<small>/100</small></div>
            <div className="score-label">Composite Performance Score · <span className={`confidence-pill conf-${score.confidenceClass}`} style={{ background: "rgba(255,255,255,.18)", color: "#fff" }}>{score.confidence}</span></div>
            <div className="score-meta">
              <span>{score.completedCount} completed</span>
              <span>{score.activeProj} active</span>
              <span>{score.totalPOs} total POs</span>
              <span>{formatMoney(score.totalSpend, score.primaryCurrency)} spend</span>
            </div>
          </div>
        </div>
      )}

      <div className="section-title first">📊 Score Breakdown <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>Each metric is auto-computed from project data</span></div>
      <div className="score-bars">
        {([
          { key: "quality", label: "Quality", weight: 30, val: score.components.quality, desc: score.totalDelivered ? `${score.totalDelivered - score.totalDefective - score.totalReturned} good of ${score.totalDelivered} delivered (${score.totalDefective} defective, ${score.totalReturned} returned)` : "no delivered units" },
          { key: "onTime", label: "On-Time Delivery", weight: 25, val: score.components.onTime, desc: "POs delivered on or before expected date" },
          { key: "fillRate", label: "Fill Rate", weight: 20, val: score.components.fillRate, desc: score.totalOrdered ? `${score.totalDelivered.toLocaleString()} delivered of ${score.totalOrdered.toLocaleString()} ordered units` : "no orders" },
          { key: "leadReliability", label: "Lead Time Reliability", weight: 15, val: score.components.leadReliability, desc: "POs where actual lead time ≤ quoted" },
          { key: "costReliability", label: "Cost Reliability", weight: 10, val: score.components.costReliability, desc: "POs where final cost ≤ quoted (≤2% variance)" },
        ] as const).map((b) => {
          const color = colorFor(b.val);
          const colorMap = { green: "var(--green)", amber: "var(--amber)", red: "var(--red)", blue: "var(--accent)" };
          return (
            <div key={b.key} className="score-bar-row">
              <div className="row-top">
                <div className="row-name">{b.label} <span className="weight-tag">weight {b.weight}%</span></div>
                <div className="row-val" style={{ color: b.val == null ? "var(--t3)" : colorMap[color] }}>{b.val != null ? `${b.val.toFixed(1)}%` : "no data"}</div>
              </div>
              <div className="row-bar"><div className="row-bar-fill" style={{ background: b.val == null ? "var(--border)" : colorMap[color], width: `${b.val ?? 0}%` }}></div></div>
              <div className="row-sub">{b.desc}</div>
            </div>
          );
        })}
      </div>

      <div className="section-title">💼 Commercial Terms <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>Reference info — not part of score</span></div>
      <div className="form-grid-3">
        <div className="form-group"><label>Standard Lead Time</label><input className="form-input" value={kpis.leadTime ?? ""} onChange={setK("leadTime")} disabled={ro} /></div>
        <div className="form-group"><label>MOQ</label><input className="form-input" value={kpis.moq ?? ""} onChange={setK("moq")} disabled={ro} /></div>
        <div className="form-group"><label>Annual Capacity</label><input className="form-input" value={kpis.capacity ?? ""} onChange={setK("capacity")} disabled={ro} /></div>
        <div className="form-group"><label>Payment Terms</label><select className="form-input" value={kpis.paymentTerms ?? ""} onChange={setK("paymentTerms")} disabled={ro}><option value="">—</option><option>Net 30</option><option>Net 45</option><option>Net 60</option><option>Net 90</option><option>50/50 T/T</option><option>30/70 T/T</option><option>100% Advance</option><option>L/C at sight</option><option>L/C 30 days</option><option>L/C 60 days</option></select></div>
        <div className="form-group"><label>Currency</label><select className="form-input" value={kpis.currency ?? ""} onChange={setK("currency")} disabled={ro}><option value="">—</option><option>USD</option><option>CAD</option><option>EUR</option><option>CNY</option><option>JPY</option><option>GBP</option><option>AUD</option></select></div>
        <div className="form-group"><label>Incoterms</label><select className="form-input" value={kpis.incoterms ?? ""} onChange={setK("incoterms")} disabled={ro}><option value="">—</option>{["EXW","FOB","FCA","CIF","CFR","CIP","DAP","DDP"].map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="form-group"><label>Risk Rating</label><select className="form-input" value={kpis.risk ?? ""} onChange={setK("risk")} disabled={ro}><option value="">—</option><option>Low</option><option>Medium</option><option>High</option></select></div>
        <div className="form-group"><label>Backup Supplier</label><input className="form-input" value={kpis.backup ?? ""} onChange={setK("backup")} disabled={ro} /></div>
        <div className="form-group"><label>Insurance Expiry</label><input className="form-input" type="date" value={kpis.insurance ?? ""} onChange={setK("insurance")} disabled={ro} /></div>
      </div>

      <div className="section-title">🛡 Compliance & Certs</div>
      <div className="form-grid-3">
        {[
          ["iso", "ISO 9001", ["Yes", "No", "Pending"]],
          ["ul", "UL Listed", ["Yes", "No", "Partial"]],
          ["ce", "CE Marked", ["Yes", "No", "Partial"]],
          ["rohs", "RoHS", ["Yes", "No"]],
          ["nda", "NDA Signed", ["Yes", "No", "Pending"]],
          ["msa", "MSA Signed", ["Yes", "No", "Pending"]],
        ].map(([k, label, opts]) => (
          <div className="form-group" key={k as string}>
            <label>{label as string}</label>
            <select className="form-input" value={kpis[k as string] ?? ""} onChange={setK(k as string)} disabled={ro}>
              <option value="">—</option>
              {(opts as string[]).map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
        ))}
      </div>
    </>
  );
}

function ProjectsTab({ supplier, canEdit, onAdd, onEdit }: {
  supplier: FullSupplier; canEdit: boolean;
  onAdd: () => void; onEdit: (id: number) => void;
}) {
  const sorted = [...supplier.projectEntries].sort((a, b) =>
    (b.poDate ?? b.quoteDate ?? "").localeCompare(a.poDate ?? a.quoteDate ?? ""),
  );
  return (
    <>
      <div className="section-title first">📋 Project Performance Log {canEdit && <span><button className="btn btn-sm btn-primary" onClick={onAdd}>+ Add Project Entry</button></span>}</div>
      {!sorted.length ? (
        <div className="att-empty">No project entries yet. Click &quot;+ Add Project Entry&quot; to log your first quote, PO, or delivery.</div>
      ) : sorted.map((pe) => {
        const m = computeProjectMetrics(pe);
        const stCls = ({ Quoted: "status-quoted", "PO Issued": "status-po", "In Production": "status-prod", Shipped: "status-shipped", Delivered: "status-delivered", Closed: "status-closed", Cancelled: "status-cancelled" } as Record<string, string>)[pe.status] || "status-quoted";
        const qualClass = m.qualityPct == null ? "" : m.qualityPct >= 98 ? "green" : m.qualityPct >= 92 ? "amber" : "red";
        const fillClass = m.fillRate == null ? "" : m.fillRate >= 98 ? "green" : m.fillRate >= 90 ? "amber" : "red";
        const leadClass = m.leadVariance == null ? "" : m.leadVariance <= 0 ? "green" : m.leadVariance <= 3 ? "amber" : "red";
        const costClass = m.costVariance == null ? "" : m.costVariance <= 0 ? "green" : m.costVariance <= 5 ? "amber" : "red";
        const onTimeClass = m.onTime == null ? "" : m.onTime ? "green" : "red";
        return (
          <details key={pe.id} className="proj-entry">
            <summary className="proj-entry-head">
              <div className="pe-id">📋 Project {pe.projectNum} {pe.poNumber ? `· ${pe.poNumber}` : ""}</div>
              <div className="pe-meta">
                <span className={`tag-status ${stCls}`}>{pe.status}</span>
                {Number(pe.actualAmount) > 0 && <span className="tag tag-cat">{formatMoney(Number(pe.actualAmount), pe.currency || "USD")}</span>}
                {m.onTime === true && <span className="ontime-yes" style={{ fontSize: 12, fontWeight: 600 }}>✓ On-Time</span>}
                {m.onTime === false && <span className="ontime-no" style={{ fontSize: 12, fontWeight: 600 }}>✗ Late</span>}
                {canEdit && <button className="btn btn-sm" onClick={(e) => { e.preventDefault(); onEdit(pe.id); }}>Edit</button>}
              </div>
            </summary>
            <div className="proj-entry-body">
              <div className="pe-metric-row">
                <div className={`pe-metric ${qualClass}`}><div className="pem-label">Quality</div><div className="pem-val">{m.qualityPct != null ? `${m.qualityPct.toFixed(1)}%` : "—"}</div></div>
                <div className={`pe-metric ${fillClass}`}><div className="pem-label">Fill Rate</div><div className="pem-val">{m.fillRate != null ? `${m.fillRate.toFixed(1)}%` : "—"}</div></div>
                <div className={`pe-metric ${onTimeClass}`}><div className="pem-label">On-Time</div><div className="pem-val">{m.onTime == null ? "—" : m.onTime ? "Yes" : "No"}</div></div>
                <div className={`pe-metric ${leadClass}`}><div className="pem-label">Lead Var</div><div className="pem-val">{m.leadVariance == null ? "—" : `${m.leadVariance > 0 ? "+" : ""}${m.leadVariance}d`}</div></div>
                <div className={`pe-metric ${costClass}`}><div className="pem-label">Cost Var</div><div className="pem-val">{m.costVariance == null ? "—" : `${m.costVariance > 0 ? "+" : ""}${m.costVariance.toFixed(1)}%`}</div></div>
              </div>
              <div className="pe-summary">
                <div className="pe-cell">PO Date<strong>{pe.poDate || "—"}</strong></div>
                <div className="pe-cell">Expected<strong>{pe.expectedDelivery || "—"}</strong></div>
                <div className="pe-cell">Actual<strong>{pe.actualDelivery || "—"}</strong></div>
                <div className="pe-cell">Lead Time<strong>{m.actualLead ? `${m.actualLead}d` : "—"}{m.quotedLead ? ` (quoted ${m.quotedLead}d)` : ""}</strong></div>
                <div className="pe-cell">Ordered<strong>{pe.orderedQuantity ? Number(pe.orderedQuantity).toLocaleString() : "—"}</strong></div>
                <div className="pe-cell">Delivered<strong>{pe.deliveredQuantity ? Number(pe.deliveredQuantity).toLocaleString() : "—"}</strong></div>
                <div className="pe-cell">Defective<strong>{pe.defectiveQuantity || 0}</strong></div>
                <div className="pe-cell">Returned<strong>{pe.returnedQuantity || 0}</strong></div>
                <div className="pe-cell">Quoted<strong>{Number(pe.quotedAmount) > 0 ? formatMoney(Number(pe.quotedAmount), pe.currency || "USD") : "—"}</strong></div>
                <div className="pe-cell">Actual<strong>{Number(pe.actualAmount) > 0 ? formatMoney(Number(pe.actualAmount), pe.currency || "USD") : "—"}</strong></div>
              </div>
              {pe.notes && <div style={{ fontSize: 12, color: "var(--t2)", background: "var(--card2)", padding: "8px 10px", borderRadius: 6 }}><strong>Notes:</strong> {pe.notes}</div>}
            </div>
          </details>
        );
      })}
    </>
  );
}

function CommentsTab({
  supplier, canEdit, newComment, setNewComment, onAdd, onDelete,
}: {
  supplier: FullSupplier; canEdit: boolean;
  newComment: { text: string; proj: string; author: string };
  setNewComment: React.Dispatch<React.SetStateAction<{ text: string; proj: string; author: string }>>;
  onAdd: () => void;
  onDelete: (id: number) => void;
}) {
  return (
    <>
      <div className="section-title first">Comment Log <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>{supplier.comments.length} entries</span></div>
      <div className="comment-log">
        {supplier.comments.length === 0 && <div className="att-empty">No comments yet.</div>}
        {supplier.comments.map((c) => (
          <div key={c.id} className="comment-entry">
            <div className="comment-meta">
              <span><strong>{c.author || "—"}</strong></span>
              <span>{c.date ?? ""}</span>
              {c.projectNum && <span className="proj-tag">Project {c.projectNum}</span>}
            </div>
            <div className="comment-text">{c.text}</div>
            {canEdit && <button className="comment-del" onClick={() => confirm("Delete this comment?") && onDelete(c.id)}>×</button>}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="comment-add">
          <textarea className="form-input" placeholder="Add a comment..." rows={2}
            value={newComment.text} onChange={(e) => setNewComment((c) => ({ ...c, text: e.target.value }))} />
          <div className="comment-add-row">
            <input className="form-input" placeholder="Project #" style={{ width: 110 }}
              value={newComment.proj} onChange={(e) => setNewComment((c) => ({ ...c, proj: e.target.value }))} />
            <input className="form-input" placeholder="Your name" style={{ width: 140 }}
              value={newComment.author} onChange={(e) => setNewComment((c) => ({ ...c, author: e.target.value }))} />
            <button className="btn btn-sm btn-primary" onClick={onAdd}>Add Comment</button>
          </div>
        </div>
      )}
    </>
  );
}

function AttachmentsTab({
  supplier, canEdit, attSearch, setAttSearch, collapsedCats, toggleCat, onUpload, onDelete, onDownload,
}: {
  supplier: FullSupplier; canEdit: boolean;
  attSearch: string; setAttSearch: (v: string) => void;
  collapsedCats: Set<string>; toggleCat: (id: string) => void;
  onUpload: (files: FileList | File[], catId: string) => void;
  onDelete: (id: number) => void;
  onDownload: (a: SupplierAttachment) => void;
}) {
  const search = attSearch.toLowerCase().trim();
  return (
    <>
      <div className="att-toolbar">
        <input type="text" className="att-search" placeholder="Search attachments..." value={attSearch} onChange={(e) => setAttSearch(e.target.value)} />
      </div>
      <div className="att-cats">
        {ATT_CATEGORIES.map((cat) => {
          const items = supplier.attachments.filter((a) => a.catId === cat.id && (!search || a.name.toLowerCase().includes(search)));
          const collapsed = collapsedCats.has(cat.id);
          return (
            <div key={cat.id} className={`att-cat ${collapsed ? "collapsed" : ""}`}>
              <div className="att-cat-head" onClick={() => toggleCat(cat.id)}>
                <div className="cat-title">
                  <div className="cat-icon" style={{ background: `${cat.color}22`, color: cat.color }}>{cat.icon}</div>
                  <div>
                    <div>{cat.label}</div>
                    <div style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>{cat.desc}</div>
                  </div>
                </div>
                <div className="cat-actions">
                  <span className="cat-count">{items.length}</span>
                  {canEdit && (
                    <label className="btn btn-sm" onClick={(e) => e.stopPropagation()}>
                      + Add
                      <input type="file" multiple style={{ display: "none" }} onChange={(e) => {
                        if (e.target.files) onUpload(e.target.files, cat.id);
                        e.target.value = "";
                      }} />
                    </label>
                  )}
                </div>
              </div>
              <div className="att-cat-body">
                <div className="att-list">
                  {items.length === 0 ? <div className="att-empty">No files in this category yet.</div> :
                    items.map((a) => {
                      const ext = (a.name.split(".").pop() || "").toLowerCase();
                      let cls = ""; const label = ext.toUpperCase();
                      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) cls = "img";
                      else if (["doc", "docx"].includes(ext)) cls = "doc";
                      else if (["xls", "xlsx", "csv"].includes(ext)) cls = "xls";
                      else if (["zip", "rar", "7z"].includes(ext)) cls = "zip";
                      return (
                        <div key={a.id} className="att-item">
                          <div className={`file-ico ${cls}`}>{label}</div>
                          <div className="file-info">
                            <div className="file-name">{a.name}</div>
                            <div className="file-meta">
                              <span>{formatSize(a.size)}</span>
                              <span>{a.date ?? ""}</span>
                              {a.uploader && <span>by {a.uploader}</span>}
                            </div>
                          </div>
                          <div className="file-actions">
                            <button className="icon-btn" onClick={() => onDownload(a)} title="Download">⬇</button>
                            {canEdit && <button className="icon-btn danger" onClick={() => confirm(`Delete "${a.name}"?`) && onDelete(a.id)} title="Delete">🗑</button>}
                          </div>
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ProjectEntryFields({ form, setForm, live }: { form: ProjectEntryInput; setForm: React.Dispatch<React.SetStateAction<ProjectEntryInput>>; live: Metrics }) {
  const set = <K extends keyof ProjectEntryInput>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value as ProjectEntryInput[K] }));
  return (
    <>
      <div className="section-title first">📋 Project Identification</div>
      <div className="form-grid-3">
        <div className="form-group"><label>Project # *</label><input className="form-input" value={form.projectNum} onChange={set("projectNum")} /></div>
        <div className="form-group"><label>PO Number</label><input className="form-input" value={form.poNumber ?? ""} onChange={set("poNumber")} /></div>
        <div className="form-group"><label>Status</label><select className="form-input" value={form.status} onChange={set("status")}>{["Quoted", "PO Issued", "In Production", "Shipped", "Delivered", "Closed", "Cancelled"].map((s) => <option key={s}>{s}</option>)}</select></div>
      </div>

      <div className="section-title">📅 Dates & Lead Time</div>
      <div className="form-grid-3">
        <div className="form-group"><label>Quote Date</label><input className="form-input" type="date" value={form.quoteDate ?? ""} onChange={set("quoteDate")} /></div>
        <div className="form-group"><label>PO Date</label><input className="form-input" type="date" value={form.poDate ?? ""} onChange={set("poDate")} /></div>
        <div className="form-group"><label>Expected Delivery</label><input className="form-input" type="date" value={form.expectedDelivery ?? ""} onChange={set("expectedDelivery")} /></div>
        <div className="form-group"><label>Actual Delivery</label><input className="form-input" type="date" value={form.actualDelivery ?? ""} onChange={set("actualDelivery")} /></div>
        <div className="form-group"><label>Quoted Lead Time (days)</label><input className="form-input" type="number" value={form.quotedLeadTime as number} onChange={set("quotedLeadTime")} /></div>
        <div className="form-group"><label>Actual Lead Time (days)</label><input className="form-input" type="number" value={form.actualLeadTime as number} onChange={set("actualLeadTime")} /></div>
      </div>

      <div className="section-title">📦 Quantity & Quality</div>
      <div className="form-grid-3">
        <div className="form-group"><label>Ordered Quantity *</label><input className="form-input" type="number" value={form.orderedQuantity as number} onChange={set("orderedQuantity")} /></div>
        <div className="form-group"><label>Delivered Quantity</label><input className="form-input" type="number" value={form.deliveredQuantity as number} onChange={set("deliveredQuantity")} /></div>
        <div className="form-group"><label>Defective Units</label><input className="form-input" type="number" value={form.defectiveQuantity as number} onChange={set("defectiveQuantity")} /></div>
        <div className="form-group"><label>Returned/Rejected Units</label><input className="form-input" type="number" value={form.returnedQuantity as number} onChange={set("returnedQuantity")} /></div>
      </div>

      <div className="section-title">💵 Cost</div>
      <div className="form-grid-3">
        <div className="form-group"><label>Quoted Amount</label><input className="form-input" type="number" step="0.01" value={form.quotedAmount as number} onChange={set("quotedAmount")} /></div>
        <div className="form-group"><label>Actual Amount</label><input className="form-input" type="number" step="0.01" value={form.actualAmount as number} onChange={set("actualAmount")} /></div>
        <div className="form-group"><label>Currency</label><select className="form-input" value={form.currency ?? "USD"} onChange={set("currency")}>{["USD","CAD","EUR","CNY","JPY","GBP"].map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="form-group"><label>Incoterms</label><select className="form-input" value={form.incoterms ?? ""} onChange={set("incoterms")}><option value="">—</option>{["EXW","FOB","FCA","CIF","CFR","CIP","DAP","DDP"].map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="form-group"><label>Payment Terms</label><input className="form-input" value={form.paymentTerms ?? ""} onChange={set("paymentTerms")} /></div>
      </div>

      <div className="section-title">⚡ Live Computed Metrics</div>
      <div className="live-preview">
        <div className="lp-cell">
          <div className="lp-label">Quality</div>
          <div className={`lp-val ${live.qualityPct == null ? "" : live.qualityPct >= 98 ? "green" : live.qualityPct >= 92 ? "amber" : "red"}`}>{live.qualityPct != null ? `${live.qualityPct.toFixed(1)}%` : "—"}</div>
        </div>
        <div className="lp-cell">
          <div className="lp-label">Fill Rate</div>
          <div className={`lp-val ${live.fillRate == null ? "" : live.fillRate >= 98 ? "green" : live.fillRate >= 90 ? "amber" : "red"}`}>{live.fillRate != null ? `${live.fillRate.toFixed(1)}%` : "—"}</div>
        </div>
        <div className="lp-cell">
          <div className="lp-label">Lead Time</div>
          <div className={`lp-val ${live.leadVariance == null ? "" : live.leadVariance <= 0 ? "green" : live.leadVariance <= 3 ? "amber" : "red"}`}>{live.leadVariance == null ? "—" : `${live.leadVariance > 0 ? "+" : ""}${live.leadVariance}d`}</div>
        </div>
        <div className="lp-cell">
          <div className="lp-label">Cost Variance</div>
          <div className={`lp-val ${live.costVariance == null ? "" : live.costVariance <= 0 ? "green" : live.costVariance <= 5 ? "amber" : "red"}`}>{live.costVariance == null ? "—" : `${live.costVariance > 0 ? "+" : ""}${live.costVariance.toFixed(1)}%`}</div>
        </div>
      </div>

      <div className="section-title">📝 Notes</div>
      <textarea className="form-input" rows={3} value={form.notes ?? ""} onChange={set("notes")} placeholder="Issues, observations, lessons learned..." />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline CSS lifted from the original Lightbase HTML (lightly cleaned)
// ─────────────────────────────────────────────────────────────────────────────

const SUPPLIER_CSS = `
.sm-app{
  --bg:#eef1f5;--bg2:#ffffff;--card:#ffffff;--card2:#f4f6fa;
  --border:#d5dbe5;--border2:#c0c8d6;
  --t1:#1e2a3a;--t2:#3a4a5e;--t3:#7a8a9e;
  --accent:#2a5c9e;--accent2:#1e4a82;--accent-g:rgba(42,92,158,.08);
  --green:#1a8a4a;--green-g:rgba(26,138,74,.08);
  --amber:#c07d0a;--amber-g:rgba(192,125,10,.08);
  --red:#c03030;--red-g:rgba(192,48,48,.08);
  --purple:#7a4ab5;--purple-g:rgba(122,74,181,.08);
  --cyan:#1a7a8a;--cyan-g:rgba(26,122,138,.08);
  --r:10px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  background:var(--bg);color:var(--t2);line-height:1.5;
  max-width:1520px;margin:0 auto;padding:16px;
}
.sm-app *,.sm-app *::before,.sm-app *::after{box-sizing:border-box}
.sm-app .hdr{background:linear-gradient(135deg,#2a4a7a,#3a6aaa,#2a4a7a);border:1px solid #2a4a7a;border-radius:var(--r);padding:24px 28px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;box-shadow:0 2px 8px rgba(42,74,122,.15)}
.sm-app .hdr h1{font-size:22px;font-weight:700;color:#fff;letter-spacing:-.5px;margin:0}
.sm-app .hdr p{font-size:12px;color:rgba(255,255,255,.7);margin:2px 0 0}
.sm-app .hdr-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sm-app .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);padding:4px 12px;border-radius:20px;font-size:12px;color:#fff;font-weight:500}
.sm-app .badge .dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
.sm-app .btn{padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--t2);font-size:13px;cursor:pointer;transition:all .15s;font-family:inherit;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.sm-app .btn:hover{border-color:var(--accent);color:var(--t1)}
.sm-app .hdr .btn{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff}
.sm-app .hdr .btn:hover{background:rgba(255,255,255,.22);color:#fff}
.sm-app .hdr .btn-primary{background:rgba(255,255,255,.92);border-color:rgba(255,255,255,.95);color:#2a4a7a}
.sm-app .btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.sm-app .btn-primary:hover{background:var(--accent2)}
.sm-app .btn-sm{padding:5px 10px;font-size:12px;border-radius:6px}
.sm-app .btn-danger{border-color:var(--red);color:var(--red)}
.sm-app .btn-danger:hover{background:var(--red-g)}
.sm-app .btn-ghost{background:transparent;border-color:transparent;color:var(--t3)}
.sm-app .btn:disabled{opacity:.5;cursor:not-allowed}
.sm-app .search-row{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:stretch}
.sm-app .search-group{display:flex;flex-direction:column;gap:3px}
.sm-app .search-group label{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.sm-app .search-input{padding:9px 14px 9px 34px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t1);font-size:13px;outline:none;font-family:inherit;min-width:200px}
.sm-app .search-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-g)}
.sm-app .search-wrap{position:relative}
.sm-app .search-wrap .ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:14px;color:var(--t3);pointer-events:none}
.sm-app .filter-sel{padding:9px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-size:13px;outline:none;font-family:inherit;cursor:pointer}
.sm-app .kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.sm-app .kpi{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.sm-app .kpi-label{font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.sm-app .kpi-val{font-size:28px;font-weight:700;color:var(--t1);margin:2px 0;letter-spacing:-1px}
.sm-app .kpi-sub{font-size:11px;color:var(--t3)}
.sm-app .chart-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.sm-app .chart-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.sm-app .chart-card h3{font-size:13px;font-weight:600;color:var(--t2);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.sm-app .chart-card h3 .hint{font-size:11px;color:var(--t3);font-weight:400}
.sm-app .chart-canvas-wrap{position:relative;height:260px}
@media(max-width:900px){.sm-app .chart-row{grid-template-columns:1fr}}
.sm-app .tbl-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.sm-app .tbl-hdr{padding:14px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px}
.sm-app .tbl-hdr h3{font-size:14px;font-weight:600;color:var(--t1);margin:0}
.sm-app .tbl-count{font-size:11px;color:var(--t3);background:var(--bg);padding:3px 10px;border-radius:12px;margin-left:8px}
.sm-app .tbl-wrap{overflow-x:auto;max-height:600px;overflow-y:auto}
.sm-app table{width:100%;border-collapse:collapse;font-size:13px}
.sm-app thead{position:sticky;top:0;z-index:10}
.sm-app thead th{text-align:left;padding:9px 12px;background:#e4e9f0;color:var(--t3);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none;transition:color .15s}
.sm-app thead th:hover{color:var(--accent)}
.sm-app thead th.sorted{color:var(--accent)}
.sm-app tbody td{padding:9px 12px;border-bottom:1px solid var(--border);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-app tbody tr{transition:background .12s;cursor:pointer}
.sm-app tbody tr:hover{background:var(--card2)}
.sm-app .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.sm-app .tag-origin{background:var(--purple-g);color:var(--purple)}
.sm-app .tag-cat{background:var(--cyan-g);color:var(--cyan)}
.sm-app .grade{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:26px;padding:0 8px;border-radius:6px;font-size:13px;font-weight:800;letter-spacing:-.3px}
.sm-app .grade-Aplus,.sm-app .grade-A{background:var(--green);color:#fff}
.sm-app .grade-Aminus,.sm-app .grade-Bplus{background:#3eaa6a;color:#fff}
.sm-app .grade-B,.sm-app .grade-Bminus{background:var(--amber);color:#fff}
.sm-app .grade-Cplus,.sm-app .grade-C{background:#d68f1a;color:#fff}
.sm-app .grade-D{background:#c45a30;color:#fff}
.sm-app .grade-F{background:var(--red);color:#fff}
.sm-app .grade-NA{background:var(--card2);color:var(--t3);border:1px dashed var(--border)}
.sm-app .confidence-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.sm-app .conf-none{background:var(--card2);color:var(--t3)}
.sm-app .conf-tentative{background:var(--red-g);color:var(--red)}
.sm-app .conf-building{background:var(--amber-g);color:var(--amber)}
.sm-app .conf-established{background:var(--accent-g);color:var(--accent)}
.sm-app .conf-proven{background:var(--green-g);color:var(--green)}
.sm-app .pag{display:flex;justify-content:space-between;align-items:center;padding:10px 22px;border-top:1px solid var(--border)}
.sm-app .pag span{font-size:11px;color:var(--t3)}
.sm-app .pag-btns{display:flex;gap:4px}

.panel-overlay{display:none;position:fixed;inset:0;background:rgba(30,42,58,.35);z-index:900;backdrop-filter:blur(3px)}
.panel-overlay.show{display:block}
.panel{position:fixed;top:0;right:-920px;width:880px;max-width:97vw;height:100vh;background:#fff;border-left:1px solid #d5dbe5;z-index:901;overflow-y:auto;transition:right .3s ease;display:flex;flex-direction:column;box-shadow:-4px 0 20px rgba(0,0,0,.1);font-family:-apple-system,'Segoe UI',Inter,Roboto,sans-serif;color:#3a4a5e}
.panel.show{right:0}
.panel *,.panel *::before,.panel *::after{box-sizing:border-box}
.panel{--bg:#eef1f5;--bg2:#ffffff;--card:#ffffff;--card2:#f4f6fa;--border:#d5dbe5;--border2:#c0c8d6;--t1:#1e2a3a;--t2:#3a4a5e;--t3:#7a8a9e;--accent:#2a5c9e;--accent2:#1e4a82;--accent-g:rgba(42,92,158,.08);--green:#1a8a4a;--green-g:rgba(26,138,74,.08);--amber:#c07d0a;--amber-g:rgba(192,125,10,.08);--red:#c03030;--red-g:rgba(192,48,48,.08);--purple:#7a4ab5;--purple-g:rgba(122,74,181,.08);--cyan:#1a7a8a;--cyan-g:rgba(26,122,138,.08)}
.panel .panel-head{padding:18px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--bg2);z-index:5;gap:14px}
.panel h2{font-size:18px;font-weight:700;color:var(--t1);margin:0}
.panel .head-grade{display:flex;align-items:center;gap:8px}
.panel .grade{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:26px;padding:0 8px;border-radius:6px;font-size:13px;font-weight:800}
.panel .grade-Aplus,.panel .grade-A{background:var(--green);color:#fff}
.panel .grade-Aminus,.panel .grade-Bplus{background:#3eaa6a;color:#fff}
.panel .grade-B,.panel .grade-Bminus{background:var(--amber);color:#fff}
.panel .grade-Cplus,.panel .grade-C{background:#d68f1a;color:#fff}
.panel .grade-D{background:#c45a30;color:#fff}
.panel .grade-F{background:var(--red);color:#fff}
.panel .grade-NA{background:var(--card2);color:var(--t3);border:1px dashed var(--border)}
.panel .confidence-pill{display:inline-flex;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.panel .conf-none{background:var(--card2);color:var(--t3)}
.panel .conf-tentative{background:var(--red-g);color:var(--red)}
.panel .conf-building{background:var(--amber-g);color:var(--amber)}
.panel .conf-established{background:var(--accent-g);color:var(--accent)}
.panel .conf-proven{background:var(--green-g);color:var(--green)}
.panel .panel-tabs{display:flex;padding:0 24px;border-bottom:1px solid var(--border);background:var(--bg2);position:sticky;top:65px;z-index:4;overflow-x:auto}
.panel .panel-tab{padding:11px 14px;font-size:13px;color:var(--t3);cursor:pointer;border-bottom:2px solid transparent;font-weight:500;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.panel .panel-tab:hover{color:var(--t2)}
.panel .panel-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.panel .panel-body{padding:20px 24px;flex:1;overflow-y:auto}
.panel .panel-foot{padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--bg2);position:sticky;bottom:0}
.panel .btn{padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--t2);font-size:13px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px}
.panel .btn:hover{border-color:var(--accent);color:var(--t1)}
.panel .btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.panel .btn-primary:hover{background:var(--accent2)}
.panel .btn-sm{padding:5px 10px;font-size:12px;border-radius:6px}
.panel .btn-danger{border-color:var(--red);color:var(--red)}
.panel .btn-danger:hover{background:var(--red-g)}
.panel .btn-ghost{background:transparent;border-color:transparent;color:var(--t3)}
.panel .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.panel .form-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.panel .form-group{display:flex;flex-direction:column;gap:4px}
.panel .form-group.full{grid-column:1/-1}
.panel .form-group label{font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.panel .form-input{padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--t1);font-size:13px;outline:none;font-family:inherit;width:100%}
.panel .form-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-g)}
.panel textarea.form-input{resize:vertical;min-height:60px}
.panel .form-input:disabled{background:var(--card2);color:var(--t3)}
.panel .section-title{font-size:13px;font-weight:600;color:var(--t1);padding:16px 0 8px;border-bottom:1px solid var(--border);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.panel .section-title.first{padding-top:0}
.panel .att-empty{font-size:12px;color:var(--t3);padding:8px 0;font-style:italic}
.panel .score-hero{background:linear-gradient(135deg,#2a4a7a,#3a6aaa);color:#fff;border-radius:12px;padding:22px 24px;margin-bottom:18px;display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:center}
.panel .score-hero .grade-big{font-size:56px;font-weight:800;line-height:1;letter-spacing:-2px;background:rgba(255,255,255,.15);padding:14px 22px;border-radius:14px;min-width:130px;text-align:center}
.panel .score-hero .score-num{font-size:32px;font-weight:700;letter-spacing:-1px}
.panel .score-hero .score-num small{font-size:14px;opacity:.7;margin-left:6px;font-weight:500}
.panel .score-hero .score-label{font-size:13px;opacity:.85;margin-top:2px}
.panel .score-hero .score-meta{font-size:12px;opacity:.7;margin-top:8px;display:flex;gap:10px;flex-wrap:wrap}
.panel .score-hero .score-meta span{background:rgba(255,255,255,.12);padding:3px 9px;border-radius:5px}
.panel .score-hero.no-data{background:linear-gradient(135deg,#7a8a9e,#5a6a7e)}
.panel .score-bars{display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.panel .score-bar-row{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px}
.panel .score-bar-row .row-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.panel .score-bar-row .row-name{font-size:13px;font-weight:600;color:var(--t1);display:flex;align-items:center;gap:8px}
.panel .score-bar-row .row-name .weight-tag{font-size:10px;color:var(--t3);background:var(--card2);padding:1px 7px;border-radius:8px;font-weight:600}
.panel .score-bar-row .row-val{font-size:14px;font-weight:700;color:var(--t1)}
.panel .score-bar-row .row-bar{height:8px;border-radius:4px;background:var(--card2);overflow:hidden}
.panel .score-bar-row .row-bar-fill{height:100%;border-radius:4px;transition:width .6s}
.panel .score-bar-row .row-sub{font-size:11px;color:var(--t3);margin-top:4px}
.panel .proj-entry{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden}
.panel .proj-entry .proj-entry-head{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;background:linear-gradient(180deg,#fafbfc,#f4f6fa);border-bottom:1px solid var(--border);list-style:none}
.panel .proj-entry .proj-entry-head::-webkit-details-marker{display:none}
.panel .proj-entry:not([open]) .proj-entry-head{border-bottom:none}
.panel .proj-entry-head .pe-id{font-size:14px;font-weight:700;color:var(--t1)}
.panel .proj-entry-head .pe-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.panel .proj-entry-body{padding:14px}
.panel .tag-status{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.panel .status-quoted{background:var(--accent-g);color:var(--accent)}
.panel .status-po{background:var(--cyan-g);color:var(--cyan)}
.panel .status-prod{background:var(--purple-g);color:var(--purple)}
.panel .status-shipped{background:var(--amber-g);color:var(--amber)}
.panel .status-delivered{background:var(--green-g);color:var(--green)}
.panel .status-closed{background:rgba(122,138,158,.15);color:var(--t3)}
.panel .status-cancelled{background:var(--red-g);color:var(--red)}
.panel .pe-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.panel .pe-summary .pe-cell{font-size:11px;color:var(--t3)}
.panel .pe-summary .pe-cell strong{display:block;font-size:13px;color:var(--t1);font-weight:600;margin-top:2px}
.panel .pe-metric-row{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px}
.panel .pe-metric{background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:7px 9px}
.panel .pe-metric .pem-label{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.panel .pe-metric .pem-val{font-size:14px;font-weight:700;color:var(--t1);margin-top:1px}
.panel .pe-metric.green{background:var(--green-g);border-color:rgba(26,138,74,.2)}
.panel .pe-metric.green .pem-val{color:var(--green)}
.panel .pe-metric.amber{background:var(--amber-g);border-color:rgba(192,125,10,.2)}
.panel .pe-metric.amber .pem-val{color:var(--amber)}
.panel .pe-metric.red{background:var(--red-g);border-color:rgba(192,48,48,.2)}
.panel .pe-metric.red .pem-val{color:var(--red)}
.panel .ontime-yes{color:var(--green)}
.panel .ontime-no{color:var(--red)}
.panel .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.panel .tag-cat{background:var(--cyan-g);color:var(--cyan)}
.panel .comment-log{display:flex;flex-direction:column;gap:10px;margin-bottom:12px;max-height:350px;overflow-y:auto}
.panel .comment-entry{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 14px;position:relative}
.panel .comment-meta{display:flex;gap:12px;font-size:11px;color:var(--t3);margin-bottom:6px;flex-wrap:wrap}
.panel .comment-meta .proj-tag{background:var(--cyan-g);color:var(--cyan);padding:1px 6px;border-radius:3px;font-size:10px}
.panel .comment-text{font-size:13px;color:var(--t2);line-height:1.5}
.panel .comment-del{position:absolute;top:8px;right:10px;background:none;border:none;color:var(--t3);cursor:pointer;font-size:14px}
.panel .comment-del:hover{color:var(--red)}
.panel .comment-add{display:flex;flex-direction:column;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px}
.panel .comment-add-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.panel .att-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.panel .att-search{flex:1;min-width:180px;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none}
.panel .att-cats{display:flex;flex-direction:column;gap:14px}
.panel .att-cat{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.panel .att-cat-head{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;background:linear-gradient(180deg,#fafbfc,#f4f6fa);border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
.panel .att-cat-head .cat-title{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;color:var(--t1)}
.panel .att-cat-head .cat-icon{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px}
.panel .att-cat-head .cat-count{font-size:11px;color:var(--t3);background:var(--bg);padding:2px 9px;border-radius:10px;font-weight:600}
.panel .att-cat-head .cat-actions{display:flex;gap:6px;align-items:center}
.panel .att-cat-body{padding:12px 16px}
.panel .att-cat.collapsed .att-cat-body{display:none}
.panel .att-list{display:flex;flex-direction:column;gap:6px}
.panel .att-item{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--card2);border:1px solid var(--border);border-radius:6px}
.panel .att-item .file-ico{width:34px;height:34px;border-radius:6px;background:linear-gradient(135deg,#c03030,#8a1818);color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0}
.panel .att-item .file-ico.img{background:linear-gradient(135deg,#7a4ab5,#5a2a95)}
.panel .att-item .file-ico.doc{background:linear-gradient(135deg,#2a5c9e,#1e4a82)}
.panel .att-item .file-ico.xls{background:linear-gradient(135deg,#1a8a4a,#107030)}
.panel .att-item .file-ico.zip{background:linear-gradient(135deg,#7a8a9e,#5a6a7e)}
.panel .att-item .file-info{flex:1;min-width:0}
.panel .att-item .file-name{font-size:13px;color:var(--t1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.panel .att-item .file-meta{font-size:11px;color:var(--t3);display:flex;gap:10px;flex-wrap:wrap}
.panel .att-item .file-actions{display:flex;gap:4px;flex-shrink:0}
.panel .att-item .icon-btn{width:30px;height:30px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px}
.panel .att-item .icon-btn:hover{background:var(--card);border-color:var(--border)}
.panel .att-item .icon-btn.danger:hover{color:var(--red);border-color:var(--red)}

.modal-overlay{display:none;position:fixed;inset:0;background:rgba(30,42,58,.4);z-index:1000;backdrop-filter:blur(4px);align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal-overlay *{box-sizing:border-box}
.modal{background:#fff;border:1px solid #d5dbe5;border-radius:10px;width:760px;max-width:94vw;max-height:92vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.12);font-family:-apple-system,'Segoe UI',Inter,Roboto,sans-serif;color:#3a4a5e;--bg:#eef1f5;--card:#ffffff;--card2:#f4f6fa;--border:#d5dbe5;--t1:#1e2a3a;--t2:#3a4a5e;--t3:#7a8a9e;--accent:#2a5c9e;--accent2:#1e4a82;--accent-g:rgba(42,92,158,.08);--green:#1a8a4a;--green-g:rgba(26,138,74,.08);--amber:#c07d0a;--amber-g:rgba(192,125,10,.08);--red:#c03030;--red-g:rgba(192,48,48,.08)}
.modal .modal-head{padding:20px 24px;border-bottom:1px solid var(--border)}
.modal .modal-head h2{font-size:18px;font-weight:700;color:var(--t1);margin:0}
.modal .modal-body{padding:20px 24px}
.modal .modal-foot{padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px}
.modal .btn{padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--t2);font-size:13px;cursor:pointer;font-family:inherit}
.modal .btn:hover{border-color:var(--accent);color:var(--t1)}
.modal .btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.modal .btn-primary:hover{background:var(--accent2)}
.modal .btn-danger{border-color:var(--red);color:var(--red)}
.modal .btn-danger:hover{background:var(--red-g)}
.modal .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.modal .form-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.modal .form-group{display:flex;flex-direction:column;gap:4px}
.modal .form-group.full{grid-column:1/-1}
.modal .form-group label{font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.modal .form-input{padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--t1);font-size:13px;outline:none;font-family:inherit;width:100%}
.modal .form-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-g)}
.modal textarea.form-input{resize:vertical;min-height:60px}
.modal .section-title{font-size:13px;font-weight:600;color:var(--t1);padding:16px 0 8px;border-bottom:1px solid var(--border);margin-bottom:12px}
.modal .section-title.first{padding-top:0}
.modal .live-preview{background:linear-gradient(180deg,#f4f6fa,#eef1f5);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:12px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.modal .live-preview .lp-cell{text-align:center}
.modal .live-preview .lp-label{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.modal .live-preview .lp-val{font-size:18px;font-weight:700;color:var(--t1);margin-top:2px}
.modal .live-preview .lp-val.green{color:var(--green)}
.modal .live-preview .lp-val.amber{color:var(--amber)}
.modal .live-preview .lp-val.red{color:var(--red)}

.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;background:#1a8a4a;color:#fff;border-radius:8px;font-size:13px;font-weight:500;z-index:2000;transition:all .3s ease;box-shadow:0 4px 16px rgba(0,0,0,.15)}
.toast.error{background:#c03030}
`;
