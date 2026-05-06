"use client";

// Right-side slide-out for an ideation card. Mirrors ProductDetailDrawer's
// shape so the two views feel like the same app: full-size image preview
// at the top, editable notes / title in the body, and Delete in the header.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  updateIdeationItem,
  deleteIdeationItem,
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
      // Persist item-level fields + product linkage in parallel. Either
      // can throw individually; we surface whichever message arrives.
      await Promise.all([
        updateIdeationItem({
          id: item.id,
          title: title.trim() || null,
          notes: notes.trim() || null,
          kind,
          tags: [...internal, ...tags],
        }),
        setIdeationItemProducts({
          itemId: item.id,
          isGlobal,
          productIds: isGlobal ? [] : Array.from(selectedProducts),
        }),
      ]);
      router.refresh();
      onToast("Saved");
    } catch (e) {
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
          <section className="pd-section id-drawer-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.imageUrl}
              alt={item.title ?? ""}
              loading="eager"
              onError={(e) => {
                (e.currentTarget.style.opacity = "0.2");
              }}
            />
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
