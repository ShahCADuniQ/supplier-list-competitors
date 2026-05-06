"use client";

// Right-side slide-out for an ideation product. Lets the user manage:
//   - Images (multiple uploads)
//   - One section per file category specific to this product:
//       Design Drawings, Specsheet, Installation Manual, Assembly Manual,
//       Specification Table, BOM, Arborescence de nomenclature
//
// Reuses the existing pd-drawer / pd-overlay styling already in
// CompetitorsView's CSS so the drawer feels consistent with the
// product/idea drawers elsewhere on the page.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addProductFile,
  deleteProductFile,
} from "./ideation-product-file-actions";
import type {
  IdeationProduct,
  IdeationProductFile,
  CompetitorIdeationItem,
} from "@/db/schema";

type Props = {
  product: IdeationProduct;
  files: IdeationProductFile[];
  /** Ideation cards already linked to this product (or global). */
  linkedItems: CompetitorIdeationItem[];
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Called when the user clicks a linked-idea thumbnail — parent opens
   *  the IdeationDetailDrawer overlaid on top of this drawer. */
  onOpenItem: (itemId: number) => void;
  onToast: (msg: string, err?: boolean) => void;
  onClose: () => void;
};

// File slots in display order. `accept` is a hint for the file picker; the
// server doesn't enforce it (PDFs / images / docs are all valid uploads).
const SLOTS: ReadonlyArray<{
  kind: string;
  label: string;
  hint: string;
  accept?: string;
  imageOnly?: boolean;
}> = [
  { kind: "image", label: "Images", hint: "Renders, photos, references", accept: "image/*", imageOnly: true },
  { kind: "design_drawing", label: "Design Drawings", hint: "DWG / DXF / PDF" },
  { kind: "specsheet", label: "Specsheet", hint: "PDF / DOC" },
  { kind: "installation_manual", label: "Installation Manual", hint: "PDF / DOC" },
  { kind: "assembly_manual", label: "Assembly Manual", hint: "PDF / DOC" },
  { kind: "specification_table", label: "Specification Table", hint: "XLSX / CSV / PDF" },
  { kind: "bom", label: "BOM", hint: "XLSX / CSV / PDF" },
  { kind: "arborescence", label: "Arborescence de nomenclature", hint: "PDF / image / XLSX" },
];

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function fmtBytes(n: number) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function IdeationProductDrawer({
  product,
  files,
  linkedItems,
  canEdit,
  onEdit,
  onDelete,
  onOpenItem,
  onToast,
  onClose,
}: Props) {
  const router = useRouter();
  const [entered, setEntered] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);
  // Lightbox for image previews — clicking an uploaded product image
  // expands it to a fullscreen overlay so the whole picture is visible
  // at natural resolution.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function requestClose() {
    setEntered(false);
    setTimeout(onClose, 220);
  }

  // Group files by kind for quick render lookup.
  const filesByKind = new Map<string, IdeationProductFile[]>();
  for (const f of files) {
    const list = filesByKind.get(f.fileKind) ?? [];
    list.push(f);
    filesByKind.set(f.fileKind, list);
  }

  async function handleUpload(kind: string, fileList: FileList | File[]) {
    if (!canEdit) return;
    setUploadingKind(kind);
    let succeeded = 0;
    for (const f of Array.from(fileList)) {
      try {
        const pathname = `competitors/ideation-products/${product.id}/${kind}/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addProductFile({
          collectionId: product.collectionId,
          productId: product.id,
          fileKind: kind,
          name: f.name,
          size: f.size,
          mimeType: f.type || null,
          url: blob.url,
          blobPathname: blob.pathname,
        });
        succeeded++;
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Upload failed", true);
      }
    }
    setUploadingKind(null);
    if (succeeded > 0) {
      router.refresh();
      onToast(`Uploaded ${succeeded} file${succeeded === 1 ? "" : "s"}`);
    }
  }

  async function handleDelete(file: IdeationProductFile) {
    if (!canEdit) return;
    if (!confirm(`Delete "${file.name}"?`)) return;
    try {
      await deleteProductFile(file.id);
      router.refresh();
      onToast("Deleted");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    }
  }

  return (
    <div
      className={`pd-overlay${entered ? " entered" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${product.name} details`}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <aside className={`pd-drawer${entered ? " entered" : ""}`}>
        <header className="pd-head">
          <button
            type="button"
            className="pd-close"
            onClick={requestClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
          <div className="pd-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: 9999,
                background: product.color,
                border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
                flexShrink: 0,
              }}
            />
            <div>
              <div className="pd-brand">Ideation product</div>
              <h2 className="pd-name">{product.name}</h2>
            </div>
          </div>
          {canEdit && (
            <div className="pd-head-actions">
              <button type="button" className="btn sm" onClick={onEdit}>
                ✎ Edit
              </button>
              <button
                type="button"
                className="btn sm pd-danger"
                onClick={onDelete}
              >
                🗑 Delete
              </button>
            </div>
          )}
        </header>

        <div className="pd-body">
          <section className="pd-section">
            <h3
              className="pd-section-h"
              style={{ display: "flex", alignItems: "baseline", gap: 8 }}
            >
              <span>Linked ideas</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 400,
                  color: "var(--muted)",
                  letterSpacing: 0,
                  textTransform: "none",
                }}
              >
                Pinterest cards & moodboard items linked to this product
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--muted)",
                  fontWeight: 600,
                }}
              >
                {linkedItems.length}
              </span>
            </h3>

            {linkedItems.length === 0 ? (
              <p
                style={{
                  fontSize: 12,
                  color: "var(--muted)",
                  margin: 0,
                  padding: "12px",
                  background: "var(--surface-2)",
                  border: "1px dashed var(--border)",
                  borderRadius: 8,
                  textAlign: "center",
                }}
              >
                No ideas linked yet. Open any Pinterest card and link it to
                <strong style={{ color: "var(--text)" }}>
                  {" "}
                  {product.name}
                </strong>{" "}
                from its drawer.
              </p>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(120px, 1fr))",
                  gap: 8,
                }}
              >
                {linkedItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onOpenItem(it.id)}
                    title={it.title ?? "Open"}
                    style={{
                      position: "relative",
                      aspectRatio: "1 / 1",
                      background: "#0f172a",
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid var(--border)",
                      padding: 0,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      transition: "border-color 160ms ease, transform 100ms ease",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={it.imageUrl}
                      alt={it.title ?? ""}
                      loading="lazy"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        display: "block",
                      }}
                      onError={(e) => {
                        (e.currentTarget.style.opacity = "0.2");
                      }}
                    />
                    {it.isGlobal && (
                      <span
                        aria-hidden
                        title="Applies to every product (global)"
                        style={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          padding: "1px 6px",
                          borderRadius: 9999,
                          background: "rgba(15,23,42,0.78)",
                          color: "#fff",
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          lineHeight: 1.4,
                        }}
                      >
                        All
                      </span>
                    )}
                    {it.title && (
                      <span
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          padding: "4px 6px",
                          background:
                            "linear-gradient(to top, rgba(0,0,0,0.7), transparent)",
                          color: "#fff",
                          fontSize: 10,
                          lineHeight: 1.3,
                          fontWeight: 500,
                          textAlign: "left",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {it.title}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          {SLOTS.map((slot) => {
            const list = filesByKind.get(slot.kind) ?? [];
            const isUploading = uploadingKind === slot.kind;
            return (
              <FileSlot
                key={slot.kind}
                title={slot.label}
                hint={slot.hint}
                files={list}
                accept={slot.accept}
                imageOnly={slot.imageOnly}
                canEdit={canEdit}
                isUploading={isUploading}
                onUpload={(f) => handleUpload(slot.kind, f)}
                onDelete={handleDelete}
                onImageClick={(url) => setLightboxUrl(url)}
              />
            );
          })}
        </div>
      </aside>

      {lightboxUrl && (
        <ImageLightbox
          url={lightboxUrl}
          onClose={() => setLightboxUrl(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline lightbox — shows an image at natural size on a dim backdrop. ESC
// closes; clicking outside the image closes; clicking the image itself
// does nothing so users can drag-select / zoom.
// ─────────────────────────────────────────────────────────────────────────────
export function ImageLightbox({
  url,
  alt,
  onClose,
  extraButton,
}: {
  url: string;
  alt?: string;
  onClose: () => void;
  /** Optional secondary action (e.g. "Edit details") rendered top-left. */
  extraButton?: { label: string; onClick: () => void };
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.92)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      {extraButton && (
        <button
          type="button"
          onClick={extraButton.onClick}
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            padding: "8px 16px",
            borderRadius: 9999,
            background: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.24)",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          {extraButton.label}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 40,
          height: 40,
          borderRadius: 9999,
          background: "rgba(255,255,255,0.12)",
          border: "1px solid rgba(255,255,255,0.24)",
          color: "#fff",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
          fontFamily: "inherit",
        }}
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt ?? ""}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          display: "block",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          borderRadius: 4,
        }}
      />
    </div>
  );
}

function FileSlot({
  title,
  hint,
  files,
  accept,
  imageOnly,
  canEdit,
  isUploading,
  onUpload,
  onDelete,
  onImageClick,
}: {
  title: string;
  hint: string;
  files: IdeationProductFile[];
  accept?: string;
  imageOnly?: boolean;
  canEdit: boolean;
  isUploading: boolean;
  onUpload: (files: FileList | File[]) => void;
  onDelete: (file: IdeationProductFile) => void;
  onImageClick?: (url: string) => void;
}) {
  return (
    <section className="pd-section">
      <h3
        className="pd-section-h"
        style={{ display: "flex", alignItems: "baseline", gap: 8 }}
      >
        <span>{title}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: "var(--muted)",
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          {hint}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--muted)",
            fontWeight: 600,
          }}
        >
          {files.length}
        </span>
      </h3>

      {imageOnly && files.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 8,
            marginBottom: 10,
          }}
        >
          {files.map((f) => (
            <div
              key={f.id}
              role="button"
              tabIndex={0}
              onClick={() => onImageClick?.(f.url)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onImageClick?.(f.url);
                }
              }}
              title={f.name}
              style={{
                position: "relative",
                aspectRatio: "1 / 1",
                background: "#0f172a",
                borderRadius: 8,
                overflow: "hidden",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.url}
                alt={f.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
              {canEdit && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(f);
                  }}
                  aria-label={`Delete ${f.name}`}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    borderRadius: 9999,
                    border: "1px solid rgba(255,255,255,0.4)",
                    background: "rgba(15,23,42,0.65)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 11,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ) : !imageOnly && files.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 0 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {files.map((f) => (
            <li
              key={f.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: "var(--text)",
                  textDecoration: "none",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={f.name}
              >
                {f.name}
              </a>
              <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>
                {fmtBytes(f.size ?? 0)}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onDelete(f)}
                  aria-label={`Delete ${f.name}`}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 9999,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--muted)",
                    cursor: "pointer",
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {canEdit && (
        <label
          style={{
            display: "block",
            padding: 14,
            border: "1.5px dashed var(--border-strong)",
            borderRadius: 8,
            textAlign: "center",
            fontSize: 12,
            color: "var(--muted)",
            cursor: isUploading ? "not-allowed" : "pointer",
            background: "var(--surface-2)",
            transition: "border-color 160ms ease, color 160ms ease, background 160ms ease",
            opacity: isUploading ? 0.6 : 1,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
            (e.currentTarget as HTMLElement).style.color = "var(--accent)";
          }}
          onDragLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)";
            (e.currentTarget as HTMLElement).style.color = "var(--muted)";
          }}
          onDrop={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)";
            (e.currentTarget as HTMLElement).style.color = "var(--muted)";
            if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
          }}
        >
          {isUploading ? "Uploading…" : <>Drop files or <strong>click to add</strong></>}
          <input
            type="file"
            multiple={imageOnly !== false}
            accept={accept}
            style={{ display: "none" }}
            disabled={isUploading}
            onChange={(e) => {
              if (e.target.files?.length) onUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      )}

      {!canEdit && files.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          No files in this slot.
        </p>
      )}
    </section>
  );
}
