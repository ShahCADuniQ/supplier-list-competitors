"use client";

// Right-side detail drawer for a single inventory item. Surfaces
// everything we know — metadata, configurations, supplier links,
// parents, children, attachments — with an upload widget that talks
// to /api/blob/upload for STEP / drawing / image / doc files plus a
// "Paste a link" form for external URLs (vendor pages, BOM links).
//
// Click any child or parent inside the drawer to navigate the drawer
// itself to that item (push onto a navigation stack with a Back
// button). The DatabaseTab card grid behind the drawer is unchanged.

import { useEffect, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addAssemblyChildAction,
  addInventoryAttachmentAction,
  getAssemblyTree,
  getInventoryDetails,
  linkInventoryToSupplierAction,
  linkSupplierProductToInventoryAction,
  listConfigurationOptionsAction,
  listSupplierCatalogueProductsAction,
  listSupplierOptions,
  removeInventoryAttachmentAction,
  setInventoryConfigurationsAction,
  setInventoryStarredAction,
  unlinkSupplierProductFromInventoryAction,
  type AssemblyTreeNode,
  type Configuration,
  type ConfigurationOption,
  type DrawerAttachment,
  type DrawerChild,
  type DrawerParent,
  type DrawerSupplierLink,
  type InventoryDetails,
  type SupplierCatalogueOption,
  type SupplierOption,
} from "./actions";
import {
  archiveInventoryItem,
  getInventoryItemHistory,
  updateInventoryItem,
  type InventoryItemHistory,
} from "@/app/suppliers/inventory-actions";

// Local copy of the multi-id parser. Mirrors the one in
// NomenclatureGenerator.tsx; both files are client components and
// keeping them independent avoids a circular cross-file import.
function parseDraggedItemIdsLocal(dt: DataTransfer): number[] {
  const out = new Set<number>();
  const multi = dt.getData("application/x-lb-inventory-items");
  if (multi) {
    try {
      const parsed = JSON.parse(multi);
      if (Array.isArray(parsed)) {
        for (const v of parsed) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) out.add(n);
        }
      }
    } catch {}
  }
  if (out.size === 0) {
    const single = dt.getData("application/x-lb-inventory-item");
    const n = Number(single);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return Array.from(out);
}

const KINDS: Array<{
  value: DrawerAttachment["kind"];
  label: string;
  hint: string;
}> = [
  { value: "cad", label: "CAD", hint: "STEP, IGES, SLDPRT, IPT, …" },
  { value: "drawing", label: "Drawing", hint: "PDF / DWG / DXF" },
  { value: "image", label: "Image", hint: "PNG / JPG / WebP" },
  { value: "doc", label: "Document", hint: "Datasheet, cert, spec" },
  { value: "link", label: "Link", hint: "External URL" },
];

const KIND_ICON: Record<DrawerAttachment["kind"], string> = {
  cad: "🧊",
  drawing: "📐",
  image: "🖼️",
  doc: "📄",
  link: "🔗",
};

function bytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function InventoryDrawer({
  inventoryItemId,
  onClose,
}: {
  inventoryItemId: number;
  onClose: () => void;
}) {
  // Navigation stack — push when the user clicks a child/parent inside
  // the drawer, pop on Back.
  const [stack, setStack] = useState<number[]>([inventoryItemId]);
  const currentId = stack[stack.length - 1];

  const [details, setDetails] = useState<InventoryDetails | null>(null);
  // The supplier-side history (physical props, RFQs, POs, qty stats,
  // notes, category, unit, thumbnail). Loaded in parallel and treated
  // as optional — non-supplier viewers just see the nomenclature view.
  const [history, setHistory] = useState<InventoryItemHistory | null>(null);
  // Full assembly tree, fetched on demand when the user opens the
  // Tree tab. Cached per currentId so re-clicking the tab is cheap.
  const [tree, setTree] = useState<AssemblyTreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "tree">("details");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Global configuration catalogue — fetched once per drawer mount
  // and re-fetched whenever the user saves a fresh config so the
  // typeahead picks up brand-new names without a full page reload.
  const [configOptions, setConfigOptions] = useState<ConfigurationOption[]>([]);

  async function loadOptions() {
    try {
      const opts = await listConfigurationOptionsAction();
      setConfigOptions(opts);
    } catch {
      // Non-fatal — datalist will just be empty.
    }
  }

  async function load() {
    setLoading(true);
    setErr(null);
    // Fetch both views in parallel. History is optional — if the
    // viewer doesn't have supplier-tab access, the history call
    // throws and we just render the nomenclature view alone.
    const [detailsP, historyP] = await Promise.allSettled([
      getInventoryDetails({ inventoryItemId: currentId }),
      getInventoryItemHistory(currentId),
    ]);
    if (detailsP.status === "fulfilled") {
      setDetails(detailsP.value);
    } else {
      setErr(
        detailsP.reason instanceof Error
          ? detailsP.reason.message
          : "Could not load details",
      );
    }
    if (historyP.status === "fulfilled") {
      setHistory(historyP.value);
    } else {
      setHistory(null);
    }
    setLoading(false);
  }

  // Lazy-load the assembly tree the first time the user opens the
  // Tree tab. Re-loaded when the drawer navigates to a different
  // item (currentId changes).
  useEffect(() => {
    if (activeTab !== "tree") return;
    let cancelled = false;
    setTreeLoading(true);
    getAssemblyTree({ inventoryItemId: currentId })
      .then((t) => {
        if (!cancelled) setTree(t);
      })
      .catch(() => {
        if (!cancelled) setTree(null);
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, currentId]);

  // Reset the tab to Details whenever the drawer navigates to a
  // different item (so drilling into a child opens fresh on Details).
  useEffect(() => {
    setActiveTab("details");
    setTree(null);
  }, [currentId]);

  useEffect(() => {
    load();
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function navigateTo(id: number) {
    if (id === currentId) return;
    setStack((s) => [...s, id]);
  }
  function back() {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }

  // Add the dragged item as a child of the current item.
  async function addAsChild(draggedItemId: number) {
    if (draggedItemId === currentId) return;
    try {
      await addAssemblyChildAction({
        parentInventoryItemId: currentId,
        childInventoryItemId: draggedItemId,
        quantity: 1,
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    }
  }

  // Add the current item as a child of the dragged item (i.e. the
  // dragged item becomes a parent of this one).
  async function addAsParent(draggedItemId: number) {
    if (draggedItemId === currentId) return;
    try {
      await addAssemblyChildAction({
        parentInventoryItemId: draggedItemId,
        childInventoryItemId: currentId,
        quantity: 1,
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    }
  }

  return (
    <>
      {/* Scrim — clickable to close, but pointer-events:none on drag
          events so a card BEHIND the drawer (the database list) can
          still be dragged into the drawer's drop zones. The scrim
          still dims background visually. Close via the X button or
          the Esc key when a drag is in progress. */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.18)",
          zIndex: 49,
          animation: "lb-fade-in 160ms ease",
          // The trick: ignore drag-related pointer events so the
          // source card behind us can fire dragstart, and our drop
          // targets above receive dragenter/drop. Clicks still hit
          // the scrim because they go through onClick.
          pointerEvents: "auto",
        }}
        onDragEnter={(e) => {
          // Forward the event so the underlying card is treated as
          // the drag source — without this the browser may swallow
          // dragenter on the scrim itself and we lose the drop.
          e.preventDefault();
        }}
        onDragOver={(e) => {
          // Same — allow drag traversal across the scrim.
          e.preventDefault();
        }}
        aria-hidden
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Inventory item details"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(720px, 100vw)",
          background: "var(--lb-bg)",
          color: "var(--lb-text)",
          boxShadow: "-20px 0 48px -16px rgba(0,0,0,0.30)",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          animation: "lb-slide-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      >
        <style>{`
          @keyframes lb-fade-in { from { opacity: 0 } to { opacity: 1 } }
          @keyframes lb-slide-in {
            from { transform: translateX(40px); opacity: 0 }
            to { transform: translateX(0); opacity: 1 }
          }
        `}</style>

        {/* Header */}
        <header
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--lb-border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {stack.length > 1 && (
            <button
              type="button"
              onClick={back}
              style={{
                background: "transparent",
                border: "1px solid var(--lb-border)",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
                padding: "5px 10px",
                cursor: "pointer",
                color: "var(--lb-text-2)",
              }}
            >
              ← Back
            </button>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            {details && (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontSize: 18 }}>
                    {details.kind === "assembly" ? "🧩" : "🔧"}
                  </span>
                  <code
                    style={{
                      fontSize: 14,
                      fontWeight: 800,
                      wordBreak: "break-all",
                    }}
                  >
                    {details.code}
                  </code>
                  <DrawerStarToggle
                    inventoryItemId={details.inventoryItemId}
                    starred={details.starred}
                    onChanged={(next) =>
                      setDetails((d) => (d ? { ...d, starred: next } : d))
                    }
                  />
                  {details.products.map((label) => (
                    <span
                      key={label}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        background:
                          "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
                        color: "var(--lb-accent)",
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                      }}
                    >
                      {label}
                    </span>
                  ))}
                  {details.maxBuildable != null && (
                    <span
                      style={{
                        padding: "2px 10px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background:
                          details.maxBuildable > 0
                            ? "rgba(16,185,129,0.14)"
                            : "rgba(239,68,68,0.12)",
                        color:
                          details.maxBuildable > 0 ? "#10b981" : "#dc2626",
                      }}
                    >
                      Can build {details.maxBuildable}
                    </span>
                  )}
                </div>
                {details.name && (
                  <div style={{ fontSize: 13, marginTop: 4, fontWeight: 600 }}>
                    {details.name}
                  </div>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 22,
              color: "var(--lb-text-3)",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </header>

        {/* Tabs */}
        {details && (
          <div
            style={{
              display: "flex",
              gap: 0,
              padding: "0 20px",
              borderBottom: "1px solid var(--lb-border)",
              background: "var(--lb-bg)",
            }}
          >
            <TabButton
              active={activeTab === "details"}
              onClick={() => setActiveTab("details")}
              label="Details"
              hint={
                history
                  ? "Overview · physical · history · attachments"
                  : "Overview · configurations · attachments"
              }
            />
            <TabButton
              active={activeTab === "tree"}
              onClick={() => setActiveTab("tree")}
              label="Tree"
              hint={
                details.kind === "assembly"
                  ? "Full BOM structure of this assembly"
                  : "Parents — which assemblies use this part"
              }
            />
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {loading && (
            <div style={{ fontSize: 13, color: "var(--lb-text-3)" }}>
              Loading…
            </div>
          )}
          {err && (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                background: "rgba(239,68,68,0.08)",
                color: "#dc2626",
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}
          {details && activeTab === "details" && (
            <Body
              details={details}
              history={history}
              configOptions={configOptions}
              onMutated={() => {
                load();
                loadOptions();
              }}
              onNavigateTo={navigateTo}
              onDropAsChild={addAsChild}
              onDropAsParent={addAsParent}
            />
          )}
          {details && activeTab === "tree" && (
            <TreeTab
              rootId={currentId}
              rootKind={details.kind}
              tree={tree}
              loading={treeLoading}
              parents={details.parents}
              onNavigateTo={navigateTo}
            />
          )}
        </div>
      </aside>
    </>
  );
}

// Single tab button inside the Details/Tree tab bar. Underline-active
// style so the panel feels native to the rest of the right-rail
// drawers in this app.
function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      style={{
        appearance: "none",
        background: "transparent",
        border: "none",
        borderBottom: active
          ? "2px solid var(--lb-accent)"
          : "2px solid transparent",
        padding: "10px 14px",
        marginBottom: -1,
        fontSize: 13,
        fontWeight: active ? 800 : 600,
        color: active ? "var(--lb-text)" : "var(--lb-text-3)",
        cursor: "pointer",
        letterSpacing: 0.2,
      }}
    >
      {label}
    </button>
  );
}

// Render the full assembly BOM tree for an assembly, or the "used in"
// parent list for a part. Viewer-only — clicking any node navigates
// the drawer to that item so the user can drill anywhere from here.
function TreeTab({
  rootId,
  rootKind,
  tree,
  loading,
  parents,
  onNavigateTo,
}: {
  rootId: number;
  rootKind: "part" | "assembly";
  tree: AssemblyTreeNode | null;
  loading: boolean;
  parents: DrawerParent[];
  onNavigateTo: (id: number) => void;
}) {
  if (loading) {
    return (
      <div style={{ fontSize: 13, color: "var(--lb-text-3)" }}>
        Loading tree…
      </div>
    );
  }
  // Parts don't have a downward tree — show the upward "used in" view
  // instead so the Tree tab is still useful for a part row.
  if (rootKind === "part") {
    if (parents.length === 0) {
      return (
        <div
          style={{
            padding: 16,
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            color: "var(--lb-text-3)",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          This part isn&apos;t used in any assembly yet.
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          Used in {parents.length} assembly{parents.length === 1 ? "" : "s"}
        </div>
        {parents.map((p) => (
          <button
            key={p.inventoryItemId}
            type="button"
            onClick={() => onNavigateTo(p.inventoryItemId)}
            style={{
              textAlign: "left",
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--lb-border)",
              background: "var(--lb-bg-elev)",
              color: "var(--lb-text)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <code style={{ fontSize: 12, fontWeight: 800 }}>{p.code}</code>
            {p.name && (
              <span style={{ fontSize: 12, color: "var(--lb-text-2)" }}>
                {p.name}
              </span>
            )}
            <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
              × {p.quantity} per parent
            </span>
          </button>
        ))}
      </div>
    );
  }
  if (!tree) {
    return (
      <div
        style={{
          padding: 16,
          borderRadius: 10,
          border: "1px dashed var(--lb-border)",
          color: "var(--lb-text-3)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        Tree unavailable for this assembly.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        BOM tree for {tree.code}
      </div>
      <TreeRow node={tree} depth={0} rootId={rootId} onNavigateTo={onNavigateTo} />
    </div>
  );
}

// Recursive row in the Tree tab. Depth controls indent + a left-rail
// guide so deep BOMs stay readable. No drag/drop — this is a viewer.
function TreeRow({
  node,
  depth,
  rootId,
  onNavigateTo,
}: {
  node: AssemblyTreeNode;
  depth: number;
  rootId: number;
  onNavigateTo: (id: number) => void;
}) {
  const isRoot = node.itemId === rootId;
  return (
    <div
      style={{
        marginLeft: depth === 0 ? 0 : 18,
        borderLeft:
          depth === 0 ? "none" : "1px solid var(--lb-border)",
        paddingLeft: depth === 0 ? 0 : 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <button
        type="button"
        onClick={() => !isRoot && onNavigateTo(node.itemId)}
        disabled={isRoot}
        style={{
          textAlign: "left",
          padding: "8px 10px",
          borderRadius: 8,
          border: isRoot
            ? "1px solid var(--lb-accent)"
            : "1px solid var(--lb-border)",
          background: isRoot
            ? "color-mix(in srgb, var(--lb-accent) 8%, var(--lb-bg))"
            : "var(--lb-bg-elev)",
          color: "var(--lb-text)",
          cursor: isRoot ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
        }}
      >
        <span style={{ fontSize: 14 }}>
          {node.kind === "assembly" ? "🧩" : "🔧"}
        </span>
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <code
            style={{
              fontSize: 11.5,
              fontWeight: 800,
              wordBreak: "break-all",
            }}
          >
            {node.code}
          </code>
          {node.name && (
            <span style={{ fontSize: 11, color: "var(--lb-text-2)" }}>
              {node.name}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {node.isConfiguration && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                padding: "1px 6px",
                borderRadius: 999,
                background: "color-mix(in srgb, var(--lb-accent) 16%, transparent)",
                color: "var(--lb-accent)",
              }}
            >
              CFG
            </span>
          )}
          {!isRoot && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "1px 7px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text-2)",
                whiteSpace: "nowrap",
              }}
            >
              × {node.quantity}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              color: "var(--lb-text-3)",
              whiteSpace: "nowrap",
            }}
          >
            stock {node.stock}
          </span>
        </div>
      </button>
      {node.children.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {node.children.map((c) => (
            <TreeRow
              key={c.itemId}
              node={c}
              depth={depth + 1}
              rootId={rootId}
              onNavigateTo={onNavigateTo}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Star control rendered inline in the drawer header. Same semantics
// as the Database tab card button — flips inventory_items.starred so
// the row appears (or stops appearing) in the Lightbase Inventory tab
// over in /suppliers. Optimistic flip; rolls back on error.
function DrawerStarToggle({
  inventoryItemId,
  starred,
  onChanged,
}: {
  inventoryItemId: number;
  starred: boolean;
  onChanged: (next: boolean) => void;
}) {
  const [pending, start] = useTransition();
  function toggle() {
    const next = !starred;
    onChanged(next);
    start(async () => {
      try {
        await setInventoryStarredAction({ inventoryItemId, starred: next });
      } catch (e) {
        onChanged(starred);
        alert(e instanceof Error ? e.message : "Star toggle failed");
      }
    });
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={
        starred
          ? "Starred — shown in Lightbase Inventory. Click to unstar."
          : "Not starred — hidden from Lightbase Inventory. Click to star."
      }
      style={{
        appearance: "none",
        border: "1px solid",
        borderColor: starred
          ? "color-mix(in srgb, #d97706 40%, var(--lb-border))"
          : "var(--lb-border)",
        background: starred
          ? "color-mix(in srgb, #d97706 8%, transparent)"
          : "transparent",
        color: starred ? "#d97706" : "var(--lb-text-3)",
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 700,
        padding: "2px 8px",
        cursor: pending ? "default" : "pointer",
        opacity: pending ? 0.6 : 1,
        lineHeight: 1.2,
      }}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}

function Body({
  details,
  history,
  configOptions,
  onMutated,
  onNavigateTo,
  onDropAsChild,
  onDropAsParent,
}: {
  details: InventoryDetails;
  history: InventoryItemHistory | null;
  configOptions: ConfigurationOption[];
  onMutated: () => void;
  onNavigateTo: (id: number) => void;
  onDropAsChild: (draggedItemId: number) => void;
  onDropAsParent: (draggedItemId: number) => void;
}) {
  const item = history?.item;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Editable basics (name / category / description / notes) +
          archive action. Only visible when the viewer can read the
          supplier-side history (i.e. has supplier access). */}
      {item && (
        <PartDetailsEditor item={item} onMutated={onMutated} />
      )}

      {/* Description + meta */}
      <Section title="Overview">
        {details.description ? (
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
            {details.description}
          </p>
        ) : (
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              color: "var(--lb-text-3)",
              fontStyle: "italic",
            }}
          >
            No description yet — add one from the Edit dialog in the
            Database tab.
          </p>
        )}
        <div
          style={{
            marginTop: 10,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          <Meta
            label="Kind"
            value={
              details.partOrAssembly === "A"
                ? "Assembly"
                : details.partOrAssembly === "P"
                  ? "Part / Configuration"
                  : details.kind
            }
          />
          {details.uniqueId && <Meta label="Unique ID" value={details.uniqueId} />}
          {details.classCode && (
            <Meta label="Class" value={details.classCode} />
          )}
          {details.standardName && (
            <Meta label="Standard" value={details.standardName} />
          )}
        </div>
      </Section>

      <ConfigurationsSection
        inventoryItemId={details.inventoryItemId}
        initialConfigurations={details.configurations}
        configOptions={configOptions}
        onMutated={onMutated}
      />

      <AttachmentsSection
        inventoryItemId={details.inventoryItemId}
        attachments={details.attachments}
        onMutated={onMutated}
      />

      {/* Physical properties + qty status, hoisted above the BOM drop
          zones so the most-referenced numeric facts are visible without
          scrolling past the tree. */}
      {item && (
        <Section title="Physical properties (from IFC)">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 8,
            }}
          >
            <PhysStat label="Weight" value={item.weightG != null ? `${Number(item.weightG).toFixed(2)} g` : "—"} />
            <PhysStat label="Surface area" value={item.surfaceAreaMm2 != null ? `${Number(item.surfaceAreaMm2).toFixed(2)} mm²` : "—"} />
            <PhysStat label="Volume" value={item.volumeMm3 != null ? `${Number(item.volumeMm3).toFixed(2)} mm³` : "—"} />
            <PhysStat label="Material" value={item.material ?? "—"} />
            <PhysStat label="Density" value={item.densityGCm3 != null ? `${Number(item.densityGCm3).toFixed(3)} g/cm³` : "—"} />
          </div>
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(202,138,4,0.08)",
              border: "1px solid rgba(202,138,4,0.35)",
              fontSize: 12,
            }}
          >
            <strong style={{ color: "#ca8a04" }}>{item.pendingQty}</strong>
            <span style={{ color: "var(--lb-text-2)" }}> on standby</span>
            <span style={{ color: "var(--lb-text-3)" }}> · </span>
            <strong style={{ color: "#16a34a" }}>{item.confirmedQty}</strong>
            <span style={{ color: "var(--lb-text-2)" }}> confirmed</span>
            <div style={{ fontSize: 10.5, color: "var(--lb-text-3)", marginTop: 4 }}>
              Standby = total qty requested via open RFQs / quotes.
              Confirmed = total qty on POs that have been sent.
            </div>
          </div>
          {item.ifcSourceUrl && (
            <div style={{ marginTop: 8, fontSize: 11.5 }}>
              <a
                href={item.ifcSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--lb-accent)" }}
              >
                📐 Download source IFC{item.ifcSourceName ? ` · ${item.ifcSourceName}` : ""}
              </a>
            </div>
          )}
        </Section>
      )}

      <DropZoneSection
        title={`Direct children (${details.children.length})`}
        tone="child"
        emptyHint={`Drag any card from the database list here and drop — it becomes a child of ${details.code}.`}
        items={details.children}
        onNavigateTo={onNavigateTo}
        onDrop={onDropAsChild}
        currentItemId={details.inventoryItemId}
      />

      <DropZoneSection
        title={`Used in (${details.parents.length})`}
        tone="parent"
        emptyHint={`Drag a card here — that card becomes a parent assembly, and ${details.code} becomes its child.`}
        items={details.parents.map((p) => ({
          inventoryItemId: p.inventoryItemId,
          code: p.code,
          name: p.name,
          kind: "assembly" as const,
          quantity: p.quantity,
          stock: 0,
        }))}
        onNavigateTo={onNavigateTo}
        onDrop={onDropAsParent}
        currentItemId={details.inventoryItemId}
      />

      <SupplierLinkSection
        inventoryItemId={details.inventoryItemId}
        links={details.supplierLinks}
        onMutated={onMutated}
      />

      {history && history.rfqs.length > 0 && (
        <Section
          title={`Quote history (${history.rfqs.reduce((n, r) => n + r.quoteLines.length, 0)})`}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {history.rfqs.map(({ rfq, line, quoteLines }) => (
              <li
                key={rfq.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <a
                    href={`/suppliers/rfq/${rfq.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--lb-accent)", textDecoration: "none", fontWeight: 700, fontSize: 13 }}
                  >
                    {rfq.rfqNumber}
                  </a>
                  <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
                    · {rfq.projectName ?? rfq.projectNum}
                    · qty {line.qty}
                    {line.securityStock > 0 ? ` (+${line.securityStock} sec)` : ""}
                    · {new Date(rfq.createdAt).toLocaleDateString()}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10.5,
                      padding: "2px 8px",
                      borderRadius: 5,
                      background: `${rfqStatusColor(rfq.status)}22`,
                      color: rfqStatusColor(rfq.status),
                      fontWeight: 800,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                    }}
                  >
                    {rfq.status}
                  </span>
                </div>
                {quoteLines.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 6 }}>
                    No quotes received yet.
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
                    <thead>
                      <tr style={{ color: "var(--lb-text-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>Supplier</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>Unit price</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>MOQ</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>Lead</th>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quoteLines.map(({ quote, line: ql, supplierName }) => (
                        <tr key={ql.id} style={{ borderTop: "1px solid var(--lb-border)" }}>
                          <td style={{ padding: "4px 6px", color: "var(--lb-text)" }}>{supplierName}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {fmtMoney(Number(ql.unitPrice), quote.currency)}
                          </td>
                          <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--lb-text-3)" }}>{ql.moq ?? "—"}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--lb-text-3)" }}>
                            {ql.leadTimeDays != null ? `${ql.leadTimeDays}d` : "—"}
                          </td>
                          <td style={{ padding: "4px 6px", color: "var(--lb-text-2)" }}>{quote.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {history && history.pos.length > 0 && (
        <Section title={`PO history (${history.pos.length})`}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {history.pos.map(({ po, line }) => (
              <li
                key={po.id}
                style={{
                  padding: 8,
                  borderRadius: 6,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <a
                  href={`/suppliers/po/${po.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--lb-accent)", textDecoration: "none", fontWeight: 700, fontSize: 13 }}
                >
                  {po.poNumber}
                </a>
                <span style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
                  → {po.supplierName} · qty {line.qty} @ {fmtMoney(Number(line.unitPrice), po.currency)}
                  · {new Date(po.createdAt).toLocaleDateString()}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "var(--lb-text)" }}>
                  {fmtMoney(Number(line.totalPrice), po.currency)}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--lb-text-3)", textTransform: "uppercase" }}>
                  {po.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// Inline editor for the supplier-side basics: name, category, unit,
// description, notes. Also exposes the Archive button. Tucked at the
// top of the Details tab so users coming from the Lightbase Inventory
// table get the same edit affordances they had in the old drawer.
function PartDetailsEditor({
  item,
  onMutated,
}: {
  item: InventoryItemHistory["item"];
  onMutated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name ?? "");
  const [category, setCategory] = useState(item.category ?? "");
  const [unit, setUnit] = useState(item.unit ?? "ea");
  const [description, setDescription] = useState(item.description ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Re-sync drafts when the drawer navigates to a different item.
  useEffect(() => {
    setName(item.name ?? "");
    setCategory(item.category ?? "");
    setUnit(item.unit ?? "ea");
    setDescription(item.description ?? "");
    setNotes(item.notes ?? "");
    setEditing(false);
  }, [item.id, item.name, item.category, item.unit, item.description, item.notes]);

  function save() {
    setErr(null);
    start(async () => {
      try {
        await updateInventoryItem({
          itemId: item.id,
          name,
          category,
          unit,
          description,
          notes,
        });
        setEditing(false);
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function archive() {
    if (
      !confirm(
        "Archive this item? The Lightbase Ref. stays bound to existing RFQs / POs, but it stops showing in the inventory list.",
      )
    ) {
      return;
    }
    setErr(null);
    start(async () => {
      try {
        await archiveInventoryItem({ itemId: item.id, archived: true });
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Archive failed");
      }
    });
  }

  return (
    <section
      style={{
        padding: 12,
        borderRadius: 12,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg-elev)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          Part details
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          {editing ? (
            <>
              <button type="button" onClick={save} disabled={busy} style={editorBtn("#16a34a")}>
                ✓ Save
              </button>
              <button type="button" onClick={() => setEditing(false)} style={editorBtn("#475569")}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)} style={editorBtn("#7c3aed")}>
                ✎ Edit
              </button>
              <button type="button" onClick={archive} disabled={busy} style={editorBtn("#dc2626")}>
                Archive
              </button>
            </>
          )}
        </div>
      </div>
      {err && (
        <div style={{ padding: 8, borderRadius: 8, background: "rgba(220,38,38,0.12)", color: "#fca5a5", fontSize: 12.5 }}>
          {err}
        </div>
      )}
      {editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <EditorField label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} style={editorInput} />
          </EditorField>
          <EditorField label="Category">
            <input value={category} onChange={(e) => setCategory(e.target.value)} style={editorInput} />
          </EditorField>
          <EditorField label="Unit">
            <input value={unit} onChange={(e) => setUnit(e.target.value)} style={editorInput} />
          </EditorField>
          <EditorField label="Description" wide>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...editorInput, fontFamily: "inherit" }} />
          </EditorField>
          <EditorField label="Notes" wide>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...editorInput, fontFamily: "inherit" }} />
          </EditorField>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12.5 }}>
          <EditorField label="Name">{item.name ?? "—"}</EditorField>
          <EditorField label="Category">{item.category ?? "—"}</EditorField>
          <EditorField label="Unit">{item.unit ?? "ea"}</EditorField>
          {item.notes && (
            <EditorField label="Notes" wide>
              <span style={{ whiteSpace: "pre-wrap" }}>{item.notes}</span>
            </EditorField>
          )}
        </div>
      )}
    </section>
  );
}

function EditorField({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div style={{ gridColumn: wide ? "1 / -1" : undefined, display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12.5, color: "var(--lb-text)" }}>{children}</span>
    </div>
  );
}

function PhysStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: "var(--lb-text-3)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 13.5,
          fontWeight: 700,
          color: "var(--lb-text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const editorInput: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  border: "1px solid var(--lb-border)",
  fontSize: 12.5,
};

function editorBtn(color: string): React.CSSProperties {
  return {
    padding: "3px 10px",
    borderRadius: 999,
    background: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  };
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function rfqStatusColor(s: string): string {
  switch (s) {
    case "draft": return "#6b7280";
    case "sent": return "#2563eb";
    case "quotes-in": return "#0891b2";
    case "reviewed": return "#ca8a04";
    case "awarded": return "#16a34a";
    case "closed": return "#475569";
    case "cancelled": return "#dc2626";
    default: return "#6b7280";
  }
}

// V105 — supplier-link section. Two add modes:
//
//   1. Link to catalogue product — browse every supplier_products
//      row, search by name / code / supplier, click a card to attach
//      this inventory item to that catalogue entry (sets
//      supplier_products.inventory_item_id).
//   2. Link to supplier (fabricated) — pick a supplier + optional
//      vendor URL; creates a fresh supplier_products row tied by
//      productCode.
//
// Either path adds a chip to the displayed list. Chips linked via the
// V105 FK can be removed in-place; legacy productCode-matched rows
// stay until the underlying catalogue row is archived (separate flow).
function SupplierLinkSection({
  inventoryItemId,
  links,
  onMutated,
}: {
  inventoryItemId: number;
  links: DrawerSupplierLink[];
  onMutated: () => void;
}) {
  type Mode = null | "catalogue" | "fabricated";
  const [mode, setMode] = useState<Mode>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function unlink(supplierProductId: number) {
    setErr(null);
    start(async () => {
      try {
        await unlinkSupplierProductFromInventoryAction({ supplierProductId });
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Unlink failed");
      }
    });
  }

  return (
    <Section title={`Supplier links (${links.length})`}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => setMode(mode === "catalogue" ? null : "catalogue")}
          style={modeBtn(mode === "catalogue")}
        >
          {mode === "catalogue" ? "Cancel" : "+ Link catalogue product"}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "fabricated" ? null : "fabricated")}
          style={modeBtn(mode === "fabricated")}
        >
          {mode === "fabricated" ? "Cancel" : "+ Link supplier (fabricated)"}
        </button>
      </div>

      {err && (
        <div
          style={{
            marginBottom: 10,
            padding: 8,
            borderRadius: 8,
            background: "rgba(220,38,38,0.12)",
            color: "#fca5a5",
            fontSize: 12.5,
          }}
        >
          {err}
        </div>
      )}

      {mode === "catalogue" && (
        <CataloguePicker
          inventoryItemId={inventoryItemId}
          onLinked={() => {
            setMode(null);
            onMutated();
          }}
          onError={setErr}
        />
      )}
      {mode === "fabricated" && (
        <FabricatedSupplierPicker
          inventoryItemId={inventoryItemId}
          onLinked={() => {
            setMode(null);
            onMutated();
          }}
          onError={setErr}
        />
      )}

      {links.length === 0 ? (
        <div
          style={{
            padding: 14,
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            color: "var(--lb-text-3)",
            fontSize: 12.5,
            textAlign: "center",
          }}
        >
          No supplier links yet. Use one of the buttons above to attach
          this item to a catalogue product or to a supplier who
          fabricates it.
        </div>
      ) : (
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
          {links.map((s) => (
            <li
              key={s.supplierProductId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                border: "1px solid var(--lb-border)",
                borderRadius: 8,
                background: "var(--lb-bg-elev)",
                fontSize: 13,
              }}
            >
              {s.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.thumbnailUrl}
                  alt=""
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    objectFit: "cover",
                    border: "1px solid var(--lb-border)",
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    background: "var(--lb-bg)",
                    border: "1px dashed var(--lb-border)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--lb-text-3)",
                    fontSize: 14,
                    flexShrink: 0,
                  }}
                >
                  📦
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 12.5 }}>{s.supplierName}</strong>
                  {s.linkedByFk && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: "color-mix(in srgb, var(--lb-accent) 16%, transparent)",
                        color: "var(--lb-accent)",
                      }}
                    >
                      Linked
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 11.5, color: "var(--lb-text-2)" }}>
                  {s.productName}
                  {s.productCode ? ` · ${s.productCode}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {s.productUrl && (
                  <a
                    href={s.productUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "var(--lb-accent)",
                      fontSize: 11.5,
                      textDecoration: "none",
                    }}
                  >
                    Vendor ↗
                  </a>
                )}
                {s.linkedByFk && (
                  <button
                    type="button"
                    onClick={() => unlink(s.supplierProductId)}
                    disabled={pending}
                    style={{
                      appearance: "none",
                      border: "1px solid rgba(220,38,38,0.3)",
                      background: "transparent",
                      color: "#dc2626",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      cursor: pending ? "default" : "pointer",
                    }}
                  >
                    Unlink
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function modeBtn(active: boolean): React.CSSProperties {
  return {
    appearance: "none",
    padding: "5px 12px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--lb-accent)"
      : "1px solid var(--lb-border)",
    background: active
      ? "color-mix(in srgb, var(--lb-accent) 12%, transparent)"
      : "var(--lb-bg-elev)",
    color: active ? "var(--lb-accent)" : "var(--lb-text)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  };
}

// Scrollable catalogue picker. Loads every non-archived
// supplier_products row, lets the user search by supplier / name /
// code / description, and clicks a card to set
// supplier_products.inventory_item_id = this inventory row.
function CataloguePicker({
  inventoryItemId,
  onLinked,
  onError,
}: {
  inventoryItemId: number;
  onLinked: () => void;
  onError: (msg: string) => void;
}) {
  const [options, setOptions] = useState<SupplierCatalogueOption[] | null>(null);
  const [search, setSearch] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    listSupplierCatalogueProductsAction()
      .then(setOptions)
      .catch((e) =>
        onError(e instanceof Error ? e.message : "Could not load catalogue"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = (() => {
    if (!options) return [];
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = `${o.supplierName} ${o.productName} ${o.productCode ?? ""} ${o.description ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  })();

  function pick(spId: number) {
    start(async () => {
      try {
        await linkSupplierProductToInventoryAction({
          supplierProductId: spId,
          inventoryItemId,
        });
        onLinked();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Link failed");
      }
    });
  }

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 10,
        borderRadius: 10,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg-elev)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <input
        type="search"
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search supplier, product name, code…"
        style={{
          padding: "8px 12px",
          borderRadius: 999,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          fontSize: 12.5,
        }}
      />
      {options === null ? (
        <div style={{ fontSize: 12, color: "var(--lb-text-3)" }}>Loading catalogue…</div>
      ) : filtered.length === 0 ? (
        <div
          style={{
            padding: 12,
            fontSize: 12,
            color: "var(--lb-text-3)",
            textAlign: "center",
          }}
        >
          {options.length === 0
            ? "No catalogue products yet. Use /suppliers to add some."
            : "No match — try a different search term."}
        </div>
      ) : (
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          {filtered.map((o) => {
            const alreadyOnSomethingElse =
              o.linkedToInventoryItemId != null &&
              o.linkedToInventoryItemId !== inventoryItemId;
            const alreadyOnUs = o.linkedToInventoryItemId === inventoryItemId;
            return (
              <button
                key={o.supplierProductId}
                type="button"
                disabled={pending || alreadyOnUs}
                onClick={() => pick(o.supplierProductId)}
                title={
                  alreadyOnUs
                    ? "Already linked to this item."
                    : alreadyOnSomethingElse
                      ? "Linked to a different inventory item — clicking will move the link to this one."
                      : `Click to link ${o.productName} to this inventory item`
                }
                style={{
                  textAlign: "left",
                  padding: 8,
                  borderRadius: 8,
                  border: alreadyOnUs
                    ? "1px solid var(--lb-accent)"
                    : alreadyOnSomethingElse
                      ? "1px dashed rgba(202,138,4,0.5)"
                      : "1px solid var(--lb-border)",
                  background: alreadyOnUs
                    ? "color-mix(in srgb, var(--lb-accent) 10%, var(--lb-bg))"
                    : "var(--lb-bg)",
                  color: "var(--lb-text)",
                  cursor: alreadyOnUs ? "default" : "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  opacity: pending ? 0.7 : 1,
                }}
              >
                {o.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={o.thumbnailUrl}
                    alt=""
                    style={{
                      width: "100%",
                      aspectRatio: "1/1",
                      objectFit: "cover",
                      borderRadius: 6,
                      background: "var(--lb-bg-elev)",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "1/1",
                      borderRadius: 6,
                      background: "var(--lb-bg-elev)",
                      display: "grid",
                      placeItems: "center",
                      color: "var(--lb-text-3)",
                      fontSize: 22,
                    }}
                  >
                    📦
                  </div>
                )}
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    color: "var(--lb-text-3)",
                  }}
                >
                  {o.supplierName}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.3 }}>
                  {o.productName}
                </div>
                {o.productCode && (
                  <code
                    style={{
                      fontSize: 10.5,
                      color: "#0891b2",
                      background: "rgba(8,145,178,0.12)",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontWeight: 700,
                      alignSelf: "flex-start",
                      wordBreak: "break-all",
                    }}
                  >
                    {o.productCode}
                  </code>
                )}
                {alreadyOnUs && (
                  <div style={{ fontSize: 10.5, color: "var(--lb-accent)", fontWeight: 700 }}>
                    ✓ Currently linked
                  </div>
                )}
                {alreadyOnSomethingElse && (
                  <div style={{ fontSize: 10.5, color: "#ca8a04" }}>
                    Already linked to another item
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Fabricated-supplier picker. Simpler: dropdown of every supplier +
// optional vendor URL. Creates a fresh supplier_products row tied to
// this inventory item via its productCode (the existing
// linkInventoryToSupplierAction path).
function FabricatedSupplierPicker({
  inventoryItemId,
  onLinked,
  onError,
}: {
  inventoryItemId: number;
  onLinked: () => void;
  onError: (msg: string) => void;
}) {
  const [options, setOptions] = useState<SupplierOption[] | null>(null);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    listSupplierOptions()
      .then(setOptions)
      .catch((e) =>
        onError(e instanceof Error ? e.message : "Could not load suppliers"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function run() {
    if (typeof supplierId !== "number") {
      onError("Pick a supplier first.");
      return;
    }
    start(async () => {
      try {
        await linkInventoryToSupplierAction({
          inventoryItemId,
          supplierId,
          productUrl: url.trim() || null,
        });
        onLinked();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Link failed");
      }
    });
  }

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 10,
        borderRadius: 10,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg-elev)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--lb-text-3)" }}>
        Use this when you fabricate the item in-house and want to track
        a supplier who supplies a raw material or a sub-process for it
        (no catalogue product needed).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select
          value={supplierId === "" ? "" : String(supplierId)}
          onChange={(e) =>
            setSupplierId(e.target.value === "" ? "" : Number(e.target.value))
          }
          style={{
            flex: "1 1 200px",
            padding: "7px 10px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 12.5,
          }}
        >
          <option value="">
            {options === null ? "Loading…" : "Pick a supplier"}
          </option>
          {options?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.origin ? ` · ${s.origin}` : ""}
            </option>
          ))}
        </select>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Optional vendor URL"
          style={{
            flex: "1 1 200px",
            padding: "7px 10px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 12.5,
          }}
        />
        <button
          type="button"
          onClick={run}
          disabled={pending || typeof supplierId !== "number"}
          style={{
            padding: "7px 14px",
            borderRadius: 999,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg, white)",
            border: 0,
            fontSize: 12.5,
            fontWeight: 700,
            cursor: pending ? "default" : "pointer",
            opacity:
              pending || typeof supplierId !== "number" ? 0.6 : 1,
          }}
        >
          {pending ? "Linking…" : "Link supplier"}
        </button>
      </div>
    </div>
  );
}

// Drop-target section. Two visual modes:
//   tone='child'  → blue accent ring + "Add as child" microcopy
//   tone='parent' → purple ring + "Add as parent" microcopy
// Each section already renders its NavList contents inside; the
// drop-zone wraps the whole region so the user can drop on the
// section header, the empty hint, or any of the existing rows.
function DropZoneSection({
  title,
  tone,
  emptyHint,
  items,
  onNavigateTo,
  onDrop,
  currentItemId,
}: {
  title: string;
  tone: "child" | "parent";
  emptyHint: string;
  items: DrawerChild[] | DrawerParent[];
  onNavigateTo: (id: number) => void;
  onDrop: (draggedItemId: number) => void;
  currentItemId: number;
}) {
  const [over, setOver] = useState(false);
  const accent = tone === "child" ? "#2563eb" : "#7c3aed";
  const accentLight =
    tone === "child"
      ? "color-mix(in srgb, #2563eb 12%, transparent)"
      : "color-mix(in srgb, #7c3aed 12%, transparent)";

  function handleDragOver(e: React.DragEvent) {
    if (
      !e.dataTransfer.types.includes("application/x-lb-inventory-item")
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "link";
    if (!over) setOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    // Only clear when the cursor actually leaves the wrapper (not when
    // crossing a child row).
    if (
      !e.relatedTarget ||
      !(e.relatedTarget instanceof Node) ||
      !e.currentTarget.contains(e.relatedTarget)
    ) {
      setOver(false);
    }
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    // Support both the multi-id key (set by the catalogue palette)
    // and the legacy single-id key (set by everything else). Loops
    // through every id and fires the parent's onDrop callback once
    // per child so the drawer's existing reload pipeline handles
    // the batch.
    const ids = parseDraggedItemIdsLocal(e.dataTransfer).filter(
      (id) => id !== currentItemId,
    );
    for (const id of ids) onDrop(id);
  }

  return (
    <section
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        padding: 10,
        borderRadius: 12,
        border: over
          ? `2px dashed ${accent}`
          : "2px dashed transparent",
        background: over ? accentLight : "transparent",
        transition:
          "background-color 160ms ease, border-color 160ms ease",
      }}
    >
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: over ? accent : "var(--lb-text-3)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {title}
        {over && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: accent,
              color: "#fff",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
            }}
          >
            {tone === "child" ? "Add as child" : "Add as parent"}
          </span>
        )}
      </h3>
      {items.length === 0 ? (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            border: `1px dashed ${over ? accent : "var(--lb-border)"}`,
            background: over ? accentLight : "var(--lb-bg-elev)",
            color: over ? accent : "var(--lb-text-3)",
            fontSize: 12.5,
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          {emptyHint}
        </div>
      ) : (
        <NavList
          items={items.map((it) => {
            const kind = "kind" in it ? it.kind : "assembly";
            const stock = "stock" in it ? it.stock : null;
            return {
              id: it.inventoryItemId,
              icon: kind === "assembly" ? "🧩" : "🔧",
              code: it.code,
              name: it.name,
              qty: it.quantity,
              stock,
            };
          })}
          onClick={onNavigateTo}
        />
      )}
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function NavList({
  items,
  onClick,
}: {
  items: Array<{
    id: number;
    icon: string;
    code: string;
    name: string | null;
    qty: number;
    stock: number | null;
  }>;
  onClick: (id: number) => void;
}) {
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: 6,
      }}
    >
      {items.map((it) => (
        <li key={it.id}>
          <button
            type="button"
            onClick={() => onClick(it.id)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              textAlign: "left",
              cursor: "pointer",
              transition:
                "transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.borderColor = "var(--lb-accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.borderColor = "var(--lb-border)";
            }}
          >
            <span style={{ fontSize: 14 }}>{it.icon}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <code style={{ fontSize: 12.5, fontWeight: 700 }}>
                {it.code}
              </code>
              {it.name && (
                <div style={{ fontSize: 11.5, color: "var(--lb-text-3)" }}>
                  {it.name}
                </div>
              )}
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--lb-text-2)",
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
              }}
            >
              × {it.qty}
            </span>
            {it.stock != null && (
              <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                stock {it.stock}
              </span>
            )}
            <span style={{ fontSize: 14, color: "var(--lb-text-3)" }}>›</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── Attachments ────────────────────────────────────────────────────────

// Editable configurations section. Read-only display by default;
// click "Edit" to enter chip-editor mode with add/remove rows and
// a Save button. Always renders the section header so a user can
// ADD configurations to a row that didn't have any.
function ConfigurationsSection({
  inventoryItemId,
  initialConfigurations,
  configOptions,
  onMutated,
}: {
  inventoryItemId: number;
  initialConfigurations: Configuration[];
  configOptions: ConfigurationOption[];
  onMutated: () => void;
}) {
  const datalistId = `drawer-config-options-${inventoryItemId}`;
  const [editing, setEditing] = useState(false);
  const [draftConfigs, setDraftConfigs] = useState<Configuration[]>(
    initialConfigurations,
  );
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Keep the editor in sync if the drawer reloads after another
  // mutation (e.g. attachment add) so the user doesn't lose context.
  useEffect(() => {
    if (!editing) setDraftConfigs(initialConfigurations);
  }, [initialConfigurations, editing]);

  function enterEdit() {
    setDraftConfigs(initialConfigurations);
    setEditing(true);
    setErr(null);
  }
  function cancel() {
    setEditing(false);
    setErr(null);
  }
  function save() {
    setErr(null);
    start(async () => {
      try {
        await setInventoryConfigurationsAction({
          inventoryItemId,
          configurations: draftConfigs,
        });
        setEditing(false);
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function addRow() {
    setDraftConfigs((prev) => [...prev, { name: "", description: null }]);
  }
  function updateAt(i: number, patch: Partial<Configuration>) {
    setDraftConfigs((prev) =>
      prev.map((c, j) => (i === j ? { ...c, ...patch } : c)),
    );
  }
  function removeAt(i: number) {
    setDraftConfigs((prev) => prev.filter((_, j) => j !== i));
  }
  // Auto-fill the description when the user picks a known name from
  // the typeahead — but only when their description field is empty
  // so we never overwrite something they typed.
  function autoFillFromOption(i: number, rawName: string) {
    const name = rawName.trim().toUpperCase();
    setDraftConfigs((prev) =>
      prev.map((c, j) => {
        if (j !== i) return c;
        const match = configOptions.find(
          (o) => o.name.toUpperCase() === name,
        );
        if (!match) return { ...c, name };
        if (!c.description || !c.description.trim()) {
          return { name, description: match.description };
        }
        return { ...c, name };
      }),
    );
  }

  const title = `Configurations (${initialConfigurations.length})`;

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          {title}
        </h3>
        {!editing ? (
          <button
            type="button"
            onClick={enterEdit}
            style={{
              fontSize: 11.5,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid var(--lb-border)",
              background: "transparent",
              color: "var(--lb-accent)",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {initialConfigurations.length === 0 ? "+ Add" : "Edit"}
          </button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={cancel}
              disabled={pending}
              style={{
                fontSize: 11.5,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid var(--lb-border)",
                background: "transparent",
                color: "var(--lb-text-2)",
                cursor: pending ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                padding: "4px 12px",
                borderRadius: 999,
                border: "none",
                color: "#fff",
                background:
                  "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
                cursor: pending ? "default" : "pointer",
              }}
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>

      {!editing ? (
        initialConfigurations.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px dashed var(--lb-border)",
              fontSize: 12.5,
              color: "var(--lb-text-3)",
              textAlign: "center",
            }}
          >
            No configurations yet — click <strong>+ Add</strong> above to
            create one.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {initialConfigurations.map((c, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    minWidth: 64,
                    padding: "3px 9px",
                    borderRadius: 999,
                    background:
                      "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
                    color: "var(--lb-accent)",
                    fontSize: 11,
                    fontWeight: 700,
                    textAlign: "center",
                  }}
                >
                  {c.name}
                </span>
                <span
                  style={{
                    color: c.description
                      ? "var(--lb-text-2)"
                      : "var(--lb-text-3)",
                  }}
                >
                  {c.description ?? "No description"}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            borderRadius: 10,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
          }}
        >
          {draftConfigs.length === 0 && (
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
          {draftConfigs.map((c, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(110px, 1fr) minmax(160px, 2fr) auto",
                gap: 8,
                alignItems: "flex-start",
              }}
            >
              <input
                value={c.name}
                onChange={(e) =>
                  updateAt(i, { name: e.target.value.toUpperCase() })
                }
                onBlur={(e) => autoFillFromOption(i, e.target.value)}
                list={datalistId}
                placeholder={
                  configOptions.length
                    ? "Pick or type (e.g. ENC)"
                    : "e.g. ENC"
                }
                aria-label={`Configuration ${i + 1} name`}
                style={{
                  padding: "8px 10px",
                  fontSize: 12.5,
                  borderRadius: 8,
                  border: "1px solid var(--lb-border)",
                  background: "var(--lb-bg)",
                  color: "var(--lb-text)",
                  fontFamily: "var(--lb-font-mono, monospace)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  outline: "none",
                }}
              />
              <input
                value={c.description ?? ""}
                onChange={(e) =>
                  updateAt(i, {
                    description: e.target.value ? e.target.value : null,
                  })
                }
                placeholder={
                  configOptions.find(
                    (o) => o.name === c.name.trim().toUpperCase(),
                  )?.description ?? "Description (optional)"
                }
                aria-label={`Configuration ${i + 1} description`}
                style={{
                  padding: "8px 10px",
                  fontSize: 12.5,
                  borderRadius: 8,
                  border: "1px solid var(--lb-border)",
                  background: "var(--lb-bg)",
                  color: "var(--lb-text)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove configuration ${i + 1}`}
                style={{
                  padding: "6px 10px",
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
            onClick={addRow}
            style={{
              alignSelf: "flex-start",
              padding: "6px 12px",
              fontSize: 12.5,
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
          {configOptions.length > 0 && (
            <datalist id={datalistId}>
              {configOptions
                .filter(
                  (o) =>
                    !draftConfigs.some(
                      (c) => c.name.trim().toUpperCase() === o.name,
                    ),
                )
                .map((o) => (
                  <option
                    key={o.id}
                    value={o.name}
                    label={o.description ?? undefined}
                  />
                ))}
            </datalist>
          )}
          {err && (
            <div
              style={{
                padding: 8,
                borderRadius: 6,
                background: "rgba(239,68,68,0.08)",
                color: "#dc2626",
                fontSize: 12,
              }}
            >
              {err}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AttachmentsSection({
  inventoryItemId,
  attachments,
  onMutated,
}: {
  inventoryItemId: number;
  attachments: DrawerAttachment[];
  onMutated: () => void;
}) {
  const [kind, setKind] = useState<DrawerAttachment["kind"]>("cad");
  const [label, setLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr(null);
    setUploading(true);
    try {
      const pathname = `design-engineering/inventory/${inventoryItemId}/${file.name}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
      });
      await addInventoryAttachmentAction({
        inventoryItemId,
        kind,
        label: label.trim() || file.name,
        url: blob.url,
        pathname: blob.pathname,
        contentType: file.type || null,
        sizeBytes: file.size,
      });
      setLabel("");
      onMutated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function addLink() {
    if (!linkUrl.trim()) {
      setErr("Paste a URL first");
      return;
    }
    setErr(null);
    start(async () => {
      try {
        await addInventoryAttachmentAction({
          inventoryItemId,
          kind: "link",
          label: label.trim() || linkUrl.trim(),
          url: linkUrl.trim(),
        });
        setLabel("");
        setLinkUrl("");
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function remove(id: number) {
    if (!confirm("Remove this attachment?")) return;
    setErr(null);
    start(async () => {
      try {
        await removeInventoryAttachmentAction({ attachmentId: id });
        onMutated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <Section title={`Files & links (${attachments.length})`}>
      {/* Existing attachments */}
      {attachments.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 0 12px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 8,
          }}
        >
          {attachments.map((a) => (
            <li
              key={a.id}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12.5,
              }}
            >
              {a.kind === "image" ? (
                <div
                  style={{
                    width: "100%",
                    height: 90,
                    borderRadius: 6,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.url}
                    alt={a.label}
                    style={{
                      maxWidth: "100%",
                      maxHeight: "100%",
                      objectFit: "contain",
                    }}
                  />
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 26,
                    textAlign: "center",
                    padding: "8px 0",
                  }}
                >
                  {KIND_ICON[a.kind]}
                </div>
              )}
              <div style={{ fontWeight: 600, wordBreak: "break-word" }}>
                {a.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--lb-text-3)",
                  display: "flex",
                  gap: 6,
                }}
              >
                <span>{a.kind.toUpperCase()}</span>
                {a.sizeBytes != null && <span>· {bytes(a.sizeBytes)}</span>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 11.5,
                    flex: 1,
                    textAlign: "center",
                    padding: "4px 8px",
                    borderRadius: 999,
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text-2)",
                    textDecoration: "none",
                  }}
                >
                  Open ↗
                </a>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid rgba(239,68,68,0.3)",
                    background: "transparent",
                    color: "#dc2626",
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Upload + link form */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                border:
                  kind === k.value
                    ? "1px solid var(--lb-accent)"
                    : "1px solid var(--lb-border)",
                background:
                  kind === k.value
                    ? "color-mix(in srgb, var(--lb-accent) 12%, transparent)"
                    : "var(--lb-bg)",
                color:
                  kind === k.value
                    ? "var(--lb-accent)"
                    : "var(--lb-text-2)",
                cursor: "pointer",
              }}
              title={k.hint}
            >
              {KIND_ICON[k.value]} {k.label}
            </button>
          ))}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional — defaults to filename / URL)"
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--lb-border)",
            background: "var(--lb-bg)",
            color: "var(--lb-text)",
            fontSize: 13,
            outline: "none",
          }}
        />

        {kind === "link" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://… vendor page, BOM link, drawing URL"
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--lb-border)",
                background: "var(--lb-bg)",
                color: "var(--lb-text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={addLink}
              disabled={pending || !linkUrl.trim()}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 700,
                borderRadius: 999,
                color: "#fff",
                border: "none",
                background:
                  "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
                cursor: pending ? "default" : "pointer",
              }}
            >
              {pending ? "Saving…" : "Add link"}
            </button>
          </div>
        ) : (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px dashed var(--lb-border)",
              background: "var(--lb-bg)",
              cursor: uploading ? "default" : "pointer",
            }}
          >
            <span style={{ fontSize: 18 }}>{KIND_ICON[kind]}</span>
            <span style={{ flex: 1, fontSize: 13 }}>
              {uploading ? "Uploading…" : `Click to upload a ${kind} file`}
            </span>
            <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
              {KINDS.find((k) => k.value === kind)?.hint}
            </span>
            <input
              type="file"
              onChange={onFileChosen}
              disabled={uploading}
              style={{ display: "none" }}
            />
          </label>
        )}

        {err && (
          <div
            style={{
              padding: 8,
              borderRadius: 6,
              background: "rgba(239,68,68,0.08)",
              color: "#dc2626",
              fontSize: 12,
            }}
          >
            {err}
          </div>
        )}
      </div>
    </Section>
  );
}
