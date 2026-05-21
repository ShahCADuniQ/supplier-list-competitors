"use client";

// "About Us" tab on the approved-supplier portal. Lets the supplier keep
// the company information they originally submitted at onboarding up to
// date — company name, contact, phone, website, country, category,
// sub-category, products — plus the categorised file attachments.
// Edits flow through updateSupplierShopInfo + the supplier-self
// attachment actions, the same code paths step-2 onboarding uses; the
// server-side lock check in updateSupplierShopInfo permits self-edits
// while the row is approved (it only blocks during "submitted" review).

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addSupplierOnboardingAttachment,
  deleteSupplierOnboardingAttachment,
  deleteSupplierOnboardingCustomSection,
  updateSupplierShopInfo,
  type OnboardingAttachmentRow,
} from "@/app/suppliers/onboarding-actions";
import { SUPPLIER_CATEGORIES } from "@/app/suppliers/supplier-inventory-constants";
import {
  SUPPLIER_ATTACHMENT_CATEGORIES,
  CUSTOM_SECTION_META,
  customCatLabel,
  customCatSlug,
  listCustomSectionIds,
} from "@/app/suppliers/supplier-attachment-categories";

// Canonical sections + custom sections (derived from attachments +
// transient drafts) are computed inside AboutUsAttachments. The shared
// constants in supplier-attachment-categories.ts drive the canonical
// 8 entries; the engineering admin's AttachmentsTab uses the same
// constants so anything uploaded here appears under the matching
// section there automatically.

function safeBlobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
}

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--lb-text-3)",
  marginBottom: 4,
};
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 14,
  border: "1px solid var(--lb-border)",
  borderRadius: 8,
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  outline: "none",
};
const PANEL_STYLE: React.CSSProperties = {
  background: "var(--lb-bg-elev)",
  border: "1px solid var(--lb-border)",
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};
const H2_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "var(--lb-accent)",
  marginBottom: 14,
  paddingBottom: 8,
  borderBottom: "1px solid var(--lb-border)",
};

export type AboutUsShop = {
  companyName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  subCategory: string | null;
  origin: string | null;
  products: string | null;
  invitingClientName: string | null;
};

export default function AboutUsTab({
  supplierId,
  shop,
  existingAttachments,
}: {
  supplierId: number;
  shop: AboutUsShop;
  existingAttachments: OnboardingAttachmentRow[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <header
        style={{
          padding: 18,
          borderRadius: 12,
          background:
            "linear-gradient(135deg, rgba(8,145,178,0.10), rgba(124,58,237,0.06))",
          border: "1px solid var(--lb-border)",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "var(--lb-text-3)",
          }}
        >
          About us
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: "4px 0 4px" }}>
          Your company profile
        </h2>
        <p style={{ fontSize: 13, color: "var(--lb-text-2)", margin: 0, maxWidth: 720 }}>
          Everything you submitted at onboarding stays editable here. Keep your
          contact, capabilities, and supporting documents current so the
          retailer always sees the right version of you.
        </p>
      </header>

      <ShopInfoEditor supplierId={supplierId} shop={shop} />

      <section style={PANEL_STYLE}>
        <h3 style={H2_STYLE}>Supporting documents</h3>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--lb-text-3)",
            marginTop: -8,
            marginBottom: 14,
          }}
        >
          Upload datasheets, certifications, contracts, photos, or anything
          else worth keeping on file. Files sit on your supplier profile and
          appear under the matching category for the retailer.
        </p>
        <AboutUsAttachments supplierId={supplierId} initial={existingAttachments} />
      </section>
    </div>
  );
}

