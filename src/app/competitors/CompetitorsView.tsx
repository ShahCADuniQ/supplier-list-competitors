"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  createCollection,
  renameCollection,
  duplicateCollection,
  deleteCollection,
  upsertCompetitor,
  duplicateCompetitor,
  deleteCompetitor,
  addCompetitorAttachment,
  deleteCompetitorAttachment,
  deleteProduct,
  addProductAttachment,
  type CompetitorInput,
} from "./actions";
import {
  aiGenerateCompetitor,
  aiRefineCompetitor,
  aiPersistProducts,
  type AiSourceUpload,
} from "./ai-actions";
import type {
  Competitor,
  CompetitorCollection,
  CompetitorAttachment,
  CompetitorProduct,
  CompetitorProductAttachment,
  CompetitorIdeationItem,
  IdeationProduct,
  IdeationItemProduct,
  IdeationProductFile,
} from "@/db/schema";
import BenchmarkView from "./BenchmarkView";
import IdeationBoard from "./IdeationBoard";
import SummaryView from "./SummaryView";
import {
  aiResearchTopBrands,
  aiPopulateResearchedBrand,
  aiDeepExtractBrand,
  clearCollectionBrands,
} from "./research-actions";

type FullCompetitorProduct = CompetitorProduct & {
  attachments: CompetitorProductAttachment[];
};

type FullCompetitor = Competitor & {
  attachments: CompetitorAttachment[];
  products: FullCompetitorProduct[];
};

const CAPABILITIES = [
  "Utility Strip/Shop", "Wraparound", "Vapor-Tight (IP65+)", "Linear High-Bay",
  "Recessed Troffer", "Architectural Recessed Slot",
  "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect",
  "Wall-Wash / Asymmetric",
  "LED Tape / Cove", "Aluminum Extrusion + Tape", "Stair / Step Integrated",
  "Under-Cabinet", "T5/T8 Retrofit", "LED Batten",
  "RGB / Color", "Tunable White / Smart", "Custom / Bespoke",
];

const TIERS = [
  { key: "mass", label: "Mass / Value" },
  { key: "mid", label: "Mid / Commercial" },
  { key: "spec", label: "Architectural Spec" },
  { key: "premium", label: "Premium / Tape" },
] as const;
type TierKey = (typeof TIERS)[number]["key"];
const tierLabel = (k: string) => TIERS.find((t) => t.key === k)?.label ?? k;

function fmtBytes(b: number) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}
function fileExt(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toUpperCase() : "FILE";
}
function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

type ViewTab = "brands" | "benchmark" | "ideation" | "summary";

