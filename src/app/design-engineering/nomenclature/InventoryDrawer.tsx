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
  getInventoryDetails,
  removeInventoryAttachmentAction,
  type DrawerAttachment,
  type DrawerChild,
  type DrawerParent,
  type InventoryDetails,
} from "./actions";

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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const d = await getInventoryDetails({ inventoryItemId: currentId });
      setDetails(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load details");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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
                  {details.product && (
                    <span
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
                      {details.product}
                    </span>
                  )}
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
          {details && (
            <Body
              details={details}
              onMutated={load}
              onNavigateTo={navigateTo}
              onDropAsChild={addAsChild}
              onDropAsParent={addAsParent}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function Body({
  details,
  onMutated,
  onNavigateTo,
  onDropAsChild,
  onDropAsParent,
}: {
  details: InventoryDetails;
  onMutated: () => void;
  onNavigateTo: (id: number) => void;
  onDropAsChild: (draggedItemId: number) => void;
  onDropAsParent: (draggedItemId: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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

      {details.configurations.length > 0 && (
        <Section title="Configurations">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {details.configurations.map((c, i) => (
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
        </Section>
      )}

      <AttachmentsSection
        inventoryItemId={details.inventoryItemId}
        attachments={details.attachments}
        onMutated={onMutated}
      />

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

      {details.supplierLinks.length > 0 && (
        <Section
          title={`Supplier catalogue links (${details.supplierLinks.length})`}
        >
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {details.supplierLinks.map((s) => (
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
                <strong>{s.supplierName}</strong>
                {s.productUrl && (
                  <a
                    href={s.productUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      marginLeft: "auto",
                      color: "var(--lb-accent)",
                      fontSize: 12,
                      textDecoration: "none",
                    }}
                  >
                    Vendor page ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
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
    const raw = e.dataTransfer.getData("application/x-lb-inventory-item");
    const id = Number(raw);
    if (!id || id === currentItemId) return;
    onDrop(id);
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
