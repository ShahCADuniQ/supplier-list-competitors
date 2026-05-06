"use client";

// Right-side slide-out for an ideation card. Mirrors ProductDetailDrawer's
// shape so the two views feel like the same app: full-size image preview
// at the top, editable notes / title in the body, and Delete in the header.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  updateIdeationItem,
  deleteIdeationItem,
  addIdeationItemExtraImage,
  removeIdeationItemExtraImage,
} from "./ideation-actions";
import { setIdeationItemProducts } from "./ideation-product-actions";
import { IDEATION_CATEGORIES } from "./IdeationBoard";
import type {
  CompetitorIdeationItem,
  IdeationProduct,
} from "@/db/schema";

type Props = {
  item: CompetitorIdeationItem;
  products: IdeationProduct[];
  linkedProductIds: number[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
  onClose: () => void;
};

// Tags can store sidecar metadata. We hide internal "pinterest:<url>" tags
// from the user but expose them as the source link.
function extractSourceUrl(tags: string[] | null | undefined): string | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t.startsWith("pinterest:")) return t.slice("pinterest:".length);
  }
  return null;
}
function userFacingTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return tags.filter((t) => !t.startsWith("pinterest:"));
}

export default function IdeationDetailDrawer({
  item,
  products,
  linkedProductIds,
  canEdit,
  onToast,
  onClose,
}: Props) {
  const router = useRouter();
  const [entered, setEntered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(userFacingTags(item.tags));
  const [kind, setKind] = useState<string>(item.kind);
  // Product linkage state — independent from item title/notes save flow.
  // When isGlobal is true, every product checkbox is ignored.
  const [isGlobal, setIsGlobal] = useState<boolean>(item.isGlobal ?? true);
  const [selectedProducts, setSelectedProducts] = useState<Set<number>>(
    () => new Set(linkedProductIds),
  );
  const sourceUrl = extractSourceUrl(item.tags);

  // ── Image carousel ────────────────────────────────────────────────────
  // Images = [cover, ...extras]. The cover (item.imageUrl) is index 0
  // and can't be deleted from the carousel — extras can. New uploads
  // append to the extras array via addIdeationItemExtraImage.
  const allImages = [item.imageUrl, ...(item.extraImageUrls ?? [])];
  const [imageIndex, setImageIndex] = useState(0);
  const [imageBusy, setImageBusy] = useState(false);
  const safeIndex = Math.min(imageIndex, allImages.length - 1);
  const currentImage = allImages[safeIndex] ?? item.imageUrl;
  const isCover = safeIndex === 0;

  function safeFileName(name: string) {
    return (
      name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file"
    );
  }

  async function handleAddImage(files: FileList | File[]) {
    if (!canEdit) return;
    setImageBusy(true);
    try {
      let added = 0;
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) {
          onToast(`${f.name} is not an image`, true);
          continue;
        }
        const pathname = `competitors/ideation/${item.collectionId}/${item.id}/extras/${crypto.randomUUID()}/${safeFileName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        await addIdeationItemExtraImage({
          itemId: item.id,
          url: blob.url,
          blobPathname: blob.pathname,
        });
        added++;
      }
      if (added > 0) {
        router.refresh();
        onToast(`Added ${added} image${added === 1 ? "" : "s"}`);
        // Jump to the last appended image so the user sees it immediately.
        setImageIndex(allImages.length + added - 1);
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Upload failed", true);
    } finally {
      setImageBusy(false);
    }
  }

  async function handleRemoveCurrentImage() {
    if (!canEdit || isCover || imageBusy) return;
    if (!confirm("Remove this image from the card?")) return;
    setImageBusy(true);
    try {
      // Cover is index 0, extras start at index 1 → 0 in the extras array.
      await removeIdeationItemExtraImage({
        itemId: item.id,
        index: safeIndex - 1,
      });
      router.refresh();
      onToast("Image removed");
      // Step back so we don't end up past the new array length.
      setImageIndex((i) => Math.max(0, i - 1));
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Remove failed", true);
    } finally {
      setImageBusy(false);
    }
  }

  function showPrev() {
    setImageIndex((i) => (i - 1 + allImages.length) % allImages.length);
  }
  function showNext() {
    setImageIndex((i) => (i + 1) % allImages.length);
  }

  // Local state mutates immediately for visual feedback. Persistence
  // happens on the single Save button at the top of the drawer (handleSave
  // below), which writes BOTH the item edits and the product linkage in
  // one transaction. No more silent auto-save — the user sees a clear
  // "Save" affordance and a "Saving…" indicator while it runs.
  function handleGlobalChange(next: boolean) {
    setIsGlobal(next);
  }

  function toggleProduct(id: number) {
    const next = new Set(selectedProducts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedProducts(next);
  }

  // Linkage dirty: separate from item-fields dirty. Used to enable Save
  // when only the product linkage changed.
  const linkageDirty =
    isGlobal !== (item.isGlobal ?? true) ||
    Array.from(selectedProducts)
      .map((n) => Number(n))
      .sort((a, b) => a - b)
      .join(",") !==
      [...linkedProductIds]
        .map((n) => Number(n))
        .sort((a, b) => a - b)
        .join(",");

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

  // Has the user changed anything? Used to enable Save. Includes both
  // item-level edits and product linkage so a single Save persists
  // everything together.
  const dirty =
    title !== (item.title ?? "") ||
    notes !== (item.notes ?? "") ||
    kind !== item.kind ||
    JSON.stringify(tags) !== JSON.stringify(userFacingTags(item.tags)) ||
    linkageDirty;

  async function handleSave() {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      // Re-attach internal tags (pinterest source) so we don't lose them.
      const internal = (item.tags ?? []).filter((t) =>
        t.startsWith("pinterest:"),
      );
      // Sequential, not Promise.all: both actions write to
      // competitor_ideation_items and parallel writes against the same
      // row from the same Drizzle/neon-serverless connection were the
      // source of intermittent "another error" toasts. Doing one then
      // the other avoids the race entirely.
      await updateIdeationItem({
        id: item.id,
        title: title.trim() || null,
        notes: notes.trim() || null,
        kind,
        tags: [...internal, ...tags],
      });
      await setIdeationItemProducts({
        itemId: item.id,
        isGlobal,
        productIds: isGlobal ? [] : Array.from(selectedProducts),
      });
      router.refresh();
      onToast("Saved");
    } catch (e) {
      console.error("[IdeationDetailDrawer] save failed:", e);
      onToast(e instanceof Error ? e.message : "Save failed", true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!canEdit || deleting) return;
    if (!confirm("Delete this image from the board?")) return;
    setDeleting(true);
    try {
      await deleteIdeationItem(item.id);
      router.refresh();
      onToast("Deleted");
      requestClose();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Delete failed", true);
      setDeleting(false);
    }
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setTagInput("");
      return;
    }
    setTags([...tags, t]);
    setTagInput("");
  }
  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t));
  }

  return (
    <div
      className={`pd-overlay${entered ? " entered" : ""}`}
      role="dialog"
      aria-modal="true"
      // Higher z-index than the IdeationProductDrawer (.pd-overlay defaults
      // to 900) so when the user opens this drawer from a thumbnail inside
      // the product drawer, it stacks on top correctly. Both drawers are
      // siblings in IdeationBoard's tree but JSX source order puts this
      // one first, which would otherwise paint it underneath.
      style={{ zIndex: 950 }}
      // Backdrop click-to-close removed: user reported losing in-progress
      // edits when they accidentally clicked outside the drawer. Use the
      // ✕ button or Esc to close.
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
          <div className="pd-title">
            <div className="pd-brand">Ideation</div>
            {canEdit ? (
              <input
                className="pd-name-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional)"
                disabled={saving}
              />
            ) : (
              <h2 className="pd-name">{item.title || "Untitled"}</h2>
            )}
          </div>
          {canEdit && (
            <div className="pd-head-actions">
              <button
                type="button"
                className="btn primary sm"
                onClick={handleSave}
                disabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn sm pd-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "🗑 Delete"}
              </button>
            </div>
          )}
        </header>

        <div className="pd-body">
          <section className="pd-section">
            <div className="id-drawer-image" style={{ position: "relative" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={currentImage}
                src={currentImage}
                alt={item.title ?? ""}
                loading="eager"
                onError={(e) => {
                  (e.currentTarget.style.opacity = "0.2");
                }}
              />
              {allImages.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={showPrev}
                    aria-label="Previous image"
                    title="Previous"
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: 12,
                      transform: "translateY(-50%)",
                      width: 40,
                      height: 40,
                      borderRadius: 9999,
                      background: "rgba(15,23,42,0.7)",
                      border: "1px solid rgba(255,255,255,0.24)",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: 18,
                      lineHeight: 1,
                      padding: 0,
                      fontFamily: "inherit",
                    }}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={showNext}
                    aria-label="Next image"
                    title="Next"
                    style={{
                      position: "absolute",
                      top: "50%",
                      right: 12,
                      transform: "translateY(-50%)",
                      width: 40,
                      height: 40,
                      borderRadius: 9999,
                      background: "rgba(15,23,42,0.7)",
                      border: "1px solid rgba(255,255,255,0.24)",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: 18,
                      lineHeight: 1,
                      padding: 0,
                      fontFamily: "inherit",
                    }}
                  >
                    ›
                  </button>
                  <span
                    style={{
                      position: "absolute",
                      bottom: 12,
                      left: "50%",
                      transform: "translateX(-50%)",
                      padding: "4px 10px",
                      borderRadius: 9999,
                      background: "rgba(15,23,42,0.78)",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {safeIndex + 1} / {allImages.length}
                    {isCover && (
                      <span style={{ opacity: 0.7, marginLeft: 6 }}>· cover</span>
                    )}
                  </span>
                </>
              )}
            </div>
            {canEdit && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <label
                  className="btn primary sm"
                  style={{
                    cursor: imageBusy ? "not-allowed" : "pointer",
                    opacity: imageBusy ? 0.6 : 1,
                  }}
                  title="Upload one or more images to this card"
                >
                  {imageBusy ? "Uploading…" : "+ Add picture"}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    disabled={imageBusy}
                    onChange={(e) => {
                      if (e.target.files?.length) handleAddImage(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                {!isCover && (
                  <button
                    type="button"
                    className="btn sm pd-danger"
                    onClick={handleRemoveCurrentImage}
                    disabled={imageBusy}
                    title="Remove this image (cover image cannot be removed)"
                  >
                    🗑 Remove this image
                  </button>
                )}
                {isCover && allImages.length > 1 && (
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-2)",
                    }}
                  >
                    The cover image can&apos;t be removed individually — delete
                    the whole card to remove it.
                  </span>
                )}
              </div>
            )}
          </section>

          <section className="pd-section">
            <h3 className="pd-section-h">Category</h3>
            {canEdit ? (
              <select
                className="id-drawer-cat-select"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                disabled={saving}
              >
                {IDEATION_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="id-drawer-cat-readonly">
                {IDEATION_CATEGORIES.find((c) => c.key === kind)?.label ?? kind}
              </div>
            )}
          </section>

          <section className="pd-section">
            <h3 className="pd-section-h">Products</h3>
            {/* Apply-to-all toggle */}
            <label className="id-drawer-global-toggle">
              <input
                type="checkbox"
                checked={isGlobal}
                onChange={(e) => handleGlobalChange(e.target.checked)}
                disabled={!canEdit || saving}
              />
              <span>
                <strong>Apply to all products</strong>
                <span className="id-drawer-global-hint">
                  {" "}
                  — this idea shows up under every product pill.
                </span>
              </span>
            </label>
            {/* Per-product checkboxes */}
            {!isGlobal && (
              <div className="id-drawer-products">
                {products.length === 0 ? (
                  <p className="pd-spec-empty" style={{ margin: "8px 0 0" }}>
                    No products in this collection yet — add one from the
                    Ideation board.
                  </p>
                ) : (
                  products.map((p) => {
                    const checked = selectedProducts.has(p.id);
                    return (
                      <label
                        key={p.id}
                        className="id-drawer-product-row"
                        data-checked={checked}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProduct(p.id)}
                          disabled={!canEdit || saving}
                        />
                        <span
                          className="id-drawer-product-dot"
                          style={{ background: p.color }}
                          aria-hidden
                        />
                        <span className="id-drawer-product-name">{p.name}</span>
                        {p.description && (
                          <span className="id-drawer-product-desc">
                            {p.description}
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            )}
          </section>

          <section className="pd-section">
            <h3 className="pd-section-h">Notes</h3>
            <textarea
              className="id-drawer-notes"
              rows={6}
              placeholder={
                canEdit
                  ? "What do you like about this? Mounting, finish, scale, palette…"
                  : "(no notes)"
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              readOnly={!canEdit}
              disabled={saving}
            />
          </section>

          <section className="pd-section">
            <h3 className="pd-section-h">Tags</h3>
            <div className="id-drawer-tags">
              {tags.length === 0 && !canEdit && (
                <span className="pd-spec-empty">— no tags —</span>
              )}
              {tags.map((t) => (
                <span key={t} className="id-drawer-tag">
                  {t}
                  {canEdit && (
                    <button
                      type="button"
                      className="id-drawer-tag-rm"
                      onClick={() => removeTag(t)}
                      aria-label={`Remove ${t}`}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEdit && (
              <div className="id-drawer-tag-input">
                <input
                  type="text"
                  placeholder="Add a tag — e.g. mounting, brass, asymmetric"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={addTag}
                  disabled={!tagInput.trim()}
                >
                  Add
                </button>
              </div>
            )}
          </section>

          {sourceUrl && (
            <section className="pd-section">
              <h3 className="pd-section-h">Source</h3>
              <a
                className="pd-source"
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on Pinterest ↗
              </a>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