export default function CompetitorsView({
  collections,
  brands,
  ideationItems,
  ideationProducts,
  ideationItemProducts,
  ideationProductFiles,
  canEdit,
}: {
  collections: CompetitorCollection[];
  brands: FullCompetitor[];
  ideationItems: CompetitorIdeationItem[];
  ideationProducts: IdeationProduct[];
  ideationItemProducts: IdeationItemProduct[];
  ideationProductFiles: IdeationProductFile[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [activeCollectionId, setActiveCollectionId] = useState<number | null>(
    collections[0]?.id ?? null,
  );
  useEffect(() => {
    if (!activeCollectionId && collections.length) setActiveCollectionId(collections[0].id);
    if (activeCollectionId && !collections.find((c) => c.id === activeCollectionId)) {
      setActiveCollectionId(collections[0]?.id ?? null);
    }
  }, [collections, activeCollectionId]);

  const activeCollection = collections.find((c) => c.id === activeCollectionId);
  const collBrands = useMemo(
    () => brands.filter((b) => b.collectionId === activeCollectionId),
    [brands, activeCollectionId],
  );
  const collIdeation = useMemo(
    () =>
      activeCollectionId
        ? ideationItems.filter((i) => i.collectionId === activeCollectionId)
        : [],
    [ideationItems, activeCollectionId],
  );
  const collIdeationProducts = useMemo(
    () =>
      activeCollectionId
        ? ideationProducts.filter((p) => p.collectionId === activeCollectionId)
        : [],
    [ideationProducts, activeCollectionId],
  );
  const collIdeationLinkages = useMemo(() => {
    // Restrict the junction to items inside the active collection so the
    // child component never has to second-guess it.
    if (!activeCollectionId) return ideationItemProducts;
    const itemIdsInColl = new Set(
      ideationItems
        .filter((i) => i.collectionId === activeCollectionId)
        .map((i) => i.id),
    );
    return ideationItemProducts.filter((l) => itemIdsInColl.has(l.ideationItemId));
  }, [ideationItems, ideationItemProducts, activeCollectionId]);
  const collIdeationFiles = useMemo(
    () =>
      activeCollectionId
        ? ideationProductFiles.filter((f) => f.collectionId === activeCollectionId)
        : [],
    [ideationProductFiles, activeCollectionId],
  );

  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set());
  const [capFilter, setCapFilter] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<"none" | "tier" | "segment" | "capability" | "country">("tier");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<"new" | "edit" | false>(false);
  const [draft, setDraft] = useState<CompetitorInput | null>(null);
  const [collMenuOpen, setCollMenuOpen] = useState(false);

  // ── View tabs (Ideation default, then Brands / Benchmark / Summary) ──
  // Benchmark is the default landing tab — that's where users add products
  // and accumulate brand sections. Ideation / Brands / Summary are secondary.
  const [view, setView] = useState<ViewTab>("benchmark");
  // Reset detail/editing state when switching away from Brands.
  useEffect(() => {
    if (view !== "brands") {
      setSelectedId(null);
      setEditing(false);
      setDraft(null);
    }
  }, [view]);

  const [toastMsg, setToastMsg] = useState<{ msg: string; err?: boolean } | null>(null);
  function toast(msg: string, err = false) {
    setToastMsg({ msg, err });
    setTimeout(() => setToastMsg(null), 2400);
  }

  function runAction<T>(fn: () => Promise<T>, success?: string) {
    startTransition(async () => {
      try {
        await fn();
        if (success) toast(success);
        router.refresh();
      } catch (e) {
        toast(e instanceof Error ? e.message : "Action failed", true);
      }
    });
  }

  // ── Filters ──
  const filteredBrands = useMemo(() => {
    const q = search.toLowerCase().trim();
    return collBrands.filter((b) => {
      if (tierFilter.size && !tierFilter.has(b.tierKey)) return false;
      if (capFilter.size && ![...capFilter].some((c) => b.capabilities.includes(c))) return false;
      if (q) {
        const hay = [b.name, b.parent, b.country, b.productLines, b.notes, b.segment, b.channel, b.website, b.capabilities.join(" ")].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [collBrands, search, tierFilter, capFilter]);

  // ── Grouping ──
  const groups = useMemo(() => {
    const list = [...filteredBrands].sort((a, b) => a.name.localeCompare(b.name));
    if (groupBy === "none") return [{ label: null, items: list }];
    if (groupBy === "tier") {
      const order = TIERS.map((t) => t.key);
      const map = new Map<string, FullCompetitor[]>();
      order.forEach((k) => map.set(k, []));
      list.forEach((b) => map.get(b.tierKey)?.push(b));
      return order.map((k) => ({ label: tierLabel(k), items: map.get(k) ?? [] })).filter((g) => g.items.length);
    }
    if (groupBy === "segment") {
      const m = new Map<string, FullCompetitor[]>();
      list.forEach((b) => (b.segment || "Uncategorized").split(",").map((s) => s.trim()).forEach((s) => {
        if (!m.has(s)) m.set(s, []);
        m.get(s)!.push(b);
      }));
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ label: k, items: v }));
    }
    if (groupBy === "capability") {
      const m = new Map<string, FullCompetitor[]>();
      CAPABILITIES.forEach((c) => m.set(c, list.filter((b) => b.capabilities.includes(c))));
      return [...m.entries()].filter(([, v]) => v.length).map(([k, v]) => ({ label: k, items: v }));
    }
    if (groupBy === "country") {
      const m = new Map<string, FullCompetitor[]>();
      list.forEach((b) => {
        const c = (b.country || "Unknown").trim();
        if (!m.has(c)) m.set(c, []);
        m.get(c)!.push(b);
      });
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ label: k, items: v }));
    }
    return [{ label: null, items: list }];
  }, [filteredBrands, groupBy]);

  const selected = brands.find((b) => b.id === selectedId);

  // ── Collection actions ──
  async function handleNewCollection() {
    const name = prompt("Name your collection:");
    if (!name) return;
    runAction(async () => {
      const c = await createCollection(name);
      setCollMenuOpen(false);
      if (c) setActiveCollectionId(c.id);
    }, `Created "${name}"`);
  }
  async function handleRenameCollection() {
    if (!activeCollection) return;
    const name = prompt("Rename collection:", activeCollection.name);
    if (!name) return;
    runAction(() => renameCollection(activeCollection.id, name), "Renamed");
    setCollMenuOpen(false);
  }
  async function handleDuplicateCollection() {
    if (!activeCollection) return;
    runAction(async () => {
      const c = await duplicateCollection(activeCollection.id);
      setCollMenuOpen(false);
      if (c) setActiveCollectionId(c.id);
    }, "Duplicated collection");
  }
  async function handleDeleteCollection() {
    if (!activeCollection) return;
    if (collections.length === 1) return toast("Can't delete your only collection", true);
    if (!confirm(`Delete "${activeCollection.name}" and all ${collBrands.length} brands?`)) return;
    runAction(async () => {
      await deleteCollection(activeCollection.id);
      setActiveCollectionId(collections.find((c) => c.id !== activeCollection.id)?.id ?? null);
      setCollMenuOpen(false);
    }, "Collection deleted");
  }

  // ── AI generation/refine state ──
  const [aiUrl, setAiUrl] = useState("");
  const [aiUploads, setAiUploads] = useState<AiSourceUpload[]>([]);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiBackup, setAiBackup] = useState<CompetitorInput | null>(null);
  // Products extracted by AI for a brand-NEW competitor (no id yet); persist
  // them after `upsertCompetitor` returns the new id on save.
  const [pendingProducts, setPendingProducts] = useState<
    Awaited<ReturnType<typeof aiGenerateCompetitor>>["extraction"]["products"]
  >([]);

  function resetAiState() {
    setAiUrl(""); setAiUploads([]); setAiGenerating(false);
    setAiBackup(null); setPendingProducts([]);
  }

  function handleRevertAi() {
    if (!aiBackup) return;
    setDraft({ ...aiBackup });
    setAiBackup(null);
    toast("Reverted — attachments and saves are kept");
  }

  async function handleAiUploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      try {
        const pathname = `ai-temp/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        setAiUploads((s) => [
          ...s,
          { url: blob.url, name: f.name, mime: f.type, size: f.size, blobPathname: blob.pathname },
        ]);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
  }

  function applyExtraction(
    e: Awaited<ReturnType<typeof aiGenerateCompetitor>>["extraction"],
  ) {
    setDraft((d) =>
      d
        ? {
            ...d,
            name: e.name || d.name,
            website: e.website || d.website,
            parent: e.parent || d.parent,
            tierKey: (e.tierKey as CompetitorInput["tierKey"]) || d.tierKey,
            tier: e.tier || d.tier,
            segment: e.segment || d.segment,
            country: e.country || d.country,
            productLines: e.productLines || d.productLines,
            channel: e.channel || d.channel,
            notes: e.notes || d.notes,
            capabilities: e.capabilities.length ? e.capabilities : d.capabilities,
          }
        : d,
    );
  }

  async function handleAiGenerateCompetitor() {
    if (!draft) return;
    if (!aiUploads.length && !aiUrl.trim()) {
      return toast("Add a file or URL first", true);
    }
    setAiGenerating(true);
    try {
      if (draft.id) {
        // Editing an existing competitor → refine + persist new files now.
        setAiBackup({ ...draft });
        const result = await aiRefineCompetitor({
          competitorId: draft.id,
          uploads: aiUploads,
          url: aiUrl,
        });
        applyExtraction(result.extraction);
        for (const u of aiUploads) {
          try {
            await addCompetitorAttachment({
              competitorId: draft.id,
              name: u.name, size: u.size, mimeType: u.mime,
              url: u.url, blobPathname: u.blobPathname,
            });
          } catch (err) {
            console.error("Failed to attach", u.name, err);
          }
        }
        setAiUploads([]);
        setAiUrl("");
        router.refresh();
        toast("Refined — review or revert");
      } else {
        // Brand-new competitor: just extract; uploads + products persist on save.
        const result = await aiGenerateCompetitor({ uploads: aiUploads, url: aiUrl });
        applyExtraction(result.extraction);
        setPendingProducts(result.extraction.products ?? []);
        const n = result.extraction.products?.length ?? 0;
        toast(
          n > 0
            ? `AI extracted competitor + ${n} product${n > 1 ? "s" : ""} — review and save`
            : "AI extracted competitor — review and save",
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "AI generation failed", true);
    } finally {
      setAiGenerating(false);
    }
  }

  // ── Brand actions ──
  function startNew() {
    if (!activeCollectionId) return;
    setDraft({
      collectionId: activeCollectionId,
      name: "", website: "", parent: "", tierKey: "mid", tier: "",
      segment: "", country: "", productLines: "", channel: "", notes: "",
      capabilities: [],
    });
    setEditing("new");
    setSelectedId(null);
    resetAiState();
  }
  function startEdit(id: number) {
    const b = brands.find((x) => x.id === id);
    if (!b) return;
    setDraft({
      id: b.id,
      collectionId: b.collectionId,
      name: b.name,
      website: b.website ?? "",
      parent: b.parent ?? "",
      tierKey: b.tierKey,
      tier: b.tier ?? "",
      segment: b.segment ?? "",
      country: b.country ?? "",
      productLines: b.productLines ?? "",
      channel: b.channel ?? "",
      notes: b.notes ?? "",
      capabilities: [...b.capabilities],
    });
    setEditing("edit");
  }
  function saveDraft() {
    if (!draft || !draft.name.trim()) return toast("Name is required", true);
    const isNew = !draft.id;
    runAction(async () => {
      const r = await upsertCompetitor(draft);
      if (isNew && r) {
        // Carry AI-uploaded source files over as attachments.
        if (aiUploads.length) {
          for (const u of aiUploads) {
            try {
              await addCompetitorAttachment({
                competitorId: r.id,
                name: u.name, size: u.size, mimeType: u.mime,
                url: u.url, blobPathname: u.blobPathname,
              });
            } catch (err) {
              console.error("Failed to attach", u.name, err);
            }
          }
        }
        // Persist the AI-extracted products under the new competitor.
        if (pendingProducts.length) {
          try {
            await aiPersistProducts({ competitorId: r.id, products: pendingProducts });
          } catch (err) {
            console.error("Failed to persist products", err);
          }
        }
      }
      if (r) setSelectedId(r.id);
      setEditing(false);
      setDraft(null);
      resetAiState();
    }, draft.id ? "Saved" : "Competitor added");
  }
  function handleDuplicateBrand(id: number) {
    runAction(async () => {
      const r = await duplicateCompetitor(id);
      if (r) setSelectedId(r.id);
    }, "Duplicated");
  }
  function handleDeleteBrand(id: number) {
    const b = brands.find((x) => x.id === id);
    if (!b) return;
    if (!confirm(`Delete "${b.name}"?`)) return;
    runAction(async () => {
      await deleteCompetitor(id);
      setSelectedId(null);
    }, "Brand deleted");
  }

  // ── Attachments ──
  async function uploadFiles(files: FileList | File[]) {
    if (!selected) return;
    let successCount = 0;
    for (const f of Array.from(files)) {
      try {
        const pathname = `competitors/${selected.id}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addCompetitorAttachment({
          competitorId: selected.id,
          name: f.name,
          size: f.size,
          mimeType: f.type,
          url: blob.url,
          blobPathname: blob.pathname,
        });
        successCount++;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
    router.refresh();
    if (successCount > 0) toast(`${successCount} file${successCount > 1 ? "s" : ""} uploaded`);
  }
  function handleDownloadAttachment(a: CompetitorAttachment) {
    if (!a.url) return;
    const link = document.createElement("a");
    link.href = a.url;
    link.download = a.name;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  }

  async function handleUploadProductFile(productId: number, files: FileList | File[]) {
    let success = 0;
    for (const f of Array.from(files)) {
      try {
        const pathname = `competitors/products/${productId}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addProductAttachment({
          productId, name: f.name, size: f.size, mimeType: f.type,
          url: blob.url, blobPathname: blob.pathname,
          kind: f.name.toLowerCase().endsWith(".ies") ? "ies"
            : f.name.toLowerCase().endsWith(".pdf") ? "drawing"
            : f.type.startsWith("image/") ? "image" : null,
        });
        success++;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
    if (success > 0) {
      router.refresh();
      toast(`Attached ${success} file${success > 1 ? "s" : ""} to product`);
    }
  }

  function handleDeleteProduct(id: number) {
    runAction(() => deleteProduct(id), "Product deleted");
  }

  function toggleTier(k: string) {
    setTierFilter((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }
  function toggleCap(k: string) {
    setCapFilter((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }
  function resetFilters() {
    setSearch(""); setTierFilter(new Set()); setCapFilter(new Set());
  }

  return (
    <>
      <style>{COMPETITOR_CSS}</style>
      <div className="cm-app">
        <header className="bar">
          <span className="brand-mark"></span>
          <button className={`coll-picker ${collMenuOpen ? "open" : ""}`} onClick={() => setCollMenuOpen((o) => !o)}>
            <span className="coll-name">{activeCollection?.name ?? "—"}</span>
            <span className="coll-chev">▾</span>
          </button>
          <span className="brand-sep">/</span>
          <span className="brand-sub">Competitors &amp; Market Research</span>

          <div className="view-tabs">
            <button
              className={`view-tab ${view === "ideation" ? "active" : ""}`}
              onClick={() => setView("ideation")}
            >
              Ideation<span className="ct">{collIdeation.length}</span>
            </button>
            <button
              className={`view-tab ${view === "benchmark" ? "active" : ""}`}
              onClick={() => setView("benchmark")}
            >
              Benchmark<span className="ct">{collBrands.length}</span>
            </button>
            <button
              className={`view-tab ${view === "brands" ? "active" : ""}`}
              onClick={() => setView("brands")}
            >
              Brands
            </button>
            <button
              className={`view-tab ${view === "summary" ? "active" : ""}`}
              onClick={() => setView("summary")}
            >
              Summary
            </button>
          </div>

          {collMenuOpen && (
            <div className="coll-menu" onClick={(e) => e.stopPropagation()}>
              <div className="coll-menu-h">Collections</div>
              {[...collections].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                <div key={c.id} className={`coll-item ${c.id === activeCollectionId ? "active" : ""}`}
                  onClick={() => { setActiveCollectionId(c.id); setCollMenuOpen(false); setSelectedId(null); setEditing(false); }}>
                  <span className="coll-item-name">{c.name}</span>
                  <span className="coll-item-meta">{brands.filter((b) => b.collectionId === c.id).length}</span>
                </div>
              ))}
              {canEdit && (
                <>
                  <div className="coll-divider" />
                  <button className="coll-action" onClick={handleNewCollection}>+ New collection</button>
                  <button className="coll-action" onClick={handleRenameCollection}>Rename current</button>
                  <button className="coll-action" onClick={handleDuplicateCollection}>Duplicate current</button>
                  <button className="coll-action danger" onClick={handleDeleteCollection} disabled={collections.length === 1}>Delete current</button>
                </>
              )}
            </div>
          )}

          <div className="spacer" />
          {view === "brands" && (
            <div className="search-wrap">
              <span className="search-ico">🔎</span>
              <input className="search" placeholder="Search this collection…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
          {view === "brands" && canEdit && (
            <BrandsToolbar
              activeCollectionId={activeCollectionId}
              activeCollectionName={activeCollection?.name ?? ""}
              brandCount={collBrands.length}
              onToast={toast}
              onStartNew={startNew}
              onChange={() => router.refresh()}
            />
          )}
        </header>

        {view === "benchmark" && activeCollection && (
          <main className="cm-detail solo">
            <BenchmarkView
              collection={activeCollection}
              brands={collBrands}
              canEdit={canEdit}
              onToast={toast}
            />
          </main>
        )}
        {view === "ideation" && activeCollection && (
          <main className="cm-detail solo">
            <IdeationBoard
              collection={activeCollection}
              brands={collBrands}
              items={collIdeation}
              products={collIdeationProducts}
              linkages={collIdeationLinkages}
              files={collIdeationFiles}
              canEdit={canEdit}
              onToast={toast}
            />
          </main>
        )}
        {view === "summary" && activeCollection && (
          <main className="cm-detail solo">
            <SummaryView
              collection={activeCollection}
              brands={collBrands}
              canEdit={canEdit}
              onToast={toast}
            />
          </main>
        )}
        {view === "brands" && (
        <div className="layout">
          <aside className="sidebar">
            <div className="sidebar-tools">
              <div className="row">
                <label>Group</label>
                <select className="selectish" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
                  <option value="none">No grouping</option>
                  <option value="tier">By tier</option>
                  <option value="segment">By segment</option>
                  <option value="capability">By capability</option>
                  <option value="country">By country</option>
                </select>
              </div>
              <div className="chips">
                {TIERS.map((t) => {
                  const n = collBrands.filter((b) => b.tierKey === t.key).length;
                  return (
                    <button key={t.key} className={`chip ${tierFilter.has(t.key) ? "active" : ""}`} onClick={() => toggleTier(t.key)}>
                      {t.label}<span className="ct">{n}</span>
                    </button>
                  );
                })}
              </div>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, userSelect: "none" }}>Capability filter</summary>
                <div className="chips" style={{ marginTop: 7 }}>
                  {CAPABILITIES.map((c) => {
                    const n = collBrands.filter((b) => b.capabilities.includes(c)).length;
                    return (
                      <button key={c} className={`chip ${capFilter.has(c) ? "active" : ""}`} onClick={() => toggleCap(c)}>
                        {c}<span className="ct">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </details>
            </div>

            <div className="results-meta">
              <span>{filteredBrands.length} brand{filteredBrands.length === 1 ? "" : "s"}</span>
              <button className="btn ghost sm" style={{ fontSize: 11, padding: "2px 8px" }} onClick={resetFilters}>Reset</button>
            </div>

            <div className="brand-list">
              {!filteredBrands.length ? (
                <div style={{ padding: "30px 14px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                  {collBrands.length === 0
                    ? <>No competitors yet in this collection.{canEdit ? <> Click <strong>+ Add competitor</strong> to start.</> : null}</>
                    : <>No matches.</>}
                </div>
              ) : (
                groups.map((g, i) => (
                  <div key={i}>
                    {g.label && <div className="group-h">{g.label} <span className="gct">· {g.items.length}</span></div>}
                    {g.items.map((b) => (
                      <div key={b.id} className={`row-item ${b.id === selectedId ? "active" : ""}`}
                        onClick={() => { setSelectedId(b.id); setEditing(false); setDraft(null); }}>
                        <div className="row-top">
                          <span className="row-name">{b.name}</span>
                          <span className={`tier-pill tier-${b.tierKey}`}>{tierLabel(b.tierKey)}</span>
                        </div>
                        <div className="row-bottom">
                          <span>{b.parent || "—"}</span>
                          {b.country && <><span>·</span><span>{b.country}</span></>}
                          {b.attachments.length > 0 && <><span>·</span><span className="row-paperclip">📎 {b.attachments.length}</span></>}
                        </div>
                        <div className="row-tags">
                          {b.capabilities.slice(0, 3).map((c) => <span key={c} className="mini-tag">{c}</span>)}
                          {b.capabilities.length > 3 && <span className="mini-tag">+{b.capabilities.length - 3}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </aside>

          <main className="cm-detail">
            {editing && draft ? (
              <FormView
                draft={draft}
                setDraft={setDraft}
                isNew={editing === "new"}
                collectionName={activeCollection?.name ?? ""}
                onCancel={() => { setEditing(false); setDraft(null); resetAiState(); }}
                onSave={saveDraft}
                aiUrl={aiUrl}
                setAiUrl={setAiUrl}
                aiUploads={aiUploads}
                setAiUploads={setAiUploads}
                aiGenerating={aiGenerating}
                onAiUpload={handleAiUploadFiles}
                onAiGenerate={handleAiGenerateCompetitor}
                aiBackupActive={!!aiBackup}
                onRevertAi={handleRevertAi}
              />
            ) : selected ? (
              <DetailView
                brand={selected}
                canEdit={canEdit}
                onEdit={() => startEdit(selected.id)}
                onDuplicate={() => handleDuplicateBrand(selected.id)}
                onDelete={() => handleDeleteBrand(selected.id)}
                onUpload={uploadFiles}
                onDownload={handleDownloadAttachment}
                onDeleteAttachment={(id) => runAction(() => deleteCompetitorAttachment(id), "Deleted")}
                onDeleteProduct={handleDeleteProduct}
                onUploadProductFile={handleUploadProductFile}
              />
            ) : (
              <EmptyView collection={activeCollection} brandCount={collBrands.length} canEdit={canEdit} onAdd={startNew} />
            )}
          </main>
        </div>
        )}

        {toastMsg && <div className={`toast show ${toastMsg.err ? "error" : ""}`}>{toastMsg.msg}</div>}
      </div>
    </>
  );
}

function BrandsToolbar({
  activeCollectionId,
  activeCollectionName,
  brandCount,
  onToast,
  onStartNew,
  onChange,
}: {
  activeCollectionId: number | null;
  activeCollectionName: string;
  brandCount: number;
  onToast: (msg: string, err?: boolean) => void;
  onStartNew: () => void;
  onChange: () => void;
}) {
  const [findBusy, setFindBusy] = useState(false);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepStatus, setDeepStatus] = useState<string | null>(null);

  async function handleFind(count: number) {
    if (!activeCollectionId) return;
    setFindBusy(true);
    setFindStatus("Searching the web…");
    try {
      const r = await aiResearchTopBrands({ collectionId: activeCollectionId, count });
      const list = r.found;
      if (!list.length) {
        onToast("No brands returned — try again", true);
        return;
      }
      setFindStatus(`Adding ${list.length}…`);
      let added = 0;
      let products = 0;
      for (let i = 0; i < list.length; i++) {
        setFindStatus(`Adding ${list[i].name} (${i + 1}/${list.length})…`);
        try {
          const r = await aiPopulateResearchedBrand({
            collectionId: activeCollectionId,
            brand: list[i],
          });
          added++;
          products += r.productsInserted;
        } catch (err) {
          console.error("Brand populate failed:", list[i].name, err);
        }
      }
      onChange();
      onToast(
        `Added ${added} brand${added === 1 ? "" : "s"} · ${products} product${products === 1 ? "" : "s"}`,
      );
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Research failed", true);
    } finally {
      setFindBusy(false);
      setTimeout(() => setFindStatus(null), 4000);
    }
  }

  async function handleDeepCrawl() {
    if (!activeCollectionId) return;
    const raw = prompt(
      `Paste the brand's website (e.g. "lumenpulse.com"). Perplexity will enumerate every "${activeCollectionName}" product on the site; for each one we'll extract full specs and download every spec PDF / IES / drawing / BIM file. Takes 2–4 minutes for a large catalog.`,
    );
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const websiteUrl = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    setDeepBusy(true);
    setDeepStatus(
      `Discovering products on ${new URL(websiteUrl).host}… (2–4 min)`,
    );
    try {
      const r = await aiDeepExtractBrand({
        collectionId: activeCollectionId,
        website: websiteUrl,
        maxProducts: 250,
      });
      onChange();
      const parts = [
        `${r.brandName} added`,
        `${r.productsInserted} product${r.productsInserted === 1 ? "" : "s"}`,
      ];
      const productDocs = r.specsheetsAttached + r.documentsAttached;
      if (productDocs)
        parts.push(`${productDocs} product file${productDocs === 1 ? "" : "s"}`);
      if (r.brandFilesAttached)
        parts.push(`${r.brandFilesAttached} brand file${r.brandFilesAttached === 1 ? "" : "s"}`);
      if (r.fetchErrors.length)
        parts.push(`${r.fetchErrors.length} fetch errors (see dev log)`);
      onToast(parts.join(" · "));
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Deep crawl failed", true);
    } finally {
      setDeepBusy(false);
      setTimeout(() => setDeepStatus(null), 4000);
    }
  }

  async function handleReset() {
    if (!activeCollectionId) return;
    if (
      !confirm(
        `Delete all ${brandCount} brand${brandCount === 1 ? "" : "s"} in "${activeCollectionName}"? This also removes their products and attachments. This cannot be undone.`,
      )
    ) {
      return;
    }
    setResetBusy(true);
    try {
      const r = await clearCollectionBrands(activeCollectionId);
      onChange();
      onToast(`Cleared ${r.deleted} brand${r.deleted === 1 ? "" : "s"}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Reset failed", true);
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="brands-toolbar">
      <button
        className="btn primary sm"
        onClick={handleDeepCrawl}
        disabled={deepBusy || !activeCollectionId}
        title="Paste one brand website. We crawl it, extract every product in the active collection's niche, and download spec PDFs."
      >
        {deepBusy ? (deepStatus ?? "Crawling…") : "✨ Add brand by URL (deep crawl)"}
      </button>
      <button
        className="btn sm"
        onClick={() => handleFind(5)}
        disabled={findBusy || !activeCollectionId}
        title="Web-search 5 top brands and auto-populate them"
      >
        {findBusy ? (findStatus ?? "Searching…") : "✨ Find 5 top brands"}
      </button>
      <button className="btn sm" onClick={onStartNew}>
        + Add manually
      </button>
      <button
        className="btn sm danger"
        onClick={handleReset}
        disabled={resetBusy || !brandCount}
        title="Delete every brand in this collection"
      >
        {resetBusy ? "Clearing…" : "Reset all"}
      </button>
    </div>
  );
}

function EmptyView({ collection, brandCount, canEdit, onAdd }: {
  collection?: CompetitorCollection; brandCount: number; canEdit: boolean; onAdd: () => void;
}) {
  if (!collection) {
    return (
      <div className="detail-inner">
        <div className="empty">
          <h3>No collections yet</h3>
          <p>{canEdit ? <button className="btn primary" onClick={onAdd}>+ Add a competitor</button> : "An admin needs to create one."}</p>
        </div>
      </div>
    );
  }
  const tierCounts = TIERS.map(() => 0); // brand totals omitted in empty view; lite version
  return (
    <div className="detail-inner">
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700 }}>Collection</div>
        <h2 style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 600, letterSpacing: "-.02em" }}>{collection.name}</h2>
      </div>
      <div className="strip">
        <div className="strip-cell"><div className="lbl">Total brands</div><div className="val">{brandCount}</div><div className="sub">In this collection</div></div>
        {TIERS.map((t, i) => (
          <div key={t.key} className="strip-cell"><div className="lbl">{t.label}</div><div className="val">{tierCounts[i]}</div></div>
        ))}
      </div>
      <div className="empty" style={{ height: "auto", padding: "60px 20px" }}>
        <h3>{brandCount ? "Pick a competitor" : "Empty collection"}</h3>
        <p>{brandCount ? "Select a brand on the left to see details." : (canEdit ? "Click + Add competitor to populate this collection." : "An admin needs to add brands.")}</p>
      </div>
    </div>
  );
}

