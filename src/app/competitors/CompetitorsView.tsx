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
} from "@/db/schema";

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

export default function CompetitorsView({
  collections,
  brands,
  canEdit,
}: {
  collections: CompetitorCollection[];
  brands: FullCompetitor[];
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

  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set());
  const [capFilter, setCapFilter] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<"none" | "tier" | "segment" | "capability" | "country">("tier");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<"new" | "edit" | false>(false);
  const [draft, setDraft] = useState<CompetitorInput | null>(null);
  const [collMenuOpen, setCollMenuOpen] = useState(false);

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
          <span className="brand-sub">Competitor Tracker</span>

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
          <div className="search-wrap">
            <span className="search-ico">🔎</span>
            <input className="search" placeholder="Search this collection…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {canEdit && <button className="btn primary" onClick={startNew}>+ Add competitor</button>}
        </header>

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

        {toastMsg && <div className={`toast show ${toastMsg.err ? "error" : ""}`}>{toastMsg.msg}</div>}
      </div>
    </>
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
        {brand.products.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)", padding: "10px 0" }}>
            {canEdit
              ? "No products yet. Use the AI panel in Edit to extract products from a website or PDF catalog."
              : "No products yet."}
          </div>
        ) : (
          <div className="products-grid">
            {brand.products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                canEdit={canEdit}
                onDelete={() => onDeleteProduct(p.id)}
                onUploadFiles={(files) => onUploadProductFile(p.id, files)}
              />
            ))}
          </div>
        )}
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
  --bg:#f7f7f8;--surface:#ffffff;--surface-2:#fbfbfc;
  --border:#e8e9ec;--border-strong:#d1d5db;
  --text:#111827;--text-2:#4b5563;--muted:#9ca3af;--dim:#cbd0d8;
  --accent:#b45309;--accent-strong:#92400e;--accent-bg:#fef9ec;--accent-border:#fde2a3;
  --t-mass:#4f46e5;--t-mass-bg:#eef2ff;
  --t-mid:#0891b2;--t-mid-bg:#ecfeff;
  --t-spec:#7c3aed;--t-spec-bg:#f5f3ff;
  --t-premium:#b45309;--t-premium-bg:#fef9ec;
  --ok:#059669;--danger:#dc2626;--danger-bg:#fef2f2;
  display:grid;grid-template-rows:56px 1fr;height:calc(100vh - 65px);
  background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;
  overflow:hidden;
}
.cm-app *,.cm-app *::before,.cm-app *::after{box-sizing:border-box}
.cm-app input,.cm-app select,.cm-app textarea{font-family:inherit;color:var(--text)}
.cm-app a{color:var(--accent);text-decoration:none}
.cm-app a:hover{text-decoration:underline}
.cm-app header.bar{display:flex;align-items:center;gap:14px;padding:0 18px;background:var(--surface);border-bottom:1px solid var(--border);position:relative}
.cm-app .brand-mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#fbbf24,#b45309);display:inline-block;position:relative;flex:none}
.cm-app .brand-mark::after{content:"";position:absolute;left:5px;right:5px;top:9px;bottom:9px;background:#fff;border-radius:1px;opacity:.85}
.cm-app .coll-picker{display:inline-flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:13px;font-weight:600;color:var(--text);cursor:pointer;font-family:inherit}
.cm-app .coll-picker:hover{background:#fff;border-color:var(--border-strong)}
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
.cm-app .search:focus{outline:none;border-color:var(--accent);background:#fff}
.cm-app .btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.cm-app .btn:hover{background:var(--surface-2);border-color:var(--border-strong)}
.cm-app .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.cm-app .btn.primary:hover{background:var(--accent-strong);border-color:var(--accent-strong)}
.cm-app .btn.danger{color:var(--danger);border-color:var(--border)}
.cm-app .btn.danger:hover{background:var(--danger-bg);border-color:#fecaca}
.cm-app .btn.ghost{background:transparent;border-color:transparent}
.cm-app .btn.ghost:hover{background:var(--surface-2);border-color:var(--border)}
.cm-app .btn.sm{padding:5px 9px;font-size:12px}
.cm-app .btn:disabled{opacity:.5;cursor:not-allowed}
.cm-app .coll-menu{position:absolute;top:48px;left:18px;z-index:80;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 25px rgba(17,24,39,.10),0 4px 6px rgba(17,24,39,.04);min-width:280px;max-width:340px;padding:6px}
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
.cm-app .layout{display:grid;grid-template-columns:380px 1fr;height:calc(100vh - 65px - 56px);min-height:0}
.cm-app aside.sidebar{display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--surface);min-height:0}
.cm-app .sidebar-tools{padding:12px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.cm-app .row{display:flex;gap:6px;align-items:center}
.cm-app .row label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;flex:none}
.cm-app .selectish{flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:#fff;font-size:12px}
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
.cm-app .att-btn.danger:hover{background:var(--danger-bg);border-color:#fecaca}
.cm-app .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.cm-app .form-grid .full{grid-column:span 2}
.cm-app .field{display:flex;flex-direction:column;gap:5px}
.cm-app .field label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.cm-app .field input,.cm-app .field select,.cm-app .field textarea{padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:#fff;font-size:13.5px;color:var(--text);width:100%;font-family:inherit}
.cm-app .field input:focus,.cm-app .field select:focus,.cm-app .field textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.cm-app .field textarea{min-height:80px;resize:vertical;line-height:1.5}
.cm-app .cap-picker{display:flex;flex-wrap:wrap;gap:6px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);max-height:180px;overflow-y:auto}
.cm-app .form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)}
.cm-app .strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:18px}
.cm-app .strip-cell{background:#fff;padding:11px 14px}
.cm-app .strip-cell .lbl{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.cm-app .strip-cell .val{font-size:18px;font-weight:600;letter-spacing:-.01em;margin-top:2px}
.cm-app .strip-cell .sub{font-size:11px;color:var(--muted);margin-top:1px}
.cm-app .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;box-shadow:0 10px 25px rgba(17,24,39,.10);z-index:200}
.cm-app .toast.error{background:var(--danger)}
.cm-app .ai-card{background:linear-gradient(135deg,var(--accent-bg),#fff);border:1px solid var(--accent-border)}
.cm-app .ai-card h4{color:var(--accent-strong);display:flex;align-items:center;gap:6px}
.cm-app .ai-badge{background:linear-gradient(135deg,#b45309,#92400e);color:#fff;font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:10px;text-transform:uppercase}
.cm-app .ai-body{display:flex;flex-direction:column;gap:8px}
.cm-app .ai-body .field-input,.cm-app .ai-body input[type=text],.cm-app .ai-body input:not([type=file]){padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:#fff;font-size:13.5px;color:var(--text);width:100%;font-family:inherit}
.cm-app .ai-body input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.cm-app .ai-drop{display:block;padding:14px;border:1.5px dashed var(--border-strong);border-radius:8px;text-align:center;font-size:12.5px;color:var(--muted);cursor:pointer;background:#fff;transition:all .15s}
.cm-app .ai-drop:hover{border-color:var(--accent);color:var(--accent-strong);background:var(--accent-bg)}
.cm-app .ai-file-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.cm-app .ai-file-list li{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#fff;border:1px solid var(--border);border-radius:5px;font-size:12.5px;color:var(--text-2)}
.cm-app .ai-rm{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 4px;font-family:inherit}
.cm-app .ai-rm:hover{color:var(--danger)}
.cm-app .ai-card .btn{align-self:flex-start}
.cm-app .ai-revert-banner{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(135deg,#fff8e6,#fef6d4);border:1px solid #f0d896;border-radius:8px;margin-bottom:14px;font-size:12.5px;color:#8a6500;font-weight:500}
.cm-app .products-grid{display:flex;flex-direction:column;gap:8px}
.cm-app .product-card{border:1px solid var(--border);border-radius:10px;background:#fff;overflow:hidden;transition:border-color .15s}
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
.cm-app .product-card-body{padding:0 14px 14px;border-top:1px solid var(--border);background:linear-gradient(180deg,var(--surface-2),#fff)}
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
`;