function ShopInfoEditor({
  supplierId,
  shop,
}: {
  supplierId: number;
  shop: AboutUsShop;
}) {
  const [companyName, setCompanyName] = useState(shop.companyName);
  const [contactName, setContactName] = useState(shop.contactName ?? "");
  const [phone, setPhone] = useState(shop.phone ?? "");
  const [website, setWebsite] = useState(shop.website ?? "");
  const [origin, setOrigin] = useState(shop.origin ?? "");
  const [category, setCategory] = useState(shop.category ?? "");
  const [subCategory, setSubCategory] = useState(shop.subCategory ?? "");
  const [products, setProducts] = useState(shop.products ?? "");

  const [changeRetailer, setChangeRetailer] = useState(false);
  const [retailerEmail, setRetailerEmail] = useState("");

  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  function save() {
    if (pending) return;
    setErr(null);
    if (!companyName.trim()) {
      setErr("Company name is required");
      return;
    }
    if (changeRetailer && !retailerEmail.trim()) {
      setErr("Enter the new retailer's email or cancel the change.");
      return;
    }
    startTransition(async () => {
      try {
        // Manufacturing capabilities, materials, and the buy-&-sell flag
        // are not surfaced on this tab anymore — omitting them from the
        // payload preserves whatever was previously stored on the row.
        await updateSupplierShopInfo({
          supplierId,
          companyName,
          contactName: contactName || null,
          phone: phone || null,
          website: website || null,
          category: category || null,
          subCategory: subCategory || null,
          origin: origin || null,
          products: products || null,
          ...(changeRetailer
            ? { newEngineeringCompanyEmail: retailerEmail }
            : {}),
        });
        setSavedAt(new Date());
        if (changeRetailer) {
          // The retailer link affects a lot of derived UI; reload to pick
          // up the new tenant name everywhere.
          window.location.reload();
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't save changes");
      }
    });
  }

  // Clear the saved-confirmation after a short delay so it doesn't sit
  // around staring at the user forever.
  const savedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!savedAt) return;
    if (savedRef.current) window.clearTimeout(savedRef.current);
    savedRef.current = window.setTimeout(() => setSavedAt(null), 4000);
    return () => {
      if (savedRef.current) window.clearTimeout(savedRef.current);
    };
  }, [savedAt]);

  return (
    <section style={PANEL_STYLE}>
      <h3 style={H2_STYLE}>Company information</h3>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <Field label="Company name *">
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            style={INPUT_STYLE}
          />
        </Field>
        <Field label="Primary contact">
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            style={INPUT_STYLE}
            placeholder="Jane Smith, Sales Director"
          />
        </Field>
        <Field label="Email">
          <input
            value={shop.email ?? ""}
            disabled
            style={{ ...INPUT_STYLE, opacity: 0.6 }}
            title="Email is tied to your sign-in account."
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={INPUT_STYLE}
            placeholder="+1 …"
          />
        </Field>
        <Field label="Website">
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            style={INPUT_STYLE}
            placeholder="https://"
          />
        </Field>
        <Field label="Country of operation">
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            style={INPUT_STYLE}
            placeholder="Canada / United States / China …"
          />
        </Field>
        <Field label="Primary capability">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="">— select —</option>
            {SUPPLIER_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sub-category / specialty">
          <input
            value={subCategory}
            onChange={(e) => setSubCategory(e.target.value)}
            style={INPUT_STYLE}
            placeholder="e.g. aluminum extrusion, 0-10V drivers …"
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label="Products / services you offer">
          <textarea
            value={products}
            onChange={(e) => setProducts(e.target.value)}
            placeholder="One per line."
            style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
          />
        </Field>
      </div>

      <div
        style={{
          marginTop: 18,
          padding: 14,
          borderRadius: 10,
          background: "var(--lb-bg)",
          border: "1px solid var(--lb-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={FIELD_LABEL}>Currently linked to retailer</div>
            <div style={{ fontSize: 14, color: "var(--lb-text)", marginTop: 2 }}>
              {shop.invitingClientName ?? "(no retailer linked)"}
            </div>
          </div>
          {!changeRetailer ? (
            <button
              type="button"
              onClick={() => setChangeRetailer(true)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text-2)",
                cursor: "pointer",
              }}
            >
              Change retailer
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setChangeRetailer(false);
                setRetailerEmail("");
              }}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 999,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text-2)",
                cursor: "pointer",
              }}
            >
              Keep current
            </button>
          )}
        </div>
        {changeRetailer && (
          <div style={{ marginTop: 10 }}>
            <Field label="New retailer email *">
              <input
                type="email"
                value={retailerEmail}
                onChange={(e) => setRetailerEmail(e.target.value)}
                placeholder="e.g. contact@acmelighting.com"
                style={INPUT_STYLE}
              />
            </Field>
            <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: -6 }}>
              The new email must belong to a retailer that already has a
              CADuniQ account. We&apos;ll re-validate before saving and
              re-route your profile to their tenant.
            </div>
          </div>
        )}
      </div>

      {err && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            background: "rgba(220,38,38,0.10)",
            border: "1px solid rgba(220,38,38,0.40)",
            color: "#dc2626",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          display: "flex",
          gap: 10,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {savedAt && (
          <span style={{ fontSize: 12, color: "#059669", fontWeight: 700 }}>
            ✓ Saved at {savedAt.toLocaleTimeString()}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={pending}
          style={{
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 700,
            borderRadius: 999,
            background: "var(--lb-accent)",
            border: "1px solid var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={FIELD_LABEL}>{label}</div>
      {children}
    </label>
  );
}

function AboutUsAttachments({
  supplierId,
  initial,
}: {
  supplierId: number;
  initial: OnboardingAttachmentRow[];
}) {
  const [items, setItems] = useState<OnboardingAttachmentRow[]>(initial);
  const [busyCat, setBusyCat] = useState<string | null>(null);
  const [attErr, setAttErr] = useState<string | null>(null);
  const [draftSections, setDraftSections] = useState<string[]>([]);

  const persistedCustomIds = useMemo(
    () => listCustomSectionIds(items.map((a) => a.catId)),
    [items],
  );

  const customCats = useMemo(() => {
    const seen = new Set<string>(persistedCustomIds);
    const out: { id: string; label: string; isDraft: boolean }[] = persistedCustomIds.map(
      (id) => ({ id, label: customCatLabel(id), isDraft: false }),
    );
    for (const d of draftSections) {
      const slug = customCatSlug(d);
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        out.push({ id: slug, label: d, isDraft: true });
      }
    }
    return out;
  }, [persistedCustomIds, draftSections]);

  useEffect(() => {
    if (draftSections.length === 0) return;
    const persistedSlugs = new Set(persistedCustomIds);
    const stillDrafts = draftSections.filter(
      (d) => !persistedSlugs.has(customCatSlug(d)),
    );
    if (stillDrafts.length !== draftSections.length) {
      setDraftSections(stillDrafts);
    }
  }, [persistedCustomIds, draftSections]);

  const allCats = useMemo(() => [
    ...SUPPLIER_ATTACHMENT_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      color: c.color,
      desc: c.desc,
      deletable: false,
      isDraft: false,
    })),
    ...customCats.map((c) => ({
      id: c.id,
      label: c.label,
      icon: CUSTOM_SECTION_META.icon,
      color: CUSTOM_SECTION_META.color,
      desc: c.isDraft
        ? "Custom section (waiting for first upload)"
        : "Custom section",
      deletable: true,
      isDraft: c.isDraft,
    })),
  ], [customCats]);

  async function handleDeleteSection(catId: string, label: string, isDraft: boolean, fileCount: number) {
    if (isDraft) {
      setDraftSections((prev) =>
        prev.filter((d) => customCatSlug(d) !== catId),
      );
      return;
    }
    const msg = fileCount > 0
      ? `Delete the "${label}" section and the ${fileCount} file${fileCount === 1 ? "" : "s"} inside? This can't be undone.`
      : `Delete the "${label}" section?`;
    if (!window.confirm(msg)) return;
    setAttErr(null);
    try {
      await deleteSupplierOnboardingCustomSection({ supplierId, catId });
      setItems((prev) => prev.filter((a) => a.catId !== catId));
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Section delete failed");
    }
  }

  const byCat = useMemo(() => {
    const map: Record<string, OnboardingAttachmentRow[]> = {};
    for (const c of allCats) map[c.id] = [];
    for (const a of items) {
      if (map[a.catId]) map[a.catId].push(a);
      else map[a.catId] = [a];
    }
    return map;
  }, [items, allCats]);

  function addCustomSection() {
    const raw = window.prompt("Name this section (e.g. Warranty docs, Installation guides):");
    const name = (raw ?? "").trim();
    if (!name) return;
    if (name.length > 80) {
      setAttErr("Section names must be 80 characters or fewer.");
      return;
    }
    const slug = customCatSlug(name);
    if (!slug) return;
    if (customCats.some((c) => c.id === slug)) return;
    setDraftSections((prev) => [...prev, name]);
  }

  async function handleUpload(catId: string, files: FileList | File[]) {
    setAttErr(null);
    setBusyCat(catId);
    try {
      for (const f of Array.from(files)) {
        const pathname = `suppliers/${supplierId}/${catId}/${safeBlobName(f.name)}`;
        const blob = await upload(pathname, f, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: f.type || undefined,
        });
        const res = await addSupplierOnboardingAttachment({
          supplierId,
          catId,
          name: f.name,
          size: f.size,
          mimeType: f.type || null,
          url: blob.url,
          blobPathname: blob.pathname,
        });
        setItems((prev) => [
          {
            id: res.id,
            catId,
            name: f.name,
            size: f.size,
            mimeType: f.type || null,
            url: blob.url,
            createdAt: new Date(),
            uploader: null,
          },
          ...prev,
        ]);
      }
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyCat(null);
    }
  }

  async function handleDelete(attachmentId: number, name: string) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    setAttErr(null);
    try {
      await deleteSupplierOnboardingAttachment({ supplierId, attachmentId });
      setItems((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (e) {
      setAttErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      {attErr && (
        <div
          style={{
            padding: 10,
            marginBottom: 10,
            borderRadius: 8,
            background: "rgba(220,38,38,0.10)",
            border: "1px solid rgba(220,38,38,0.40)",
            color: "#dc2626",
            fontSize: 12.5,
          }}
        >
          {attErr}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {allCats.map((cat) => {
          const list = byCat[cat.id] ?? [];
          const busy = busyCat === cat.id;
          return (
            <div
              key={cat.id}
              style={{
                borderRadius: 10,
                border: "1px solid var(--lb-border)",
                background: "var(--lb-bg)",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      display: "grid",
                      placeItems: "center",
                      background: `${cat.color}22`,
                      color: cat.color,
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {cat.icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: "var(--lb-text)",
                      }}
                    >
                      {cat.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--lb-text-3)",
                        marginTop: 1,
                      }}
                    >
                      {cat.desc}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: list.length > 0 ? `${cat.color}1a` : "var(--lb-bg-elev)",
                      color: list.length > 0 ? cat.color : "var(--lb-text-3)",
                      border: "1px solid var(--lb-border)",
                    }}
                  >
                    {list.length}
                  </span>
                  <label
                    style={{
                      padding: "5px 12px",
                      fontSize: 12,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: "var(--lb-bg-elev)",
                      border: "1px solid var(--lb-border)",
                      color: busy ? "var(--lb-text-3)" : "var(--lb-text)",
                      cursor: busy ? "wait" : "pointer",
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {busy ? "Uploading…" : "+ Add"}
                    <input
                      type="file"
                      multiple
                      disabled={busy}
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleUpload(cat.id, e.target.files);
                        }
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {cat.deletable && (
                    <button
                      type="button"
                      title="Delete section"
                      onClick={() =>
                        handleDeleteSection(cat.id, cat.label, cat.isDraft, list.length)
                      }
                      style={{
                        padding: "5px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        borderRadius: 999,
                        background: "var(--lb-bg-elev)",
                        border: "1px solid var(--lb-border)",
                        color: "#dc2626",
                        cursor: "pointer",
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>

              {list.length === 0 ? (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: "var(--lb-text-3)",
                    fontStyle: "italic",
                  }}
                >
                  No files in this category yet.
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "10px 0 0",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {list.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "var(--lb-bg-elev)",
                        border: "1px solid var(--lb-border)",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--lb-text)",
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={a.name}
                        >
                          {a.name}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 1 }}>
                          {fmtBytes(a.size)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {a.url && (
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              padding: "4px 10px",
                              fontSize: 12,
                              fontWeight: 600,
                              borderRadius: 999,
                              color: "var(--lb-text-2)",
                              background: "var(--lb-bg)",
                              border: "1px solid var(--lb-border)",
                              textDecoration: "none",
                            }}
                          >
                            View
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(a.id, a.name)}
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            fontWeight: 600,
                            borderRadius: 999,
                            color: "#dc2626",
                            background: "var(--lb-bg)",
                            border: "1px solid var(--lb-border)",
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={addCustomSection}
          style={{
            marginTop: 4,
            padding: "10px 14px",
            fontSize: 12.5,
            fontWeight: 600,
            borderRadius: 10,
            border: "1px dashed var(--lb-border)",
            background: "transparent",
            color: "var(--lb-text-2)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          + Add section
        </button>
      </div>
    </div>
  );
}