function DetailView({
  brand, canEdit, onEdit, onDuplicate, onDelete, onUpload, onDownload, onDeleteAttachment,
  onDeleteProduct, onUploadProductFile,
}: {
  brand: FullCompetitor; canEdit: boolean;
  onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
  onUpload: (files: FileList | File[]) => void;
  onDownload: (a: CompetitorAttachment) => void;
  onDeleteAttachment: (id: number) => void;
  onDeleteProduct: (id: number) => void;
  onUploadProductFile: (productId: number, files: FileList | File[]) => void;
}) {
  const ws = (brand.website || "").trim();
  const wsHref = ws && !/^https?:\/\//i.test(ws) ? `https://${ws}` : ws;
  const wsHost = ws.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  return (
    <div className="detail-inner">
      <div className="d-head">
        <div>
          <h1 className="d-title">{brand.name}</h1>
          <p className="d-sub">
            {brand.parent || "—"} · {brand.country || "—"} ·{" "}
            <span className={`tier-pill tier-${brand.tierKey}`} style={{ verticalAlign: 1 }}>{tierLabel(brand.tierKey)}</span>
          </p>
        </div>
        {canEdit && (
          <div className="d-actions">
            <button className="btn sm" onClick={onDuplicate}>Duplicate</button>
            <button className="btn sm" onClick={onEdit}>Edit</button>
            <button className="btn sm danger" onClick={onDelete}>Delete</button>
          </div>
        )}
      </div>

      <div className="d-card">
        <h4>Profile</h4>
        <dl className="grid-2">
          <dt>Website</dt><dd>{ws ? <a href={wsHref} target="_blank" rel="noopener noreferrer">{wsHost} ↗</a> : <span style={{ color: "var(--muted)" }}>—</span>}</dd>
          <dt>Parent / owner</dt><dd>{brand.parent || "—"}</dd>
          <dt>Tier</dt><dd>{brand.tier || tierLabel(brand.tierKey)}</dd>
          <dt>Segment</dt><dd>{brand.segment || "—"}</dd>
          <dt>Country / HQ</dt><dd>{brand.country || "—"}</dd>
          <dt>Channel</dt><dd>{brand.channel || "—"}</dd>
          <dt>Product lines</dt><dd>{brand.productLines || "—"}</dd>
          <dt>Notes</dt><dd>{brand.notes || "—"}</dd>
        </dl>
      </div>

      {brand.capabilities.length > 0 && (
        <div className="d-card">
          <h4>What they provide</h4>
          <div className="pill-row">
            {brand.capabilities.map((c) => <span key={c} className="pill">{c}</span>)}
          </div>
        </div>
      )}

      <div className="d-card">
        <h4>
          Products{" "}
          <span style={{ color: "var(--muted)", fontWeight: 500 }}>
            {brand.products.length || "—"}
          </span>
        </h4>
        <div style={{ fontSize: 13, color: "var(--muted)", padding: "10px 0" }}>
          {brand.products.length === 0 ? (
            canEdit
              ? "No products yet. Use the AI panel in Edit to extract products from a website or PDF catalog."
              : "No products yet."
          ) : (
            <>
              {brand.products.length} product{brand.products.length === 1 ? "" : "s"} on file —
              see the <strong>Benchmark</strong> tab for the per-product spec cards and downloads.
            </>
          )}
        </div>
      </div>

      <div className="d-card">
        <h4>Attachments {canEdit && (
          <label className="h-act">
            + Add file
            <input type="file" multiple style={{ display: "none" }} onChange={(e) => {
              if (e.target.files) onUpload(e.target.files);
              e.target.value = "";
            }} />
          </label>
        )}</h4>
        {canEdit && (
          <label className="att-zone" onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("drag"); }}
            onDragLeave={(e) => e.currentTarget.classList.remove("drag")}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("drag"); onUpload(e.dataTransfer.files); }}>
            <strong>Drop files here</strong> or click to browse — PDFs, spec sheets, images, anything.
            <input type="file" multiple style={{ display: "none" }} onChange={(e) => {
              if (e.target.files) onUpload(e.target.files);
              e.target.value = "";
            }} />
          </label>
        )}
        <div className="att-list">
          {brand.attachments.length === 0 && !canEdit && (
            <div style={{ fontSize: 12, color: "var(--muted)", padding: "12px 0" }}>No attachments.</div>
          )}
          {brand.attachments.map((a) => (
            <div key={a.id} className="att-item">
              <div className="att-icon">{fileExt(a.name)}</div>
              <div className="att-info">
                <div className="att-name">{a.name}</div>
                <div className="att-meta">{fmtBytes(a.size)} · added {new Date(a.addedAt).toLocaleDateString()}</div>
              </div>
              <div className="att-actions">
                <button className="att-btn" onClick={() => onDownload(a)}>Download</button>
                {canEdit && <button className="att-btn danger" onClick={() => confirm("Delete attachment?") && onDeleteAttachment(a.id)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProductCard({
  product, canEdit, onDelete, onUploadFiles,
}: {
  product: FullCompetitorProduct;
  canEdit: boolean;
  onDelete: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const firstImage = product.imageUrls?.[0];
  const specs = product.specs ?? {};
  const specEntries: [string, string | string[]][] = Object.entries(specs).filter(
    ([, v]) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim().length > 0),
  );
  const specOrder = [
    "dimensions", "wattage", "lumens", "cct", "cri", "voltage",
    "beamAngle", "ipRating", "colors", "finishes", "certifications", "notes",
  ];
  const sortedEntries = specEntries.sort(([a], [b]) => {
    const ai = specOrder.indexOf(a); const bi = specOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const previewKeys = ["dimensions", "wattage", "lumens", "cct"];
  const preview = sortedEntries.filter(([k]) => previewKeys.includes(k)).slice(0, 3);

  return (
    <div className={`product-card ${open ? "open" : ""}`}>
      <button className="product-card-head" onClick={() => setOpen((o) => !o)} type="button">
        <div className="product-thumb">
          {firstImage ? (
            // Plain <img> — competitor sites won't be in next.config.images.domains
            // and we want graceful failure if the URL is bad.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={firstImage} alt={product.name} loading="lazy" onError={(e) => { (e.currentTarget.style.display = "none"); }} />
          ) : (
            <div className="product-thumb-empty">📷</div>
          )}
        </div>
        <div className="product-info">
          <div className="product-name">{product.name}</div>
          {product.productCode && <div className="product-code">{product.productCode}</div>}
          {product.productCategory && (
            <div className="product-cat">{product.productCategory}</div>
          )}
          {preview.length > 0 && (
            <div className="product-preview">
              {preview.map(([k, v]) => (
                <span key={k} className="product-spec-mini">
                  <strong>{labelFor(k)}:</strong>{" "}
                  {Array.isArray(v) ? v.slice(0, 2).join(", ") : v}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="product-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="product-card-body">
          {product.description && (
            <p className="product-desc">{product.description}</p>
          )}
          {product.imageUrls && product.imageUrls.length > 1 && (
            <div className="product-image-strip">
              {product.imageUrls.slice(0, 6).map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                  <img src={src} alt={`${product.name} ${i}`} loading="lazy" onError={(e) => { (e.currentTarget.style.display = "none"); }} />
                </a>
              ))}
            </div>
          )}
          {sortedEntries.length > 0 && (
            <dl className="product-specs">
              {sortedEntries.map(([k, v]) => (
                <div key={k} className="product-spec-row">
                  <dt>{labelFor(k)}</dt>
                  <dd>
                    {Array.isArray(v) ? (
                      <div className="spec-chips">
                        {v.map((x, i) => <span key={i} className="spec-chip">{x}</span>)}
                      </div>
                    ) : v}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {(product.attachments.length > 0 || canEdit) && (
            <div className="product-att-section">
              <div className="product-att-head">
                <strong>Attachments / drawings</strong>
                {canEdit && (
                  <label className="att-btn">
                    + Add
                    <input
                      type="file"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files) onUploadFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              {product.attachments.length === 0 ? (
                <div className="att-empty-mini">No drawings yet.</div>
              ) : (
                <div className="att-list">
                  {product.attachments.map((a) => (
                    <div key={a.id} className="att-item">
                      <div className="att-icon">{(a.name.split(".").pop() ?? "FILE").toUpperCase()}</div>
                      <div className="att-info">
                        <div className="att-name">{a.name}</div>
                        <div className="att-meta">{fmtBytes(a.size)} · {new Date(a.addedAt).toLocaleDateString()}</div>
                      </div>
                      <a className="att-btn" href={a.url} target="_blank" rel="noopener noreferrer">Open</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {product.sourceUrl && (
            <a className="product-source" href={product.sourceUrl} target="_blank" rel="noopener noreferrer">
              View on competitor's site ↗
            </a>
          )}
          {canEdit && (
            <div className="product-actions">
              <button className="att-btn danger" onClick={() => confirm(`Delete "${product.name}"?`) && onDelete()}>Delete product</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function labelFor(key: string): string {
  const map: Record<string, string> = {
    dimensions: "Dimensions",
    maxLength: "Max length",
    colors: "Colors",
    finishes: "Finishes",
    certifications: "Certifications",
    cct: "CCT",
    lumens: "Lumens",
    wattage: "Wattage",
    cri: "CRI",
    beamAngle: "Beam angle",
    voltage: "Voltage",
    ipRating: "IP rating",
    mounting: "Mounting",
    lensType: "Lens / optic",
    orientation: "Orientation",
    driverLocation: "Driver location",
    dimming: "Dimming",
    efficacy: "Efficacy",
    customization: "Customization",
    accessories: "Accessories",
    notes: "Notes",
  };
  return map[key] ?? key;
}

function FormView({
  draft, setDraft, isNew, collectionName, onCancel, onSave,
  aiUrl, setAiUrl, aiUploads, setAiUploads, aiGenerating, onAiUpload, onAiGenerate,
  aiBackupActive, onRevertAi,
}: {
  draft: CompetitorInput;
  setDraft: React.Dispatch<React.SetStateAction<CompetitorInput | null>>;
  isNew: boolean; collectionName: string;
  onCancel: () => void; onSave: () => void;
  aiUrl: string;
  setAiUrl: (v: string) => void;
  aiUploads: AiSourceUpload[];
  setAiUploads: React.Dispatch<React.SetStateAction<AiSourceUpload[]>>;
  aiGenerating: boolean;
  onAiUpload: (files: FileList | File[]) => void;
  onAiGenerate: () => void;
  aiBackupActive: boolean;
  onRevertAi: () => void;
}) {
  const set = <K extends keyof CompetitorInput>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDraft((d) => d ? { ...d, [k]: e.target.value as CompetitorInput[K] } : d);
  function toggleCap(c: string) {
    setDraft((d) => {
      if (!d) return d;
      const caps = d.capabilities ? [...d.capabilities] : [];
      const i = caps.indexOf(c);
      if (i >= 0) caps.splice(i, 1); else caps.push(c);
      return { ...d, capabilities: caps };
    });
  }
  return (
    <div className="detail-inner">
      <div className="d-head">
        <div>
          <h1 className="d-title">{isNew ? "New competitor" : `Editing — ${draft.name || "Untitled"}`}</h1>
          <p className="d-sub">Will be saved to <strong>{collectionName}</strong>. Required: <strong>Name</strong>.</p>
        </div>
      </div>

      <div className="d-card ai-card">
        <h4>
          <span className="ai-badge">✨ AI</span>&nbsp;
          {isNew ? "Generate from files or website" : "Refine this competitor"}
        </h4>
        <div className="ai-body">
          <input
            type="text"
            placeholder="https://competitor-website.com (optional)"
            value={aiUrl}
            onChange={(e) => setAiUrl(e.target.value)}
          />
          <label className="ai-drop">
            {aiUploads.length === 0
              ? "📎 Click to add PDFs, brochures, screenshots…"
              : `${aiUploads.length} file${aiUploads.length > 1 ? "s" : ""} attached`}
            <input
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) onAiUpload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {aiUploads.length > 0 && (
            <ul className="ai-file-list">
              {aiUploads.map((u, i) => (
                <li key={i}>
                  <span>{u.name}</span>
                  <button className="ai-rm" onClick={() => setAiUploads((s) => s.filter((_, j) => j !== i))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <button
            className="btn primary sm"
            onClick={onAiGenerate}
            disabled={aiGenerating || (!aiUploads.length && !aiUrl.trim())}
          >
            {aiGenerating
              ? (isNew ? "Generating…" : "Refining…")
              : (isNew ? "✨ Generate competitor" : "✨ Refine fields")}
          </button>
        </div>
      </div>

      {aiBackupActive && (
        <div className="ai-revert-banner">
          <span>↩ AI just changed fields below.</span>
          <button className="btn sm" onClick={onRevertAi}>Revert AI changes</button>
        </div>
      )}

      <div className="d-card">
        <h4>Profile</h4>
        <div className="form-grid">
          <div className="field full"><label>Name *</label><input value={draft.name} onChange={set("name")} placeholder="e.g. Acme Linear Co" /></div>
          <div className="field full"><label>Website</label><input value={draft.website ?? ""} onChange={set("website")} placeholder="https://example.com" /></div>
          <div className="field"><label>Parent / owner</label><input value={draft.parent ?? ""} onChange={set("parent")} placeholder="e.g. Private" /></div>
          <div className="field"><label>Country / HQ</label><input value={draft.country ?? ""} onChange={set("country")} placeholder="e.g. USA (NY)" /></div>
          <div className="field">
            <label>Tier</label>
            <select value={draft.tierKey ?? "mid"} onChange={set("tierKey")}>
              {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Tier description</label><input value={draft.tier ?? ""} onChange={set("tier")} placeholder="e.g. Mid / commercial" /></div>
          <div className="field"><label>Segment</label><input value={draft.segment ?? ""} onChange={set("segment")} placeholder="Comma-separated" /></div>
          <div className="field"><label>Channel</label><input value={draft.channel ?? ""} onChange={set("channel")} placeholder="e.g. Distributor / agency" /></div>
          <div className="field full"><label>Product lines</label><input value={draft.productLines ?? ""} onChange={set("productLines")} placeholder="e.g. SHARK, STEALTH, BAYLED" /></div>
          <div className="field full"><label>Notes</label><textarea value={draft.notes ?? ""} onChange={set("notes")} placeholder="Anything worth remembering…" /></div>
        </div>
      </div>

      <div className="d-card">
        <h4>Capabilities — what they provide</h4>
        <div className="cap-picker">
          {CAPABILITIES.map((c) => {
            const active = (draft.capabilities ?? []).includes(c);
            return (
              <button type="button" key={c} className={`chip ${active ? "active" : ""}`} onClick={() => toggleCap(c)}>{c}</button>
            );
          })}
        </div>
      </div>

      <div className="form-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={onSave}>{isNew ? "Create competitor" : "Save changes"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS lifted from the Linear Lights HTML (lightly cleaned)
// ─────────────────────────────────────────────────────────────────────────────

const COMPETITOR_CSS = `
.cm-app{
  /* Local aliases — map to app-wide --lb-* tokens so dark mode and the
     SaaS palette flow automatically. Don't introduce hex values here. */
  --bg:var(--lb-bg);
  --surface:var(--lb-bg-elev);
  --surface-2:var(--lb-bg-sunken);
  --border:var(--lb-border);
  --border-strong:var(--lb-border-strong);
  --text:var(--lb-text);
  --text-2:var(--lb-text-2);
  --muted:var(--lb-text-3);
  --dim:var(--lb-text-3);
  --accent:var(--lb-accent);
  --accent-strong:var(--lb-accent-active);
  --accent-bg:color-mix(in srgb, var(--lb-accent) 12%, transparent);
  --accent-border:color-mix(in srgb, var(--lb-accent) 32%, transparent);
  /* Tier color chips — multi-hue, dark-friendly */
  --t-mass:#a78bfa;
  --t-mass-bg:color-mix(in srgb, #a78bfa 14%, transparent);
  --t-mid:#22d3ee;
  --t-mid-bg:color-mix(in srgb, #22d3ee 14%, transparent);
  --t-spec:#e879f9;
  --t-spec-bg:color-mix(in srgb, #e879f9 14%, transparent);
  --t-premium:#fbbf24;
  --t-premium-bg:color-mix(in srgb, #fbbf24 14%, transparent);
  --ok:var(--lb-success);
  --danger:var(--lb-danger);
  --danger-bg:color-mix(in srgb, var(--lb-danger) 12%, transparent);
  display:grid;grid-template-rows:56px 1fr;height:100%;
  background:var(--lb-bg);color:var(--lb-text);
  font-family:var(--lb-font-text);font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
  overflow:hidden;
}
.cm-app *,.cm-app *::before,.cm-app *::after{box-sizing:border-box}
.cm-app input,.cm-app select,.cm-app textarea{font-family:inherit;color:var(--text)}
.cm-app a{color:var(--accent);text-decoration:none}
.cm-app a:hover{text-decoration:underline}
.cm-app header.bar{display:flex;align-items:center;gap:14px;padding:0 18px;background:var(--surface);border-bottom:1px solid var(--border);position:relative}
.cm-app .brand-mark{width:22px;height:22px;border-radius:6px;background:var(--lb-accent);display:inline-block;position:relative;flex:none}
.cm-app .brand-mark::after{content:"";position:absolute;left:5px;right:5px;top:9px;bottom:9px;background:var(--lb-accent-fg);border-radius:1px;opacity:.92}
.cm-app .coll-picker{display:inline-flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:13px;font-weight:600;color:var(--text);cursor:pointer;font-family:inherit}
.cm-app .coll-picker:hover{background:var(--surface);border-color:var(--border-strong)}
.cm-app .coll-picker.open{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent-strong)}
.cm-app .coll-name{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .coll-chev{color:var(--muted)}
.cm-app .coll-picker.open .coll-chev{color:var(--accent)}
.cm-app .brand-sub{color:var(--text-2);font-weight:500;font-size:13px}
.cm-app .brand-sep{color:var(--dim);font-weight:400;margin-left:2px}
.cm-app .spacer{flex:1}
.cm-app .search-wrap{position:relative;width:340px;max-width:34vw}
.cm-app .search-ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:12px;pointer-events:none}
.cm-app .search{width:100%;padding:7px 12px 7px 32px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:13px}
.cm-app .search:focus{outline:none;border-color:var(--accent);background:var(--surface)}
.cm-app .btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.cm-app .btn:hover{background:var(--surface-2);border-color:var(--border-strong)}
.cm-app .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.cm-app .btn.primary:hover{background:var(--accent-strong);border-color:var(--accent-strong)}
.cm-app .btn.danger{color:var(--danger);border-color:var(--border)}
.cm-app .btn.danger:hover{background:var(--danger-bg);border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent)}
.cm-app .btn.ghost{background:transparent;border-color:transparent}
.cm-app .btn.ghost:hover{background:var(--surface-2);border-color:var(--border)}
.cm-app .btn.sm{padding:5px 9px;font-size:12px}
.cm-app .btn:disabled{opacity:.5;cursor:not-allowed}
.cm-app .coll-menu{position:absolute;top:48px;left:18px;z-index:80;background:var(--surface);border:1px solid var(--border);border-radius:var(--lb-radius-sm);box-shadow:var(--lb-shadow-lg);min-width:280px;max-width:340px;padding:6px}
.cm-app .coll-menu-h{padding:8px 10px 4px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.cm-app .coll-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.cm-app .coll-item:hover{background:var(--surface-2)}
.cm-app .coll-item.active{background:var(--accent-bg);color:var(--accent-strong);font-weight:600}
.cm-app .coll-item-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .coll-item-meta{font-size:11px;color:var(--muted);font-weight:400}
.cm-app .coll-item.active .coll-item-meta{color:var(--accent)}
.cm-app .coll-divider{height:1px;background:var(--border);margin:5px 6px}
.cm-app .coll-action{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;color:var(--text-2);font-weight:500;border:0;background:transparent;width:100%;text-align:left;font-family:inherit}
.cm-app .coll-action:hover{background:var(--surface-2);color:var(--text)}
.cm-app .coll-action.danger{color:var(--danger)}
.cm-app .coll-action.danger:hover{background:var(--danger-bg)}
.cm-app .coll-action[disabled]{color:var(--dim);cursor:not-allowed}
.cm-app .coll-action[disabled]:hover{background:transparent}
.cm-app .layout{display:grid;grid-template-columns:380px 1fr;height:calc(100% - 56px);min-height:0}
.cm-app aside.sidebar{display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--surface);min-height:0}
.cm-app .sidebar-tools{padding:12px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.cm-app .row{display:flex;gap:6px;align-items:center}
.cm-app .row label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;flex:none}
.cm-app .selectish{flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12px}
.cm-app .chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}
.cm-app .chip{padding:3px 9px;background:transparent;border:1px solid var(--border);border-radius:999px;font-size:11px;color:var(--text-2);font-family:inherit;cursor:pointer}
.cm-app .chip:hover{border-color:var(--border-strong)}
.cm-app .chip.active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent-strong)}
.cm-app .chip .ct{color:var(--muted);margin-left:3px;font-size:10px}
.cm-app .chip.active .ct{color:var(--accent-strong);opacity:.7}
.cm-app .results-meta{padding:8px 14px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex:none}
.cm-app .brand-list{flex:1;overflow-y:auto;min-height:0}
.cm-app .group-h{padding:9px 14px 5px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;background:var(--surface-2);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:1}
.cm-app .group-h .gct{color:var(--dim);font-weight:500}
.cm-app .row-item{display:flex;flex-direction:column;gap:4px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;position:relative}
.cm-app .row-item:hover{background:var(--surface-2)}
.cm-app .row-item.active{background:var(--accent-bg)}
.cm-app .row-item.active::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.cm-app .row-top{display:flex;align-items:center;gap:8px;justify-content:space-between}
.cm-app .row-name{font-weight:600;font-size:13.5px;color:var(--text)}
.cm-app .row-bottom{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11.5px}
.cm-app .row-tags{display:flex;gap:4px;flex-wrap:wrap}
.cm-app .mini-tag{font-size:10px;padding:1px 6px;background:var(--surface-2);border:1px solid var(--border);border-radius:3px;color:var(--text-2);white-space:nowrap}
.cm-app .row-paperclip{display:inline-flex;align-items:center;gap:2px;color:var(--muted);font-size:10px}
.cm-app .tier-pill{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:3px;white-space:nowrap;flex:none}
.cm-app .tier-mass{color:var(--t-mass);background:var(--t-mass-bg)}
.cm-app .tier-mid{color:var(--t-mid);background:var(--t-mid-bg)}
.cm-app .tier-spec{color:var(--t-spec);background:var(--t-spec-bg)}
.cm-app .tier-premium{color:var(--t-premium);background:var(--t-premium-bg)}
.cm-app main.cm-detail{overflow-y:auto;background:var(--bg);min-height:0}
.cm-app .detail-inner{max-width:880px;margin:0 auto;padding:24px 32px 60px}
.cm-app .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);text-align:center;padding:32px}
.cm-app .empty h3{margin:0 0 4px;font-size:16px;font-weight:600;color:var(--text-2)}
.cm-app .empty p{margin:0;font-size:13px}
.cm-app .d-head{display:flex;align-items:flex-start;gap:14px;justify-content:space-between;margin-bottom:6px}
.cm-app .d-title{margin:0;font-size:24px;font-weight:600;letter-spacing:-.02em}
.cm-app .d-sub{color:var(--text-2);font-size:13px;margin:0 0 14px}
.cm-app .d-actions{display:flex;gap:6px;flex:none}
.cm-app .d-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(17,24,39,.04)}
.cm-app .d-card h4{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
.cm-app .d-card h4 .h-act{text-transform:none;letter-spacing:0;font-weight:500;font-size:12px;color:var(--accent);cursor:pointer}
.cm-app .d-card h4 .h-act:hover{text-decoration:underline}
.cm-app .grid-2{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;align-items:start}
.cm-app .grid-2 dt{color:var(--muted);font-size:12px;font-weight:500;padding-top:1px}
.cm-app .grid-2 dd{margin:0;color:var(--text);font-size:13.5px;word-break:break-word}
.cm-app .pill-row{display:flex;flex-wrap:wrap;gap:6px}
.cm-app .pill{font-size:11.5px;padding:3px 9px;background:var(--accent-bg);border:1px solid var(--accent-border);color:var(--accent-strong);border-radius:999px;font-weight:500}
.cm-app .att-zone{display:block;border:1.5px dashed var(--border-strong);border-radius:8px;padding:18px;text-align:center;color:var(--muted);background:var(--surface-2);cursor:pointer}
.cm-app .att-zone:hover,.cm-app .att-zone.drag{border-color:var(--accent);background:var(--accent-bg);color:var(--accent-strong)}
.cm-app .att-zone strong{color:var(--text-2);font-weight:600}
.cm-app .att-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.cm-app .att-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2)}
.cm-app .att-icon{width:30px;height:30px;border-radius:6px;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:11px;font-weight:600;flex:none}
.cm-app .att-info{flex:1;min-width:0}
.cm-app .att-name{font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .att-meta{font-size:11px;color:var(--muted)}
.cm-app .att-actions{display:flex;gap:4px;flex:none}
.cm-app .att-btn{padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-2);font-size:11px;font-weight:500;cursor:pointer;font-family:inherit}
.cm-app .att-btn:hover{background:var(--surface-2);color:var(--text)}
.cm-app .att-btn.danger{color:var(--danger)}
.cm-app .att-btn.danger:hover{background:var(--danger-bg);border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent)}
.cm-app .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.cm-app .form-grid .full{grid-column:span 2}
.cm-app .field{display:flex;flex-direction:column;gap:5px}
.cm-app .field label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.cm-app .field input,.cm-app .field select,.cm-app .field textarea{padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13.5px;color:var(--text);width:100%;font-family:inherit}
.cm-app .field input:focus,.cm-app .field select:focus,.cm-app .field textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.cm-app .field textarea{min-height:80px;resize:vertical;line-height:1.5}
.cm-app .cap-picker{display:flex;flex-wrap:wrap;gap:6px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);max-height:180px;overflow-y:auto}
.cm-app .form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)}
.cm-app .strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:18px}
.cm-app .strip-cell{background:var(--surface);padding:11px 14px}
.cm-app .strip-cell .lbl{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.cm-app .strip-cell .val{font-size:18px;font-weight:600;letter-spacing:-.01em;margin-top:2px}
.cm-app .strip-cell .sub{font-size:11px;color:var(--muted);margin-top:1px}
.cm-app .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;box-shadow:0 10px 25px rgba(17,24,39,.10);z-index:200}
.cm-app .toast.error{background:var(--danger)}
.cm-app .ai-card{background:var(--accent-bg);border:1px solid var(--accent-border)}
.cm-app .ai-card h4{color:var(--accent-strong);display:flex;align-items:center;gap:6px}
.cm-app .ai-badge{background:var(--lb-accent);color:var(--lb-accent-fg);font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:var(--lb-radius-pill);text-transform:uppercase}
.cm-app .ai-body{display:flex;flex-direction:column;gap:8px}
.cm-app .ai-body .field-input,.cm-app .ai-body input[type=text],.cm-app .ai-body input:not([type=file]){padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13.5px;color:var(--text);width:100%;font-family:inherit}
.cm-app .ai-body input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.cm-app .ai-drop{display:block;padding:14px;border:1.5px dashed var(--border-strong);border-radius:8px;text-align:center;font-size:12.5px;color:var(--muted);cursor:pointer;background:var(--surface);transition:all .15s}
.cm-app .ai-drop:hover{border-color:var(--accent);color:var(--accent-strong);background:var(--accent-bg)}
.cm-app .ai-file-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.cm-app .ai-file-list li{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:5px;font-size:12.5px;color:var(--text-2)}
.cm-app .ai-rm{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 4px;font-family:inherit}
.cm-app .ai-rm:hover{color:var(--danger)}
.cm-app .ai-card .btn{align-self:flex-start}
.cm-app .ai-revert-banner{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;background:color-mix(in srgb, var(--lb-warning) 12%, transparent);border:1px solid color-mix(in srgb, var(--lb-warning) 32%, transparent);border-radius:var(--lb-radius-sm);margin-bottom:14px;font-size:12.5px;color:var(--lb-warning);font-weight:500}
.cm-app .products-grid{display:flex;flex-direction:column;gap:8px}
.cm-app .product-card{border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden;transition:border-color .15s}
.cm-app .product-card:hover{border-color:var(--border-strong)}
.cm-app .product-card.open{border-color:var(--accent-border)}
.cm-app .product-card-head{display:flex;align-items:center;gap:12px;padding:10px 14px;width:100%;background:none;border:0;cursor:pointer;font-family:inherit;text-align:left}
.cm-app .product-card-head:hover{background:var(--surface-2)}
.cm-app .product-thumb{width:64px;height:64px;flex:none;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);overflow:hidden;display:flex;align-items:center;justify-content:center}
.cm-app .product-thumb img{width:100%;height:100%;object-fit:cover}
.cm-app .product-thumb-empty{font-size:24px;color:var(--dim)}
.cm-app .product-info{flex:1;min-width:0}
.cm-app .product-name{font-size:14px;font-weight:600;color:var(--text);line-height:1.25}
.cm-app .product-code{font-size:11.5px;color:var(--muted);font-family:ui-monospace,Consolas,monospace;margin-top:2px}
.cm-app .product-cat{font-size:11px;color:var(--accent-strong);background:var(--accent-bg);display:inline-block;padding:1px 7px;border-radius:10px;margin-top:4px;font-weight:500}
.cm-app .product-preview{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:6px}
.cm-app .product-spec-mini{font-size:11.5px;color:var(--text-2)}
.cm-app .product-spec-mini strong{color:var(--muted);font-weight:500}
.cm-app .product-chev{color:var(--muted);font-size:14px;flex:none}
.cm-app .product-card-body{padding:0 14px 14px;border-top:1px solid var(--border);background:var(--surface-2)}
.cm-app .product-desc{font-size:13px;color:var(--text-2);margin:12px 0;line-height:1.5}
.cm-app .product-image-strip{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.cm-app .product-image-strip a{display:block;width:80px;height:80px;border-radius:6px;overflow:hidden;border:1px solid var(--border)}
.cm-app .product-image-strip img{width:100%;height:100%;object-fit:cover}
.cm-app .product-specs{display:grid;grid-template-columns:120px 1fr;gap:6px 14px;margin:12px 0;font-size:13px}
.cm-app .product-spec-row{display:contents}
.cm-app .product-spec-row dt{color:var(--muted);font-weight:500;padding-top:1px}
.cm-app .product-spec-row dd{margin:0;color:var(--text);word-break:break-word}
.cm-app .spec-chips{display:flex;flex-wrap:wrap;gap:4px}
.cm-app .spec-chip{font-size:11.5px;padding:2px 8px;background:var(--accent-bg);color:var(--accent-strong);border-radius:10px;border:1px solid var(--accent-border)}
.cm-app .product-att-section{border-top:1px dashed var(--border);padding-top:12px;margin-top:12px}
.cm-app .product-att-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.cm-app .product-att-head strong{font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.cm-app .att-empty-mini{font-size:12px;color:var(--muted);font-style:italic;padding:6px 0}
.cm-app .product-source{display:inline-block;font-size:12.5px;color:var(--accent);margin-top:8px}
.cm-app .product-actions{margin-top:14px;display:flex;justify-content:flex-end}
@media(max-width:600px){.cm-app .product-specs{grid-template-columns:1fr;gap:2px}.cm-app .product-spec-row dt{padding-top:6px}.cm-app .product-spec-row dd{padding-bottom:4px}}

/* ── View tabs (Brands / Benchmark / Ideation) ── */
.cm-app .view-tabs{display:flex;gap:2px;margin-left:14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:2px}
.cm-app .view-tab{appearance:none;border:0;background:transparent;color:var(--text-2);font:inherit;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,color .15s}
.cm-app .view-tab:hover{color:var(--text)}
.cm-app .view-tab.active{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(15,23,42,.05);border:1px solid var(--border)}
.cm-app .view-tab .ct{font-size:10.5px;font-weight:600;color:var(--muted);background:var(--surface);border-radius:9px;padding:1px 6px;border:1px solid var(--border)}
.cm-app .view-tab.active .ct{color:var(--accent-strong);background:var(--accent-bg);border-color:var(--accent-border)}

/* ── Solo (full-width) main column for benchmark / ideation tabs ── */
.cm-app .cm-detail.solo{grid-column:1/-1;width:100%;max-width:none;background:var(--bg)}
.cm-app .cm-detail.solo .bm-wrap,
.cm-app .cm-detail.solo .id-wrap{padding:24px 32px;max-width:1320px;margin:0 auto;display:flex;flex-direction:column;gap:18px}

/* ── Common micro-classes used by Benchmark + Ideation ── */
.cm-app .d-eyebrow{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.cm-app .bm-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.cm-app .bm-head .d-actions{display:flex;gap:8px;flex-wrap:wrap}

/* ── Benchmark stat cards ── */
.cm-app .bm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.cm-app .stat-card{display:flex;flex-direction:column;max-height:340px}
.cm-app .stat-card h4{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:0 0 10px;flex:0 0 auto}
.cm-app .stat-card-badge{margin-left:auto;font-size:10.5px;font-weight:600;letter-spacing:0;text-transform:none;padding:2px 7px;border-radius:9px;background:var(--surface-2);color:var(--text-2)}
.cm-app .stat-rows-scroll{flex:1;min-height:0;overflow-y:auto;padding-right:4px;margin-right:-4px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.cm-app .stat-rows-scroll::-webkit-scrollbar{width:6px}
.cm-app .stat-rows-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.cm-app .stat-rows-scroll::-webkit-scrollbar-thumb:hover{background:var(--muted)}
.cm-app .stat-rows{display:flex;flex-direction:column;gap:5px}
.cm-app .stat-row{display:flex;align-items:center;gap:8px;font-size:12.5px}
.cm-app .stat-row-bar{flex:1;position:relative;background:var(--accent-bg);border:1px solid var(--accent-border);border-radius:5px;height:22px;overflow:hidden;display:flex;align-items:center}
.cm-app .stat-row-fill{position:absolute;inset:0 auto 0 0;background:var(--accent-bg);border-right:1px solid var(--accent-border)}
.cm-app .stat-row-label{position:relative;padding:0 8px;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cm-app .stat-row-count{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:24px;text-align:right}

/* ── Benchmark AI panel ── */
.cm-app .bm-ai{background:var(--accent-bg)}
.cm-app .bm-ai-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:6px}
.cm-app .bm-ai-grid h5{margin:0 0 8px;font-size:12px;color:var(--accent-strong);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.cm-app .bm-list{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
.cm-app .bm-list li strong{color:var(--text)}

/* ── Benchmark photo wall ── */
.cm-app .bm-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.cm-app .bm-photo{display:block;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .15s,border-color .15s}
.cm-app .bm-photo:hover{transform:translateY(-1px);border-color:var(--accent-border)}
.cm-app .bm-photo img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--surface-2)}
.cm-app .bm-photo-cap{padding:6px 8px;display:flex;flex-direction:column;font-size:11px;line-height:1.3;border-top:1px solid var(--border)}
.cm-app .bm-photo-brand{color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.cm-app .bm-photo-name{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-app .bm-photo-more{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;background:var(--surface-2);border:1px dashed var(--border);border-radius:10px;aspect-ratio:1/1}

/* ── Ideation board ── */
.cm-app .id-input-row{display:grid;grid-template-columns:2fr auto 2fr;gap:10px;align-items:center}
.cm-app .id-drop{display:flex;align-items:center;justify-content:center;text-align:center;border:2px dashed var(--border-strong);border-radius:10px;padding:18px;background:var(--surface-2);cursor:pointer;font-size:13px;color:var(--text-2);transition:border-color .15s,background .15s}
.cm-app .id-drop:hover,.cm-app .id-drop.drag{border-color:var(--accent);background:var(--accent-bg)}
.cm-app .id-or{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;text-align:center}
.cm-app .id-url-row{display:flex;gap:6px}
.cm-app .id-url{flex:1;min-width:0}
.cm-app .id-url-row input,.cm-app .id-input input,.cm-app .id-input textarea{width:100%}
.cm-app .id-controls{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.cm-app .id-search input{min-width:240px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px}
.cm-app .id-ai{background:var(--accent-bg)}
.cm-app .id-ai-row{display:flex;gap:8px;margin:8px 0}
.cm-app .id-ai-row input{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px}
.cm-app .id-ai-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:14px}
.cm-app .id-idea{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}
.cm-app .id-idea-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
.cm-app .id-idea-head strong{font-size:14px;color:var(--text)}
.cm-app .id-idea-cat{font-size:10.5px;background:var(--accent-bg);border:1px solid var(--accent-border);color:var(--accent-strong);padding:2px 7px;border-radius:9px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.cm-app .id-idea-concept{font-size:12.5px;color:var(--text-2);margin:0 0 8px;line-height:1.45}
.cm-app .id-idea-specs{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:4px 8px;margin:0 0 8px;font-size:11.5px}
.cm-app .id-idea-specs div{display:flex;flex-direction:column}
.cm-app .id-idea-specs dt{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.cm-app .id-idea-specs dd{margin:0;color:var(--text);font-weight:500}
.cm-app .id-idea-section{margin-top:6px}
.cm-app .id-idea-section-h{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.cm-app .id-idea-section ul{margin:2px 0 0;padding-left:18px;font-size:12px;color:var(--text-2);line-height:1.5}
.cm-app .id-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.cm-app .id-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;transition:transform .15s,border-color .15s,box-shadow .15s}
.cm-app .id-card:hover{transform:translateY(-1px);border-color:var(--accent-border);box-shadow:0 2px 8px rgba(15,23,42,.06)}
.cm-app .id-card-img{position:relative;appearance:none;border:0;background:var(--surface-2);cursor:pointer;padding:0;display:block;width:100%;aspect-ratio:4/3;overflow:hidden}
.cm-app .id-card-img img{width:100%;height:100%;object-fit:cover;display:block}
.cm-app .id-card-pen{position:absolute;top:6px;right:6px;background:var(--surface);border:1px solid var(--border);border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--accent-strong)}
.cm-app .id-kind{position:absolute;bottom:6px;left:6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:9px;background:var(--surface);border:1px solid var(--border);color:var(--text-2)}
.cm-app .id-kind-sketch{background:color-mix(in srgb, #a78bfa 14%, transparent);border-color:color-mix(in srgb, #a78bfa 32%, transparent);color:#a78bfa}
.cm-app .id-kind-mounting{background:color-mix(in srgb, #22d3ee 14%, transparent);border-color:color-mix(in srgb, #22d3ee 32%, transparent);color:#22d3ee}
.cm-app .id-kind-moodboard{background:color-mix(in srgb, var(--lb-warning) 14%, transparent);border-color:color-mix(in srgb, var(--lb-warning) 32%, transparent);color:var(--lb-warning)}
.cm-app .id-kind-ai-generated{background:color-mix(in srgb, #e879f9 14%, transparent);border-color:color-mix(in srgb, #e879f9 32%, transparent);color:#e879f9}
.cm-app .id-card-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:4px}
.cm-app .id-card-title{appearance:none;border:0;background:transparent;font:inherit;font-size:13px;font-weight:500;color:var(--text);padding:0;border-radius:4px}
.cm-app .id-card-title:focus{outline:1px solid var(--accent);outline-offset:2px}
.cm-app .id-card-brand{font-size:11px;color:var(--muted)}
.cm-app .id-card-actions{display:flex;gap:6px;margin-top:4px}

/* ── Sketch overlay ── */
.cm-app .sketch-wrap{display:flex;flex-direction:column;gap:8px}
.cm-app .sketch-img{position:relative;width:100%;background:#0f172a;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.cm-app .sketch-img img{display:block;max-width:100%;max-height:70vh;object-fit:contain;user-select:none;-webkit-user-drag:none}
.cm-app .sketch-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none}
.cm-app .sketch-canvas.editing{pointer-events:auto;cursor:crosshair}
.cm-app .sketch-toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px}
.cm-app .sketch-colors{display:flex;gap:5px}
.cm-app .sketch-color{width:22px;height:22px;border-radius:50%;border:2px solid #fff;outline:1px solid var(--border);cursor:pointer}
.cm-app .sketch-color.active{outline:2px solid var(--accent)}
.cm-app .sketch-width{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted)}
.cm-app .sketch-width input{width:120px}
.cm-app .sketch-actions{display:flex;gap:6px;margin-left:auto}

/* ── Modal ── */
.cm-app .id-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);z-index:50;display:flex;align-items:center;justify-content:center;padding:24px}
.cm-app .id-modal{background:var(--surface);border-radius:12px;box-shadow:0 24px 60px rgba(15,23,42,.25);width:min(1100px,100%);max-height:calc(100vh - 48px);overflow:hidden;display:flex;flex-direction:column}
.cm-app .id-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)}
.cm-app .id-modal-title input{appearance:none;border:0;background:transparent;font:inherit;font-size:18px;font-weight:600;color:var(--text);padding:4px 6px;border-radius:6px;width:100%}
.cm-app .id-modal-title input:focus{outline:1px solid var(--accent);outline-offset:2px}
.cm-app .id-modal-actions{display:flex;gap:6px}
.cm-app .id-modal-body{display:grid;grid-template-columns:minmax(0,1.6fr) 320px;gap:14px;padding:14px 16px;overflow:auto;flex:1;min-height:0}
.cm-app .id-modal-img{min-width:0}
.cm-app .id-modal-side{display:flex;flex-direction:column;gap:10px}
.cm-app .id-modal-side .field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-2)}
.cm-app .id-modal-side .field span{font-weight:600;color:var(--text-2)}
.cm-app .id-modal-side .field em{color:var(--muted);font-style:normal;font-weight:400}
.cm-app .id-modal-side .field input,.cm-app .id-modal-side .field select,.cm-app .id-modal-side .field textarea{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px;background:var(--surface);color:var(--text)}
.cm-app .id-modal-side .field textarea{resize:vertical;min-height:80px}
@media(max-width:880px){.cm-app .id-modal-body{grid-template-columns:1fr}.cm-app .id-input-row{grid-template-columns:1fr}.cm-app .id-or{display:none}}

/* ── Brands toolbar (header) ── */
.cm-app .brands-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.cm-app .brands-toolbar .btn.danger{color:var(--danger);border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);background:var(--danger-bg)}
.cm-app .brands-toolbar .btn.danger:hover:not(:disabled){background:color-mix(in srgb, var(--lb-danger) 18%, transparent)}

/* ── Per-brand benchmark layout ── */
.cm-app .bm-brands{display:flex;flex-direction:column;gap:14px}
.cm-app .brand-section{padding:14px 16px}
.cm-app .brand-section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;user-select:none}
.cm-app .brand-section-head:hover .brand-section-chev{color:var(--accent-strong)}
.cm-app .brand-section-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1;min-width:0}
.cm-app .brand-section-title h3{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em;color:var(--text)}
.cm-app .brand-section-chev{font-size:14px;color:var(--muted);transition:color .15s}
.cm-app .brand-section-meta{font-size:12px;color:var(--muted)}
.cm-app .brand-section-link{font-size:12px;color:var(--accent);text-decoration:none}
.cm-app .brand-section-link:hover{text-decoration:underline}
.cm-app .brand-section-notes{font-size:13px;color:var(--text-2);margin:8px 0 14px;line-height:1.5}
.cm-app .brand-section-empty{font-size:12.5px;color:var(--muted);font-style:italic;padding:10px 0 4px}
.cm-app .bm-product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}

/* ── Per-product benchmark card (compact + expandable) ── */
.cm-app .bm-product{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,box-shadow .15s}
.cm-app .bm-product.open{border-color:var(--accent-border);background:var(--surface)}
.cm-app .bm-product-head{appearance:none;border:0;background:transparent;padding:8px;display:grid;grid-template-columns:64px 1fr 14px;gap:10px;align-items:center;cursor:pointer;text-align:left;width:100%}
.cm-app .bm-product-head:hover{background:var(--surface)}
.cm-app .bm-product-thumb{width:64px;height:64px;border-radius:6px;background:var(--surface-2);overflow:hidden;display:flex;align-items:center;justify-content:center}
.cm-app .bm-product-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cm-app .bm-product-thumb-empty{font-size:18px;color:var(--muted)}
.cm-app .bm-product-info{min-width:0;display:flex;flex-direction:column;gap:2px}
.cm-app .bm-product-name{font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-app .bm-product-code{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.cm-app .bm-product-cat{font-size:10.5px;color:var(--accent-strong);background:var(--accent-bg);border:1px solid var(--accent-border);padding:1px 7px;border-radius:9px;align-self:flex-start;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.cm-app .bm-product-preview{display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:2px}
.cm-app .bm-product-spec-mini{font-size:11px;color:var(--text-2)}
.cm-app .bm-product-spec-mini strong{color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;font-size:10px;margin-right:2px}
.cm-app .bm-product-chev{color:var(--muted);font-size:12px}
.cm-app .bm-product-body{padding:10px 12px 14px;border-top:1px solid var(--border);background:var(--surface-2)}
.cm-app .bm-product-desc{font-size:12.5px;color:var(--text-2);margin:0 0 10px;line-height:1.5}
.cm-app .bm-product-strip{display:flex;gap:6px;overflow-x:auto;margin:0 0 10px;padding-bottom:4px}
.cm-app .bm-product-strip a{flex:0 0 64px;height:64px;border-radius:6px;overflow:hidden;background:var(--surface-2)}
.cm-app .bm-product-strip img{width:100%;height:100%;object-fit:cover;display:block}
.cm-app .bm-product-specs{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0 0 10px;font-size:12.5px}
.cm-app .bm-product-spec-row{display:contents}
.cm-app .bm-product-spec-row dt{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding-top:3px;white-space:nowrap}
.cm-app .bm-product-spec-row dd{margin:0;color:var(--text);font-weight:500;line-height:1.45}
.cm-app .bm-specsheets{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 0 0;border-top:1px dashed var(--border);margin-top:6px}
.cm-app .bm-specsheets strong{font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
.cm-app .bm-product-source{display:inline-block;font-size:12px;color:var(--accent);margin-top:8px}

/* ── Ideation sticky notes (Miro-style text-only cards) ── */
.cm-app .id-card-sticky{background:color-mix(in srgb, var(--lb-warning) 14%, transparent);border-color:color-mix(in srgb, var(--lb-warning) 32%, transparent);box-shadow:0 1px 3px rgba(0,0,0,0.18)}
.cm-app .id-card-sticky:hover{border-color:var(--lb-warning);box-shadow:0 4px 12px rgba(0,0,0,0.24)}
.cm-app .id-card-sticky-body{appearance:none;border:0;background:transparent;padding:14px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:6px;font:inherit;color:var(--text);min-height:140px;width:100%}
.cm-app .id-card-sticky-mark{font-size:18px;color:var(--accent-strong);align-self:flex-start;line-height:1}
.cm-app .id-card-sticky-text{margin:0;font-size:13.5px;line-height:1.45;color:var(--text);white-space:pre-wrap;word-break:break-word;flex:1}
.cm-app .id-card-sticky-empty{color:var(--muted);font-style:italic}
.cm-app .id-modal-sticky{height:100%;display:flex;align-items:stretch;justify-content:stretch;background:transparent;padding:6px}

/* ── Summary drill-down modal ── */
.cm-app .stat-row{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;width:100%;border:0;background:transparent;padding:0;font:inherit;text-align:left;color:inherit}
.cm-app .stat-row-clickable{cursor:pointer;border-radius:5px;padding:1px 0}
.cm-app .stat-row-clickable:hover{background:var(--accent-bg)}
.cm-app .summary-drilldown-bg{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);z-index:50;display:flex;align-items:center;justify-content:center;padding:24px}
.cm-app .summary-drilldown{background:var(--surface);border-radius:12px;box-shadow:0 24px 60px rgba(15,23,42,.25);width:min(680px,100%);max-height:calc(100vh - 48px);overflow:hidden;display:flex;flex-direction:column}
.cm-app .summary-drilldown-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.cm-app .summary-drilldown-head h3{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.cm-app .summary-drilldown-body{padding:8px 12px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.cm-app .summary-drilldown-item{display:grid;grid-template-columns:auto 1fr 18px;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer;text-align:left;font:inherit;color:inherit;transition:border-color .15s,background .15s}
.cm-app .summary-drilldown-item:hover{border-color:var(--accent);background:var(--accent-bg)}
.cm-app .summary-drilldown-brand{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.cm-app .summary-drilldown-name{font-size:13.5px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .summary-drilldown-arrow{color:var(--accent);font-size:14px}

/* ── Flash highlight when jumping to a product from Summary ── */
.cm-app .bm-product-flash{animation:bm-flash 1.4s ease-out 1}
@keyframes bm-flash{0%{box-shadow:0 0 0 0 rgba(180,83,9,.5)}50%{box-shadow:0 0 0 6px rgba(180,83,9,.18)}100%{box-shadow:0 0 0 0 rgba(180,83,9,0)}}

/* ── Brand-section actions / extract bar ── */
.cm-app .brand-section-actions{display:flex;align-items:center;gap:10px}
.cm-app .bm-extract-bar{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px dashed var(--border);margin-top:8px}

/* ── File listings (per-product + per-brand) ── */
.cm-app .bm-files{padding:10px 0 0;border-top:1px dashed var(--border);margin-top:8px}
.cm-app .bm-files-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.cm-app .bm-files-head strong{font-size:11.5px;color:var(--text);text-transform:uppercase;letter-spacing:.05em}
.cm-app .bm-files-group{margin-bottom:8px}
.cm-app .bm-files-group-h{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:4px}
.cm-app .bm-files-list{display:flex;flex-direction:column;gap:4px}
.cm-app .bm-file{display:grid;grid-template-columns:38px 1fr 18px;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);text-decoration:none;color:var(--text);font-size:12px;transition:border-color .15s,background .15s}
.cm-app .bm-file:hover{border-color:var(--accent-border);background:var(--accent-bg)}
.cm-app .bm-file-ext{display:inline-flex;align-items:center;justify-content:center;height:26px;border-radius:4px;background:var(--surface-2);font-size:9.5px;font-weight:700;color:var(--text-2);letter-spacing:.04em;text-transform:uppercase;padding:0 4px;text-align:center}
.cm-app .bm-file-info{display:flex;flex-direction:column;min-width:0}
.cm-app .bm-file-name{font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .bm-file-meta{font-size:10.5px;color:var(--muted)}
.cm-app .bm-file-dl{font-size:13px;color:var(--accent);justify-self:end}
.cm-app .bm-file-row{display:flex;align-items:stretch;gap:4px}
.cm-app .bm-file-row .bm-file{flex:1;min-width:0}
.cm-app .bm-file-del{flex:0 0 auto;width:28px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--muted);font-size:13px;line-height:1;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.cm-app .bm-file-del:hover:not(:disabled){border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);background:var(--danger-bg);color:var(--lb-danger)}
.cm-app .bm-file-del:disabled{opacity:.5;cursor:wait}
.cm-app .btn.xs{padding:2px 8px;font-size:11px;border-radius:5px;line-height:1.4}

/* ── AddProductForm: user-curated entry at the top of Benchmark ── */
.cm-app .add-product-trigger{display:flex;align-items:center;gap:14px;padding:14px 18px;margin:0 0 16px;border:1px dashed var(--border);border-radius:10px;background:var(--accent-bg, #f8fafc)}
.cm-app .add-product-trigger .btn.primary{flex:0 0 auto}
.cm-app .add-product-trigger-hint{color:var(--muted);font-size:12px}
.cm-app .add-product-card{padding:16px 18px;margin:0 0 16px;border:1px solid var(--accent-border, var(--border));border-radius:10px;background:var(--surface);box-shadow:0 1px 3px rgba(15,23,42,.04)}
.cm-app .add-product-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.cm-app .add-product-head strong{font-size:14px}
.cm-app .add-product-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.cm-app .add-product-label{flex:0 0 130px;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding-top:7px}
.cm-app .add-product-input{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text);transition:border-color .15s}
.cm-app .add-product-input:focus{outline:none;border-color:var(--accent)}
.cm-app .add-product-files{flex:1;min-width:0}
.cm-app .add-product-files input[type=file]{font-size:12px;padding:4px 0}
.cm-app .add-product-files-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}
.cm-app .add-product-files-list li{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--border);border-radius:5px;font-size:12px;background:var(--accent-bg, #f8fafc)}
.cm-app .add-product-files-list li>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-app .add-product-file-rm{flex:0 0 auto;border:none;background:transparent;color:var(--muted);font-size:13px;cursor:pointer;padding:0 4px;line-height:1}
.cm-app .add-product-file-rm:hover:not(:disabled){color:var(--lb-danger)}
.cm-app .add-product-status{margin:6px 0;padding:7px 10px;border-radius:5px;background:color-mix(in srgb, var(--lb-info) 14%, transparent);color:var(--lb-info);font-size:12px;font-weight:500}
.cm-app .add-product-actions{display:flex;gap:8px;margin-top:10px}

/* ── Inline image gallery on the expanded product card ── */
.cm-app .bm-product-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:0 0 12px}
.cm-app .bm-product-gallery-tile{padding:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface);cursor:pointer;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;transition:border-color .15s,transform .1s}
.cm-app .bm-product-gallery-tile:hover{border-color:var(--accent);transform:translateY(-1px)}
.cm-app .bm-product-gallery-tile img{width:100%;height:100%;object-fit:contain;display:block}
.cm-app .bm-product-thumb.clickable{cursor:zoom-in}

/* ── FilePreviewModal: dashboard-native preview for images + PDFs ── */
.cm-app .fp-overlay{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.78);display:flex;align-items:center;justify-content:center;padding:24px;animation:fp-fade .15s ease-out}
@keyframes fp-fade{from{opacity:0}to{opacity:1}}
.cm-app .fp-modal{position:relative;width:min(1200px,100%);height:min(900px,calc(100vh - 48px));background:var(--surface);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 48px rgba(15,23,42,.4)}
.cm-app .fp-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface)}
.cm-app .fp-title{display:flex;flex-direction:column;flex:1;min-width:0}
.cm-app .fp-name{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .fp-counter{font-size:11px;color:var(--muted)}
.cm-app .fp-actions{display:flex;gap:6px;flex:0 0 auto}
.cm-app .fp-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);text-decoration:none;font-size:14px;cursor:pointer;transition:border-color .15s,background .15s}
.cm-app .fp-btn:hover{border-color:var(--accent);background:var(--accent-bg, #f8fafc)}
.cm-app .fp-close{font-weight:700}
.cm-app .fp-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#0f172a;position:relative;overflow:hidden}
.cm-app .fp-image{max-width:100%;max-height:100%;object-fit:contain;display:block}
.cm-app .fp-pdf{width:100%;height:100%;border:0;background:var(--surface)}
.cm-app .fp-other{color:#fff;text-align:center;padding:32px}
.cm-app .fp-other p{margin:0 0 12px;font-size:14px}
.cm-app .fp-other-actions{display:flex;gap:8px;justify-content:center;margin-top:14px}
.cm-app .fp-nav{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,.18);color:#fff;font-size:24px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,opacity .15s}
.cm-app .fp-nav:hover:not(:disabled){background:rgba(255,255,255,.34)}
.cm-app .fp-nav:disabled{opacity:.3;cursor:not-allowed}
.cm-app .fp-prev{left:14px}
.cm-app .fp-next{right:14px}
.cm-app .fp-strip{display:flex;gap:6px;padding:8px 14px;border-top:1px solid var(--border);background:var(--surface);overflow-x:auto;scrollbar-width:thin}
.cm-app .fp-thumb{flex:0 0 60px;width:60px;height:60px;border:2px solid transparent;border-radius:5px;padding:0;background:#0f172a;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.cm-app .fp-thumb.active{border-color:var(--accent)}
.cm-app .fp-thumb:hover{border-color:var(--accent-border, var(--accent))}
.cm-app .fp-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cm-app .fp-thumb-ext{font-size:10px;color:#cbd5e1;font-weight:700;letter-spacing:.04em}

/* ── Compact product card (whole card opens drawer on click) ── */
.cm-app .bm-product-head.card-clickable{cursor:pointer;transition:border-color .15s,background .15s,transform .1s}
.cm-app .bm-product-head.card-clickable:hover{border-color:var(--accent);background:var(--accent-bg, #f8fafc)}
.cm-app .bm-product-head.card-clickable:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cm-app .bm-product-thumb{position:relative}
.cm-app .bm-product-counts{display:inline-flex;gap:4px;margin-top:6px}
.cm-app .bm-product-count{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;background:var(--surface-2);color:var(--text-2);border-radius:9px;font-size:11px;font-weight:600;letter-spacing:.02em}
.cm-app .bm-count-icon{font-size:11px;line-height:1}
.cm-app .bm-count-num{font-size:11px;line-height:1}

/* ── ProductDetailDrawer: slide-in panel from the right ── */
.cm-app .pd-overlay{position:fixed;inset:0;z-index:900;background:rgba(15,23,42,0);transition:background .22s ease-out;display:flex;justify-content:flex-end;align-items:stretch;pointer-events:none}
.cm-app .pd-overlay.entered{background:rgba(15,23,42,.4);pointer-events:auto}
.cm-app .pd-drawer{width:min(900px,92vw);background:var(--surface);box-shadow:-12px 0 32px rgba(15,23,42,.18);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s cubic-bezier(.32,.72,.0,1);will-change:transform;pointer-events:auto}
.cm-app .pd-drawer.entered{transform:translateX(0)}
.cm-app .pd-head{display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface);flex:0 0 auto}
.cm-app .pd-close{flex:0 0 auto;width:32px;height:32px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:border-color .15s,background .15s}
.cm-app .pd-close:hover{border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);background:var(--danger-bg);color:var(--lb-danger)}
.cm-app .pd-title{flex:1;min-width:0}
.cm-app .pd-brand{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:2px}
.cm-app .pd-name{margin:0 0 4px;font-size:18px;font-weight:600;color:var(--text);line-height:1.25}
.cm-app .pd-meta{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted)}
.cm-app .pd-meta>span{padding:1px 7px;background:var(--accent-bg, #f1f5f9);border-radius:9px}
.cm-app .pd-body{flex:1;overflow-y:auto;padding:16px 18px 28px;display:flex;flex-direction:column;gap:18px}
.cm-app .pd-section{display:flex;flex-direction:column}
.cm-app .pd-section-h{margin:0 0 10px;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600}

/* Hero image with prev/next */
.cm-app .pd-gallery{display:flex;flex-direction:column;gap:10px}
.cm-app .pd-hero{position:relative;background:#0f172a;border-radius:8px;overflow:hidden;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center}
.cm-app .pd-hero-img{width:100%;height:100%;border:0;background:transparent;padding:0;cursor:zoom-in;display:flex;align-items:center;justify-content:center}
.cm-app .pd-hero-img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.cm-app .pd-hero-nav{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.18);color:#fff;font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.cm-app .pd-hero-nav:hover{background:rgba(255,255,255,.34)}
.cm-app .pd-hero-nav.pd-prev{left:10px}
.cm-app .pd-hero-nav.pd-next{right:10px}
.cm-app .pd-hero-counter{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,.78);color:#fff;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:600;letter-spacing:.02em}
.cm-app .pd-thumbs{display:flex;gap:6px;overflow-x:auto;padding:2px 0;scrollbar-width:thin}
.cm-app .pd-thumb{flex:0 0 56px;width:56px;height:56px;border:2px solid transparent;border-radius:5px;padding:0;background:#0f172a;cursor:pointer;overflow:hidden;transition:border-color .15s}
.cm-app .pd-thumb:hover{border-color:var(--accent-border, var(--accent))}
.cm-app .pd-thumb.active{border-color:var(--accent)}
.cm-app .pd-thumb img{width:100%;height:100%;object-fit:cover;display:block}

/* Description */
.cm-app .pd-desc{margin:0;font-size:13px;color:var(--text);line-height:1.55}

/* Specs — grouped by section, two-column layout, prettier hierarchy */
.cm-app .pd-spec-group{margin-bottom:18px;padding:14px 16px;border:1px solid var(--border);border-radius:var(--lb-radius);background:var(--surface)}
.cm-app .pd-spec-group:last-child{margin-bottom:0}
.cm-app .pd-spec-group-h{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--border);position:relative}
.cm-app .pd-spec-group-h::before{content:"";position:absolute;left:-16px;top:2px;bottom:8px;width:3px;border-radius:2px;background:var(--accent)}
.cm-app .pd-spec-group-title{font-size:11.5px;color:var(--text);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.cm-app .pd-spec-group-count{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--muted);padding:2px 7px;border-radius:9px;background:var(--surface-2)}
.cm-app .pd-specs{margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px 18px}
.cm-app .pd-spec-row{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px dashed var(--border);min-height:26px}
.cm-app .pd-spec-row:last-child{border-bottom:0}
.cm-app .pd-spec-row dt{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;align-self:start;padding-top:1px}
.cm-app .pd-spec-row dd{margin:0;min-width:0;font-size:13px;color:var(--text);line-height:1.45}
.cm-app .pd-spec-value{font-weight:500;color:var(--text);word-break:break-word}
.cm-app .pd-spec-empty{color:var(--muted);opacity:.45;font-size:13px}
.cm-app .pd-spec-chips{display:flex;flex-wrap:wrap;gap:4px}
.cm-app .pd-spec-chip{display:inline-flex;align-items:center;padding:2px 9px;background:var(--accent-bg, #f1f5f9);border:1px solid var(--accent-border, var(--border));border-radius:11px;font-size:11.5px;color:var(--text);font-weight:500;line-height:1.4;white-space:nowrap}
.cm-app .pd-spec-row.pd-spec-row-empty{min-height:24px}

/* Files */
.cm-app .pd-files-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.cm-app .pd-files-count{font-size:11px;color:var(--muted);font-weight:500}
.cm-app .pd-extract-bar{margin-bottom:10px}
.cm-app .pd-empty{margin:0;font-size:12px;color:var(--muted);font-style:italic}
.cm-app .pd-files{display:flex;flex-direction:column;gap:10px}
.cm-app .pd-files-group-h{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:4px}
.cm-app .pd-files-list{display:flex;flex-direction:column;gap:4px}
.cm-app .pd-file-row{display:flex;align-items:stretch;gap:4px}
.cm-app .pd-file-row .pd-file{flex:1;min-width:0}
.cm-app .pd-file{display:grid;grid-template-columns:38px 1fr 22px;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
.cm-app .pd-file:hover{border-color:var(--accent);background:var(--accent-bg, #f8fafc)}
.cm-app .pd-file-ext{display:inline-flex;align-items:center;justify-content:center;height:26px;border-radius:4px;background:var(--surface-2);font-size:9.5px;font-weight:700;color:var(--text-2);letter-spacing:.04em;text-transform:uppercase;padding:0 4px}
.cm-app .pd-file-info{display:flex;flex-direction:column;min-width:0}
.cm-app .pd-file-name{font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-app .pd-file-meta{font-size:10.5px;color:var(--muted)}
.cm-app .pd-file-eye{font-size:13px;color:var(--accent);justify-self:end}
.cm-app .pd-file-del{flex:0 0 auto;width:28px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--muted);font-size:13px;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.cm-app .pd-file-del:hover:not(:disabled){border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);background:var(--danger-bg);color:var(--lb-danger)}
.cm-app .pd-file-del:disabled{opacity:.5;cursor:wait}
.cm-app .pd-source{font-size:12.5px;color:var(--accent);text-decoration:none}
.cm-app .pd-source:hover{text-decoration:underline}

/* Drawer header actions: Edit, Delete, Save, Cancel */
.cm-app .pd-head-actions{display:flex;gap:6px;flex:0 0 auto;align-self:flex-start;margin-left:8px}
.cm-app .btn.pd-danger{color:var(--lb-danger);border-color:var(--border)}
.cm-app .btn.pd-danger:hover:not(:disabled){background:var(--danger-bg);border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);color:var(--lb-danger)}

/* Editable name input matches the static heading size */
.cm-app .pd-name-input{width:100%;margin:0 0 4px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:18px;font-weight:600;color:var(--text);background:var(--surface);transition:border-color .15s}
.cm-app .pd-name-input:focus{outline:none;border-color:var(--accent)}

/* Edit form grid */
.cm-app .pd-edit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.cm-app .pd-edit-row{display:flex;flex-direction:column;gap:4px}
.cm-app .pd-edit-row-full{grid-column:1 / -1}
.cm-app .pd-edit-label{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.cm-app .pd-edit-hint{font-weight:500;text-transform:none;letter-spacing:0;color:var(--muted)}
.cm-app .pd-edit-input{width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;background:var(--surface);color:var(--text);transition:border-color .15s}
.cm-app .pd-edit-input:focus{outline:none;border-color:var(--accent)}
.cm-app .pd-edit-textarea{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;background:var(--surface);color:var(--text);font-family:inherit;line-height:1.5;resize:vertical;transition:border-color .15s}
.cm-app .pd-edit-textarea:focus{outline:none;border-color:var(--accent)}

/* ── Ideation: Pinterest input card ── */
.cm-app .id-pinterest{padding:14px 16px;margin:0 0 12px;background:color-mix(in srgb, var(--lb-danger) 8%, transparent);border:1px solid color-mix(in srgb, var(--lb-danger) 24%, transparent);border-radius:var(--lb-radius)}
.cm-app .id-pinterest-h{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--lb-danger);display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}
.cm-app .id-pinterest-h-hint{font-weight:400;color:var(--muted);font-size:12px}
.cm-app .id-pinterest-row{display:flex;gap:8px;margin-bottom:8px}
.cm-app .id-pinterest-url{flex:1;padding:8px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text);transition:border-color .15s}
.cm-app .id-pinterest-url:focus{outline:none;border-color:var(--lb-danger)}
.cm-app .id-pinterest-url:disabled{opacity:.6}
.cm-app .id-pinterest-comment{width:100%;padding:8px 11px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;background:var(--surface);color:var(--text);font-family:inherit;line-height:1.5;resize:vertical;transition:border-color .15s}
.cm-app .id-pinterest-comment:focus{outline:none;border-color:var(--lb-danger)}
.cm-app .id-pinterest-cat-label{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);font-weight:500}
.cm-app .id-pinterest-cat{padding:5px 9px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;background:var(--surface);color:var(--text);font-family:inherit}
.cm-app .id-pinterest-cat:focus{outline:none;border-color:var(--lb-danger)}

/* ── Ideation: category filter chips ── */
.cm-app .id-categories{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.cm-app .id-cat-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--border);border-radius:14px;font-size:11.5px;color:var(--text);background:var(--surface);cursor:pointer;font-weight:500;transition:transform .1s,box-shadow .15s,background .15s}
.cm-app .id-cat-chip:hover{transform:translateY(-1px);box-shadow:0 2px 6px rgba(15,23,42,.06)}
.cm-app .id-cat-chip.active{font-weight:600}
.cm-app .id-cat-chip-ct{padding:1px 6px;background:rgba(255,255,255,.45);border-radius:9px;font-size:10px;font-variant-numeric:tabular-nums;color:inherit}
.cm-app .id-cat-chip.active .id-cat-chip-ct{background:rgba(255,255,255,.25)}
.cm-app .id-cat-chip:not(.active) .id-cat-chip-ct{background:var(--surface-2);color:var(--muted)}
.cm-app .id-cat-clear{border-style:dashed;color:var(--muted)}

/* Card category badge */
.cm-app .id-card2-cat-badge{position:absolute;top:6px;left:6px;padding:2px 8px;background:#0f172a;color:#fff;border-radius:9px;font-size:10px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;line-height:1.4;pointer-events:none}

/* Product overlay (top-right of each card image) — color dots for each
   linked product, or an "All" pill when the idea applies to every product. */
.cm-app .id-card2-prod-badge{position:absolute;top:6px;right:6px;display:inline-flex;align-items:center;gap:4px;padding:3px 6px;background:rgba(15,23,42,0.78);border-radius:9999px;line-height:1;pointer-events:none}
.cm-app .id-card2-prod-dot{display:inline-block;width:8px;height:8px;border-radius:9999px;border:1px solid rgba(255,255,255,0.6)}
.cm-app .id-card2-prod-all{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#fff;padding:0 4px;line-height:1.4}
.cm-app .id-card2-prod-more{font-size:9.5px;font-weight:600;color:#fff;line-height:1.4}

/* Products row — pills above the upload zone for filtering + add product.
   Outer container stays a single flex row that wraps gracefully. Each
   editable product is wrapped in .id-product-pill-wrap; the wrap stays
   inline-flex with consistent gap (no negative margins, no overflow
   tricks) so the edit + delete buttons sit cleanly to the right of the
   pill on hover and never collide with the pill's count badge. */
.cm-app .id-products-row{
  display:flex;align-items:center;gap:10px;
  margin:14px 0 4px;flex-wrap:wrap;
  padding:12px 14px;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--lb-radius);
}
.cm-app .id-product-pill-wrap{
  display:inline-flex;align-items:center;gap:4px;
  /* No overflow:hidden — that was clipping the action buttons. */
}
.cm-app .id-product-pill{
  display:inline-flex;align-items:center;gap:8px;
  height:32px;padding:0 14px;
  border-radius:var(--lb-radius-pill);
  background:var(--surface-2);border:1px solid var(--border);
  color:var(--text);
  font-family:inherit;font-size:12.5px;font-weight:500;letter-spacing:-.005em;
  cursor:pointer;white-space:nowrap;
  transition:background 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.cm-app .id-product-pill:hover{background:var(--surface);border-color:var(--border-strong)}
.cm-app .id-product-pill[data-active="true"]{
  background:var(--pill-color, var(--accent));
  border-color:var(--pill-color, var(--accent));
  color:#fff;
  box-shadow:0 0 0 3px color-mix(in srgb, var(--pill-color, var(--accent)) 28%, transparent);
}
.cm-app .id-product-pill-dot{
  display:inline-block;width:8px;height:8px;border-radius:9999px;
  background:var(--pill-color, var(--accent));
  border:1px solid color-mix(in srgb, var(--pill-color, var(--accent)) 80%, transparent);
  flex-shrink:0;
}
.cm-app .id-product-pill[data-active="true"] .id-product-pill-dot{
  background:#fff;border-color:rgba(255,255,255,0.7);
}
.cm-app .id-product-pill-ct{
  padding:1px 7px;border-radius:9999px;
  background:rgba(0,0,0,0.10);
  font-size:11px;font-weight:600;color:var(--text-2);line-height:1.4;
  flex-shrink:0;
}
.cm-app .id-product-pill[data-active="true"] .id-product-pill-ct{
  background:rgba(255,255,255,0.22);color:#fff;
}
/* Edit / delete buttons: always visible so the row doesn't shift width
   on hover. Subtle by default (low-contrast border + muted icon),
   sharpen up on direct button hover. They sit to the right of the pill
   in the same flex row, separated by the wrap's gap. */
.cm-app .id-product-pill-acts{
  display:inline-flex;align-items:center;gap:2px;
}
.cm-app .id-product-pill-acts button{
  width:24px;height:24px;
  display:inline-flex;align-items:center;justify-content:center;
  background:transparent;border:1px solid var(--border);
  color:var(--text-3);
  font-size:10.5px;line-height:1;font-family:inherit;
  border-radius:9999px;cursor:pointer;flex-shrink:0;
  transition:background 160ms ease, border-color 160ms ease, color 160ms ease;
}
.cm-app .id-product-pill-acts button:hover{
  background:var(--surface-2);border-color:var(--border-strong);color:var(--text);
}
.cm-app .id-product-pill-acts button[title="Delete"]:hover{
  border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);
  color:var(--lb-danger);
  background:color-mix(in srgb, var(--lb-danger) 10%, transparent);
}
.cm-app .id-product-add{
  display:inline-flex;align-items:center;gap:4px;
  height:32px;padding:0 14px;
  border:1px dashed var(--border-strong);background:transparent;
  border-radius:var(--lb-radius-pill);
  color:var(--text-2);
  font-family:inherit;font-size:12.5px;font-weight:500;
  cursor:pointer;
  transition:border-color 160ms ease, color 160ms ease, background 160ms ease;
}
.cm-app .id-product-add:hover{
  border-color:var(--accent);color:var(--accent);
  background:color-mix(in srgb, var(--accent) 8%, transparent);
}
.cm-app .id-product-add:disabled{opacity:.5;cursor:not-allowed}

/* Drawer Products section — toggle + checkbox list. */
.cm-app .id-drawer-global-toggle{display:flex;align-items:flex-start;gap:10px;padding:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--lb-radius-sm);cursor:pointer;font-size:13px;color:var(--text)}
.cm-app .id-drawer-global-toggle input{margin-top:3px;flex-shrink:0;accent-color:var(--accent)}
.cm-app .id-drawer-global-hint{color:var(--text-2);font-weight:400}
.cm-app .id-drawer-products{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.cm-app .id-drawer-product-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--lb-radius-sm);font-size:13px;color:var(--text);cursor:pointer;transition:border-color 160ms ease, background 160ms ease}
.cm-app .id-drawer-product-row:hover{border-color:var(--border-strong)}
.cm-app .id-drawer-product-row[data-checked="true"]{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 8%, transparent)}
.cm-app .id-drawer-product-row input{accent-color:var(--accent);flex-shrink:0}
.cm-app .id-drawer-product-dot{display:inline-block;width:10px;height:10px;border-radius:9999px;border:1px solid var(--border-strong);flex-shrink:0}
.cm-app .id-drawer-product-name{font-weight:500;flex-shrink:0}
.cm-app .id-drawer-product-desc{font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cm-app .id-card2-image{position:relative}

/* Drawer category select */
.cm-app .id-drawer-cat-select{padding:7px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text);font-family:inherit;min-width:200px}
.cm-app .id-drawer-cat-select:focus{outline:none;border-color:var(--accent)}
.cm-app .id-drawer-cat-readonly{font-size:13px;color:var(--text)}

/* ── Ideation: drop zone ── */
.cm-app .id-drop{display:flex;align-items:center;justify-content:center;padding:18px 16px;margin:0 0 14px;border:1px dashed var(--border);border-radius:8px;background:var(--surface);color:var(--muted);font-size:12.5px;cursor:pointer;text-align:center;transition:border-color .15s,background .15s}
.cm-app .id-drop:hover,.cm-app .id-drop.drag{border-color:var(--accent);background:var(--accent-bg, #f8fafc);color:var(--text)}
.cm-app .id-drop strong{color:var(--text)}

/* ── Ideation: toolbar ── */
.cm-app .id-toolbar{display:flex;align-items:center;gap:10px;margin:0 0 14px}
.cm-app .id-search{flex:1;padding:8px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text);transition:border-color .15s}
.cm-app .id-search:focus{outline:none;border-color:var(--accent)}
.cm-app .id-toolbar-count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.cm-app .btn.id-delete-all{color:var(--lb-danger);border-color:var(--border)}
.cm-app .btn.id-delete-all:hover:not(:disabled){background:var(--danger-bg);border-color:color-mix(in srgb, var(--lb-danger) 40%, transparent);color:var(--lb-danger)}

/* ── Ideation: empty state ── */
.cm-app .id-empty{padding:24px 16px;text-align:center;color:var(--muted)}
.cm-app .id-empty p{margin:0;font-size:13px}

/* ── Ideation: card grid ── */
.cm-app .id-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:0}
.cm-app .id-card2{display:flex;flex-direction:column;padding:0;border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden;text-align:left;cursor:pointer;transition:border-color .15s,transform .1s,box-shadow .15s}
.cm-app .id-card2:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 6px 14px rgba(15,23,42,.08)}
.cm-app .id-card2:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cm-app .id-card2-image{width:100%;background:#0f172a;display:flex;align-items:center;justify-content:center;overflow:hidden;aspect-ratio:1/1}
.cm-app .id-card2-image img{width:100%;height:100%;object-fit:contain;display:block;transition:transform .25s}
.cm-app .id-card2:hover .id-card2-image img{transform:scale(1.03)}
.cm-app .id-card2-info{padding:10px 12px 12px;display:flex;flex-direction:column;gap:5px}
.cm-app .id-card2-title{font-size:12.5px;font-weight:600;color:var(--text);line-height:1.3}
.cm-app .id-card2-notes{margin:0;font-size:12px;color:var(--text-2);line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.cm-app .id-card2-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px}
.cm-app .id-card2-tag{display:inline-flex;align-items:center;padding:1px 7px;background:var(--accent-bg, #f1f5f9);border:1px solid var(--accent-border, var(--border));border-radius:9px;font-size:10.5px;color:var(--text-2);font-weight:500;line-height:1.4}
.cm-app .id-card2-tag-more{font-size:10.5px;color:var(--muted);padding:1px 7px}

/* ── Ideation drawer ── */
.cm-app .id-drawer-image{padding:0;background:#0f172a;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;max-height:60vh}
.cm-app .id-drawer-image img{max-width:100%;max-height:60vh;object-fit:contain;display:block}
.cm-app .id-drawer-notes{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text);font-family:inherit;line-height:1.5;resize:vertical;transition:border-color .15s}
.cm-app .id-drawer-notes:focus{outline:none;border-color:var(--accent)}
.cm-app .id-drawer-tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.cm-app .id-drawer-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:var(--accent-bg, #f1f5f9);border:1px solid var(--accent-border, var(--border));border-radius:11px;font-size:12px;color:var(--text);font-weight:500}
.cm-app .id-drawer-tag-rm{border:none;background:transparent;color:var(--muted);font-size:11px;cursor:pointer;padding:0;line-height:1}
.cm-app .id-drawer-tag-rm:hover{color:var(--lb-danger)}
.cm-app .id-drawer-tag-input{display:flex;gap:6px}
.cm-app .id-drawer-tag-input input{flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;background:var(--surface);color:var(--text)}
.cm-app .id-drawer-tag-input input:focus{outline:none;border-color:var(--accent)}

/* ── Summary view: all-products card grid ── */
.cm-app .sv-products{margin:0 0 24px}
.cm-app .sv-products-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.cm-app .sv-section-h{margin:0;font-size:13px;font-weight:600;color:var(--text);text-transform:uppercase;letter-spacing:.05em}
.cm-app .sv-products-count{font-size:11.5px;color:var(--muted)}
.cm-app .sv-product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.cm-app .sv-product-card{display:flex;flex-direction:column;gap:0;padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface);text-align:left;cursor:pointer;transition:border-color .15s,transform .1s,box-shadow .15s}
.cm-app .sv-product-card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 10px rgba(15,23,42,.06)}
.cm-app .sv-product-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cm-app .sv-product-thumb{width:100%;aspect-ratio:4/3;background:#0f172a;display:flex;align-items:center;justify-content:center;overflow:hidden}
.cm-app .sv-product-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cm-app .sv-product-thumb-empty{font-size:28px;opacity:.5}
.cm-app .sv-product-info{padding:10px 12px;display:flex;flex-direction:column;gap:3px}
.cm-app .sv-product-brand{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.cm-app .sv-product-name{font-size:13px;font-weight:600;color:var(--text);line-height:1.3}
.cm-app .sv-product-code{font-size:11px;color:var(--muted)}
.cm-app .sv-product-key{display:flex;flex-direction:column;gap:2px;margin-top:4px}
.cm-app .sv-product-key-row{font-size:11.5px;color:var(--text)}
.cm-app .sv-product-key-row strong{color:var(--muted);font-weight:600;margin-right:3px}
.cm-app .sv-product-counts{display:inline-flex;gap:4px;margin-top:6px}
.cm-app .sv-product-count{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;background:var(--surface-2);color:var(--text-2);border-radius:9px;font-size:10.5px;font-weight:600}
`;
