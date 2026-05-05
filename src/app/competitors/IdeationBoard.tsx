"use client";

// Brainstorming board. Primary input is a Pinterest URL — paste it, add a
// note about what you like, and we pull every image and create one card per
// pin. Cards are clickable; clicking opens IdeationDetailDrawer (right-side
// slide-out) where you can refine the note, add tags, or delete.
//
// Drag-and-drop image upload is kept as a secondary path for non-Pinterest
// references the user wants to add manually.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addIdeationItem,
  aiAddPinterestLink,
  deleteAllIdeationItems,
} from "./ideation-actions";
import IdeationDetailDrawer from "./IdeationDetailDrawer";
import type {
  CompetitorCollection,
  Competitor,
  CompetitorIdeationItem,
} from "@/db/schema";

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

export default function IdeationBoard({
  collection,
  // brands kept for API compatibility (Summary jump-to expects this shape)
  brands: _brands,
  items,
  canEdit,
  onToast,
}: {
  collection: CompetitorCollection;
  brands: Competitor[];
  items: CompetitorIdeationItem[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  void _brands;
  const router = useRouter();

  // ── Pinterest extractor ──
  const [pinterestUrl, setPinterestUrl] = useState("");
  const [pinterestComment, setPinterestComment] = useState("");
  const [pinterestBusy, setPinterestBusy] = useState(false);

  async function addPinterestBoard() {
    if (!canEdit) return;
    const u = pinterestUrl.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      onToast("URL must start with http(s)://", true);
      return;
    }
    setPinterestBusy(true);
    try {
      onToast("Reading Pinterest page…");
      const r = await aiAddPinterestLink({
        collectionId: collection.id,
        url: u,
        comment: pinterestComment.trim() || undefined,
      });
      setPinterestUrl("");
      setPinterestComment("");
      router.refresh();
      const parts: string[] = [];
      if (r.imageCount > 0) {
        parts.push(`Added ${r.imageCount} image${r.imageCount === 1 ? "" : "s"}`);
      } else {
        parts.push("No new images (everything already on the board)");
      }
      if (r.duplicateCount > 0) {
        parts.push(`${r.duplicateCount} skipped (already added)`);
      }
      onToast(parts.join(" · "));
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Pinterest extract failed", true);
    } finally {
      setPinterestBusy(false);
    }
  }

  // ── Manual image upload (drop or click) ──
  const [uploading, setUploading] = useState(0);
  async function uploadFiles(files: FileList | File[]) {
    if (!canEdit) return;
    let succeeded = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) {
        onToast(`${f.name} is not an image`, true);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const pathname = `competitors/ideation/${collection.id}/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addIdeationItem({
          collectionId: collection.id,
          imageUrl: blob.url,
          blobPathname: blob.pathname,
          mimeType: f.type,
          size: f.size,
          title: f.name.replace(/\.[^.]+$/, ""),
          kind: "reference",
        });
        succeeded++;
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Upload failed", true);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (succeeded > 0) {
      router.refresh();
      onToast(`Uploaded ${succeeded} image${succeeded === 1 ? "" : "s"}`);
    }
  }

  // ── Bulk delete ──
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  async function handleDeleteAll() {
    if (!canEdit || items.length === 0) return;
    if (
      !confirm(
        `Delete ALL ${items.length} image${items.length === 1 ? "" : "s"} from this ideation board? This can't be undone.`,
      )
    ) {
      return;
    }
    setDeleteAllBusy(true);
    try {
      const r = await deleteAllIdeationItems({ collectionId: collection.id });
      router.refresh();
      const blobNote = r.blobsRemoved > 0 ? ` · ${r.blobsRemoved} uploaded file${r.blobsRemoved === 1 ? "" : "s"} removed from storage` : "";
      onToast(`Deleted ${r.deletedCount} image${r.deletedCount === 1 ? "" : "s"}${blobNote}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
    } finally {
      setDeleteAllBusy(false);
    }
  }

  // ── Search ──
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => {
      const hay = [i.title, i.notes, ...(i.tags ?? [])].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [items, search]);

  // ── Drawer ──
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const openItem = items.find((i) => i.id === openItemId) ?? null;

  return (
    <div className="bm-wrap">
      {canEdit && (
        <div className="d-card id-pinterest">
          <h4 className="id-pinterest-h">
            📌 Paste a Pinterest link
            <span className="id-pinterest-h-hint">
              — board, pin, or profile. We pull every image and add them as cards.
            </span>
          </h4>
          <div className="id-pinterest-row">
            <input
              type="url"
              className="id-pinterest-url"
              placeholder="https://www.pinterest.com/yourname/board-name/"
              value={pinterestUrl}
              onChange={(e) => setPinterestUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addPinterestBoard();
                }
              }}
              disabled={pinterestBusy}
            />
            <button
              type="button"
              className="btn primary sm"
              onClick={addPinterestBoard}
              disabled={pinterestBusy || !pinterestUrl.trim()}
            >
              {pinterestBusy ? "Reading…" : "📥 Pull images"}
            </button>
          </div>
          <textarea
            className="id-pinterest-comment"
            placeholder="What do you like about this? (optional — applied as the note on every image we pull in)"
            value={pinterestComment}
            onChange={(e) => setPinterestComment(e.target.value)}
            rows={2}
            disabled={pinterestBusy}
          />
        </div>
      )}

      <div className="bm-head">
        <div>
          <div className="d-eyebrow">Ideation</div>
          <h1 className="d-title">{collection.name}</h1>
          <p className="d-sub">
            Brainstorm board · {items.length} image{items.length === 1 ? "" : "s"}
            {uploading > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--accent)" }}>uploading {uploading}…</span>
              </>
            )}
          </p>
        </div>
      </div>

      {canEdit && (
        <label
          className="id-drop"
          onDragOver={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.add("drag");
          }}
          onDragLeave={(e) =>
            (e.currentTarget as HTMLElement).classList.remove("drag")
          }
          onDrop={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove("drag");
            if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
          }}
        >
          <span>
            Or <strong>drop images</strong> here / click to upload
          </span>
          <input
            type="file"
            multiple
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      )}

      {items.length > 0 && (
        <div className="id-toolbar">
          <input
            type="text"
            className="id-search"
            placeholder="Search title / notes / tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="id-toolbar-count">
            {filtered.length}{filtered.length !== items.length ? ` / ${items.length}` : ""}
          </span>
          {canEdit && (
            <button
              type="button"
              className="btn ghost sm id-delete-all"
              onClick={handleDeleteAll}
              disabled={deleteAllBusy}
              title="Delete every image on this ideation board"
            >
              {deleteAllBusy ? "Deleting…" : "🗑 Delete all"}
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="d-card id-empty">
          <p>
            <strong>Empty board.</strong>{" "}
            {canEdit
              ? "Paste a Pinterest URL above to get started, or drop reference images."
              : "Nothing to see yet."}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="d-card id-empty">
          <p>No images match &ldquo;{search}&rdquo;.</p>
        </div>
      ) : (
        <div className="id-grid">
          {filtered.map((it) => (
            <IdeationCard
              key={it.id}
              item={it}
              onOpen={() => setOpenItemId(it.id)}
            />
          ))}
        </div>
      )}

      {openItem && (
        <IdeationDetailDrawer
          item={openItem}
          canEdit={canEdit}
          onToast={onToast}
          onClose={() => setOpenItemId(null)}
        />
      )}
    </div>
  );
}

function IdeationCard({
  item,
  onOpen,
}: {
  item: CompetitorIdeationItem;
  onOpen: () => void;
}) {
  const userTags = (item.tags ?? []).filter((t) => !t.startsWith("pinterest:"));
  return (
    <button
      type="button"
      className="id-card2"
      onClick={onOpen}
      title={item.title ?? "Open"}
    >
      <div className="id-card2-image">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.imageUrl}
          alt={item.title ?? ""}
          loading="lazy"
          onError={(e) => {
            (e.currentTarget.style.opacity = "0.2");
          }}
        />
      </div>
      {(item.title || item.notes || userTags.length > 0) && (
        <div className="id-card2-info">
          {item.title && <div className="id-card2-title">{item.title}</div>}
          {item.notes && <p className="id-card2-notes">{item.notes}</p>}
          {userTags.length > 0 && (
            <div className="id-card2-tags">
              {userTags.slice(0, 4).map((t) => (
                <span key={t} className="id-card2-tag">
                  {t}
                </span>
              ))}
              {userTags.length > 4 && (
                <span className="id-card2-tag-more">+{userTags.length - 4}</span>
              )}
            </div>
          )}
        </div>
      )}
    </button>
  );
}
