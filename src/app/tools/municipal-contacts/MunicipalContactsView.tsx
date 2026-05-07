"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MunicipalitySearch,
  MunicipalityContact,
} from "@/db/schema";
import {
  CANADIAN_PROVINCES,
  SCOPE_TYPES,
  SECTOR_OPTIONS,
  CONTACT_CATEGORIES,
  COUNT_OPTIONS,
  COUNT_MIN,
  COUNT_MAX,
  categoryLabel,
  sectorLabel,
} from "./constants";
import {
  generateMunicipalContacts,
  deleteMunicipalitySearch,
  deleteMunicipalityContact,
  deleteContactsByCategory,
  exportToHubspot,
} from "./actions";

type Props = {
  searches: MunicipalitySearch[];
  contacts: MunicipalityContact[];
  canEdit: boolean;
};

export default function MunicipalContactsView({
  searches,
  contacts,
  canEdit,
}: Props) {
  const router = useRouter();

  // ── Form state ──
  const [province, setProvince] = useState("Quebec");
  const [scopeTypes, setScopeTypes] = useState<string[]>([]); // [] = all
  // Default to engineering — the user's original use-case. Empty list = all.
  const [sectors, setSectors] = useState<string[]>(["engineering"]);
  const [cityFilter, setCityFilter] = useState("");
  const [count, setCount] = useState<number>(25);
  const [title, setTitle] = useState("");

  // ── Generation state ──
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Active search the user is viewing (defaults to the most recent).
  const [activeSearchId, setActiveSearchId] = useState<number | null>(
    searches[0]?.id ?? null,
  );
  // Per-card category filter for the contacts panel.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const contactsBySearch = useMemo(() => {
    const m = new Map<number, MunicipalityContact[]>();
    for (const c of contacts) {
      const list = m.get(c.searchId) ?? [];
      list.push(c);
      m.set(c.searchId, list);
    }
    return m;
  }, [contacts]);

  const activeSearch = useMemo(
    () => searches.find((s) => s.id === activeSearchId) ?? null,
    [searches, activeSearchId],
  );
  const activeContacts = useMemo(() => {
    if (!activeSearchId) return [];
    const list = contactsBySearch.get(activeSearchId) ?? [];
    if (!categoryFilter) return list;
    return list.filter((c) => c.category === categoryFilter);
  }, [contactsBySearch, activeSearchId, categoryFilter]);

  // ── Group active contacts by municipality so the user sees one card per town ──
  const activeContactsByMunicipality = useMemo(() => {
    const groups = new Map<string, MunicipalityContact[]>();
    for (const c of activeContacts) {
      const key = c.municipalityName || "Unknown";
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeContacts]);

  function showToast(msg: string, err?: boolean) {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4500);
  }

  function toggleScope(code: string) {
    setScopeTypes((s) =>
      s.includes(code) ? s.filter((x) => x !== code) : [...s, code],
    );
  }

  function toggleSector(code: string) {
    setSectors((s) =>
      s.includes(code) ? s.filter((x) => x !== code) : [...s, code],
    );
  }

  async function handleGenerate() {
    if (!canEdit) {
      showToast("You don't have permission to generate.", true);
      return;
    }
    setBusy(true);
    showToast(`Researching ${count} contacts in ${province}…`);
    try {
      const r = await generateMunicipalContacts({
        province,
        scopeTypes,
        sectors,
        cityFilter: cityFilter.trim() || null,
        count,
        title: title.trim() || null,
      });
      // The action returns the error as data so we get the real message
      // (Next sanitizes thrown errors in production).
      if (!r.ok) {
        const msg = r.error || "Generation failed";
        console.error("[municipal-contacts] action error:", msg, r.stack);
        showToast(msg, true);
        return;
      }
      showToast(`Generated ${r.contactCount} contact${r.contactCount === 1 ? "" : "s"}`);
      setActiveSearchId(r.searchId);
      setCategoryFilter(null);
      router.refresh();
    } catch (e) {
      // Should be rare now — only client-side / network errors land here.
      showToast(e instanceof Error ? e.message : "Generation failed", true);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSearch(id: number) {
    if (!canEdit) return;
    if (
      !confirm(
        "Delete this search and all its contacts? This can't be undone.",
      )
    ) {
      return;
    }
    try {
      await deleteMunicipalitySearch(id);
      if (activeSearchId === id) {
        setActiveSearchId(searches.find((s) => s.id !== id)?.id ?? null);
      }
      router.refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Delete failed", true);
    }
  }

  async function handleDeleteContact(id: number) {
    if (!canEdit) return;
    try {
      await deleteMunicipalityContact(id);
      router.refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Delete failed", true);
    }
  }

  async function handleRemoveCategory(categoryCode: string, count: number) {
    if (!canEdit || !activeSearch) return;
    const label =
      CONTACT_CATEGORIES.find((c) => c.code === categoryCode)?.label ??
      categoryCode;
    if (
      !confirm(
        `Remove all ${count} "${label}" contact${count === 1 ? "" : "s"} from this directory? This can't be undone.`,
      )
    ) {
      return;
    }
    try {
      const r = await deleteContactsByCategory({
        searchId: activeSearch.id,
        category: categoryCode,
      });
      if (categoryFilter === categoryCode) setCategoryFilter(null);
      showToast(`Removed ${r.deleted} ${label} contact${r.deleted === 1 ? "" : "s"}`);
      router.refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Remove failed", true);
    }
  }

  function exportCsv() {
    if (!activeSearch || !activeContacts.length) return;
    const rows = [
      [
        "Municipality",
        "Type",
        "Province",
        "Department",
        "Role",
        "Category",
        "Name",
        "Email",
        "Phone",
        "Address",
        "Website",
        "Source",
        "Notes",
      ],
      ...activeContacts.map((c) => [
        c.municipalityName,
        c.municipalityType ?? "",
        c.province,
        c.department ?? "",
        c.role ?? "",
        categoryLabel(c.category),
        c.name ?? "",
        c.email ?? "",
        c.phone ?? "",
        c.address ?? "",
        c.website ?? "",
        c.sourceUrl ?? "",
        c.notes ?? "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `municipal-contacts-${activeSearch.province}-${activeSearch.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Per-category counts for the active search (for filter chips).
  const categoryCounts = useMemo(() => {
    if (!activeSearchId) return new Map<string, number>();
    const list = contactsBySearch.get(activeSearchId) ?? [];
    const m = new Map<string, number>();
    for (const c of list) {
      const k = c.category ?? "other";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [activeSearchId, contactsBySearch]);

  // Export-status counters for the active search (drives the smart HubSpot
  // button label).
  const exportCounts = useMemo(() => {
    if (!activeSearchId) return { total: 0, exported: 0, notExported: 0 };
    const list = contactsBySearch.get(activeSearchId) ?? [];
    let exported = 0;
    for (const c of list) if (c.exportedAt) exported++;
    return {
      total: list.length,
      exported,
      notExported: list.length - exported,
    };
  }, [activeSearchId, contactsBySearch]);

  const [exportBusy, setExportBusy] = useState(false);

  async function handleHubspotExport(mode: "new" | "all" | "everything") {
    if (!activeSearch) return;
    setExportBusy(true);
    try {
      const r = await exportToHubspot({ searchId: activeSearch.id, mode });
      if (r.exportedCount === 0) {
        showToast("Nothing to export", false);
        return;
      }
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`Exported ${r.exportedCount} contact${r.exportedCount === 1 ? "" : "s"} for HubSpot`);
      router.refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Export failed", true);
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="mc-wrap">
      {/* Header */}
      <header className="mc-header">
        <div>
          <div className="mc-eyebrow">Tools · Canada</div>
          <h1 className="mc-title">Municipal Contacts</h1>
          <p className="mc-sub">
            Generate engineering and administration contacts for any Canadian
            province. Perplexity researches public directories, Claude
            normalizes the records into clean categories.
          </p>
        </div>
      </header>

      {/* Generator form — three clear stages: Where → What → How many. */}
      <section className="mc-form">
        {/* Stage 1: Where to research */}
        <div className="mc-stage">
          <div className="mc-stage-head">
            <span className="mc-stage-num">1</span>
            <h3 className="mc-stage-title">Where to research</h3>
          </div>
          <div className="mc-row mc-row-12">
            <label className="mc-field" style={{ gridColumn: "span 3" }}>
              <span className="mc-label">Province</span>
              <select
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                disabled={busy}
                className="mc-input"
              >
                {CANADIAN_PROVINCES.map((p) => (
                  <option key={p.code} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="mc-field" style={{ gridColumn: "span 5" }}>
              <span className="mc-label">
                Specific municipality
                <span className="mc-optional">optional</span>
              </span>
              <input
                type="text"
                value={cityFilter}
                onChange={(e) => setCityFilter(e.target.value)}
                disabled={busy}
                placeholder="e.g. Saint-Hyacinthe, Mont-Tremblant"
                className="mc-input"
              />
              <span className="mc-hint">
                Restricts to that town and its neighbours — leave blank for province-wide
              </span>
            </label>

            <div className="mc-field" style={{ gridColumn: "span 4" }}>
              <span className="mc-label">
                Scope
                <span className="mc-optional">all if empty</span>
              </span>
              <div className="mc-pills">
                {SCOPE_TYPES.map((s) => {
                  const active = scopeTypes.includes(s.code);
                  return (
                    <button
                      key={s.code}
                      type="button"
                      className={`mc-pill ${active ? "mc-pill-on" : ""}`}
                      onClick={() => toggleScope(s.code)}
                      disabled={busy}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Stage 2: What to find — sectors get a full row of their own */}
        <div className="mc-stage">
          <div className="mc-stage-head">
            <span className="mc-stage-num">2</span>
            <h3 className="mc-stage-title">What to find</h3>
            {sectors.length > 0 && (
              <button
                type="button"
                className="mc-stage-action"
                onClick={() => setSectors([])}
                disabled={busy}
                title="Clear all — return contacts from any sector"
              >
                Clear · all sectors
              </button>
            )}
          </div>
          <div className="mc-pills mc-pills-sectors">
            {SECTOR_OPTIONS.map((s) => {
              const active = sectors.includes(s.code);
              return (
                <button
                  key={s.code}
                  type="button"
                  className={`mc-pill mc-pill-cat-${s.code} ${active ? "mc-pill-on" : ""}`}
                  onClick={() => toggleSector(s.code)}
                  disabled={busy}
                  title={s.promptHint}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="mc-hint mc-hint-block">
            Restricts the research to these departments. Pick none to let it return contacts from any sector.
          </p>
        </div>

        {/* Stage 3: How many + label */}
        <div className="mc-stage">
          <div className="mc-stage-head">
            <span className="mc-stage-num">3</span>
            <h3 className="mc-stage-title">How many</h3>
          </div>
          <div className="mc-row mc-row-12">
            <div className="mc-field" style={{ gridColumn: "span 6" }}>
              <span className="mc-label">Quantity</span>
              <div className="mc-count-row">
                <input
                  type="number"
                  inputMode="numeric"
                  min={COUNT_MIN}
                  max={COUNT_MAX}
                  value={count}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setCount(n);
                    else if (e.target.value === "") setCount(COUNT_MIN);
                  }}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!Number.isFinite(n) || n < COUNT_MIN) setCount(COUNT_MIN);
                    else if (n > COUNT_MAX) setCount(COUNT_MAX);
                  }}
                  disabled={busy}
                  className="mc-input mc-count-input"
                  aria-label="Quantity"
                />
                <div className="mc-pills mc-pills-tight">
                  {COUNT_OPTIONS.map((n) => {
                    const active = count === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        className={`mc-pill mc-pill-sm ${active ? "mc-pill-on" : ""}`}
                        onClick={() => setCount(n)}
                        disabled={busy}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>
              <span className="mc-hint">
                Pick a quick value or type any number from {COUNT_MIN}–{COUNT_MAX}
              </span>
            </div>

            <label className="mc-field" style={{ gridColumn: "span 6" }}>
              <span className="mc-label">
                Run label
                <span className="mc-optional">optional · for your records</span>
              </span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                placeholder="e.g. Quebec linear-lighting RFP outreach – May 2026"
                className="mc-input"
              />
            </label>
          </div>
        </div>

        {/* Action bar */}
        <div className="mc-form-actions">
          {!canEdit && (
            <span className="mc-readonly">Read-only access</span>
          )}
          <button
            type="button"
            className="mc-btn mc-btn-primary mc-btn-cta"
            onClick={handleGenerate}
            disabled={busy || !canEdit}
            title={!canEdit ? "Read-only — needs edit permissions" : undefined}
          >
            {busy ? "Researching…" : `✨ Generate ${count} contact${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>

      {/* Past searches */}
      {searches.length > 0 && (
        <section className="mc-searches">
          <h3 className="mc-section-h">Saved searches</h3>
          <div className="mc-search-list">
            {searches.map((s) => {
              const list = contactsBySearch.get(s.id) ?? [];
              const active = activeSearchId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`mc-search-item ${active ? "mc-search-item-on" : ""}`}
                  onClick={() => {
                    setActiveSearchId(s.id);
                    setCategoryFilter(null);
                  }}
                >
                  <div className="mc-search-title">
                    {s.title || `${s.province} · ${s.scopeTypes}`}
                  </div>
                  <div className="mc-search-meta">
                    {s.province} · {list.length} contact
                    {list.length === 1 ? "" : "s"} ·{" "}
                    {new Date(s.createdAt).toLocaleDateString()}
                    {s.cityFilter ? ` · ${s.cityFilter}` : ""}
                    {s.sectors && s.sectors !== "all"
                      ? ` · ${s.sectors
                          .split(",")
                          .map((c) => sectorLabel(c.trim()))
                          .join(", ")}`
                      : ""}
                  </div>
                  {canEdit && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="mc-search-del"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSearch(s.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteSearch(s.id);
                        }
                      }}
                      title="Delete search"
                    >
                      ✕
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Results panel */}
      {activeSearch && (
        <section className="mc-results">
          <div className="mc-results-head">
            <div>
              <h3 className="mc-section-h">
                {activeSearch.title ||
                  `${activeSearch.province} – ${activeSearch.scopeTypes}`}
              </h3>
              <div className="mc-results-meta">
                {activeContacts.length} of{" "}
                {(contactsBySearch.get(activeSearch.id) ?? []).length} contact
                {(contactsBySearch.get(activeSearch.id) ?? []).length === 1
                  ? ""
                  : "s"}{" "}
                · across {activeContactsByMunicipality.length} municipalit
                {activeContactsByMunicipality.length === 1 ? "y" : "ies"}
                {exportCounts.total > 0 && (
                  <>
                    {" "}
                    ·{" "}
                    <span title="Tracked separately for HubSpot export — only unexported leads ship in the next download.">
                      {exportCounts.exported} exported / {exportCounts.notExported} new
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="mc-results-actions">
              {/* Primary HubSpot export — adapts to the user's export
                  state. Shows "N new" when there are unexported-by-me
                  leads, otherwise reads "Up to date". */}
              <button
                type="button"
                className="mc-btn mc-btn-primary"
                onClick={() => handleHubspotExport("new")}
                disabled={exportBusy || exportCounts.notExported === 0}
                title={
                  exportCounts.notExported > 0
                    ? `Download ${exportCounts.notExported} new-for-you contact${exportCounts.notExported === 1 ? "" : "s"} as a HubSpot-ready CSV. Already-exported (by you) contacts are skipped.`
                    : "You've exported every contact in this directory."
                }
              >
                {exportBusy
                  ? "Exporting…"
                  : exportCounts.notExported > 0
                    ? `↓ HubSpot — ${exportCounts.notExported} new`
                    : `↓ HubSpot — up to date`}
              </button>

              {/* Always-available "Export everything" — for ad-hoc full
                  pulls. Does NOT change the user's export state, so the
                  next "N new" count stays accurate. */}
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                onClick={() => handleHubspotExport("everything")}
                disabled={exportBusy || exportCounts.total === 0}
                title="Download every contact in this directory as a HubSpot-ready CSV. Does not change your export state — future 'N new' counts are unaffected."
              >
                {exportBusy ? "Exporting…" : `↓ HubSpot · all ${exportCounts.total}`}
              </button>

              {/* Plain CSV — for spreadsheet / non-HubSpot use. */}
              <button
                type="button"
                className="mc-btn"
                onClick={exportCsv}
                disabled={!activeContacts.length}
                title="Plain CSV — all visible columns, no HubSpot column mapping."
              >
                ↓ CSV
              </button>
            </div>
          </div>

          {/* Category filter chips. Each chip is two buttons in a wrapper:
              the chip itself toggles the filter; a small × button on the
              right (visible to editors only) bulk-removes every contact in
              that category. Buttons aren't nested — they're siblings inside
              a flex wrapper — to keep the HTML valid. */}
          <div className="mc-cat-pills">
            <button
              type="button"
              className={`mc-pill ${!categoryFilter ? "mc-pill-on" : ""}`}
              onClick={() => setCategoryFilter(null)}
            >
              All ({(contactsBySearch.get(activeSearch.id) ?? []).length})
            </button>
            {CONTACT_CATEGORIES.map((c) => {
              const n = categoryCounts.get(c.code) ?? 0;
              if (n === 0) return null;
              const active = categoryFilter === c.code;
              return (
                <div
                  key={c.code}
                  className={`mc-pill-group mc-pill-cat-${c.code} ${active ? "mc-pill-on" : ""}`}
                >
                  <button
                    type="button"
                    className="mc-pill-main"
                    onClick={() => setCategoryFilter(active ? null : c.code)}
                  >
                    {c.label} ({n})
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      className="mc-pill-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveCategory(c.code, n);
                      }}
                      title={`Remove all ${n} ${c.label} contact${n === 1 ? "" : "s"}`}
                      aria-label={`Remove all ${n} ${c.label} contacts`}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Cards grouped by municipality */}
          {activeContactsByMunicipality.length === 0 ? (
            <div className="mc-empty">
              No contacts match this filter.
            </div>
          ) : (
            <div className="mc-muni-grid">
              {activeContactsByMunicipality.map(([muniName, muniContacts]) => (
                <div key={muniName} className="mc-muni-card">
                  <div className="mc-muni-head">
                    <div className="mc-muni-name">{muniName}</div>
                    <div className="mc-muni-meta">
                      {muniContacts[0]?.municipalityType
                        ? muniContacts[0].municipalityType
                        : "—"}{" "}
                      · {muniContacts.length} contact
                      {muniContacts.length === 1 ? "" : "s"}
                    </div>
                    {muniContacts[0]?.website && (
                      <a
                        className="mc-muni-link"
                        href={muniContacts[0].website}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Website ↗
                      </a>
                    )}
                  </div>
                  <ul className="mc-contact-list">
                    {muniContacts.map((c) => (
                      <li key={c.id} className="mc-contact">
                        <div className="mc-contact-row1">
                          <span
                            className={`mc-cat-tag mc-pill-cat-${c.category ?? "other"}`}
                          >
                            {categoryLabel(c.category)}
                          </span>
                          {c.role && (
                            <span className="mc-contact-role">{c.role}</span>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="mc-contact-del"
                              onClick={() => handleDeleteContact(c.id)}
                              title="Remove contact"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        {c.department && (
                          <div className="mc-contact-dept">{c.department}</div>
                        )}
                        {c.name && (
                          <div className="mc-contact-name">{c.name}</div>
                        )}
                        {c.servicesSummary && (
                          <div className="mc-contact-services">
                            {c.servicesSummary}
                          </div>
                        )}
                        <div className="mc-contact-fields">
                          {c.email && (
                            <a
                              href={`mailto:${c.email}`}
                              className="mc-contact-field"
                            >
                              ✉ {c.email}
                            </a>
                          )}
                          {c.phone && (
                            <a
                              href={`tel:${c.phone}`}
                              className="mc-contact-field"
                            >
                              ☎ {c.phone}
                            </a>
                          )}
                          {c.address && (
                            <span className="mc-contact-field">📍 {c.address}</span>
                          )}
                          {c.sourceUrl && (
                            <a
                              href={c.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mc-contact-field mc-contact-source"
                            >
                              source ↗
                            </a>
                          )}
                        </div>
                        {c.notes && (
                          <div className="mc-contact-notes">{c.notes}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!activeSearch && searches.length === 0 && (
        <div className="mc-empty">
          No searches yet. Use the form above to generate your first directory.
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className="mc-toast"
          style={{
            background: toast.err ? "#dc2626" : "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
          }}
        >
          {toast.msg}
        </div>
      )}

      <MunicipalContactsCss />
    </div>
  );
}

function MunicipalContactsCss() {
  return (
    <style jsx global>{`
      .mc-wrap {
        max-width: 1280px;
        margin: 0 auto;
        padding: 28px;
        color: var(--lb-text);
      }
      .mc-header {
        margin-bottom: 22px;
      }
      .mc-eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--lb-text-3);
      }
      .mc-title {
        font-family: var(--lb-font-display);
        font-size: 30px;
        font-weight: 800;
        letter-spacing: -0.02em;
        margin: 4px 0 6px;
        color: var(--lb-text);
      }
      .mc-sub {
        max-width: 720px;
        font-size: 14px;
        color: var(--lb-text-2);
        margin: 0;
      }

      /* Form — three-stage layout (Where → What → How many) */
      .mc-form {
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: 16px;
        padding: 6px 22px 22px;
        margin-bottom: 18px;
      }
      .mc-stage {
        padding: 18px 0;
        border-bottom: 1px solid var(--lb-border);
      }
      .mc-stage:last-of-type { border-bottom: 0; }
      .mc-stage-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
      }
      .mc-stage-num {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: var(--lb-accent-fg);
        background: var(--lb-accent);
        border-radius: 50%;
        font-variant-numeric: tabular-nums;
      }
      .mc-stage-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.005em;
        color: var(--lb-text);
      }
      .mc-stage-action {
        margin-left: auto;
        font-size: 11px;
        font-weight: 500;
        color: var(--lb-text-3);
        background: transparent;
        border: 0;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .mc-stage-action:hover { color: var(--lb-accent); background: var(--lb-bg); }
      .mc-stage-action:disabled { opacity: 0.5; cursor: not-allowed; }

      /* 12-column grid for stages 1 & 3 */
      .mc-row-12 {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 14px;
        align-items: start;
      }
      @media (max-width: 880px) {
        .mc-row-12 > .mc-field { grid-column: span 12 !important; }
      }
      .mc-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .mc-label {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--lb-text-2);
        letter-spacing: 0.02em;
      }
      .mc-optional {
        font-size: 10px;
        font-weight: 500;
        color: var(--lb-text-3);
        letter-spacing: 0;
        text-transform: lowercase;
        font-style: italic;
      }
      .mc-hint {
        font-size: 11px;
        font-weight: 400;
        color: var(--lb-text-3);
        letter-spacing: 0;
        line-height: 1.4;
      }
      .mc-hint-block {
        margin: 10px 0 0;
      }
      .mc-input {
        height: 36px;
        padding: 0 12px;
        background: var(--lb-bg);
        color: var(--lb-text);
        border: 1px solid var(--lb-border);
        border-radius: 10px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 160ms;
      }
      .mc-input:focus {
        border-color: var(--lb-accent);
      }
      select.mc-input {
        appearance: none;
        background-image: linear-gradient(45deg, transparent 50%, var(--lb-text-2) 50%),
          linear-gradient(135deg, var(--lb-text-2) 50%, transparent 50%);
        background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
        background-size: 5px 5px;
        background-repeat: no-repeat;
        padding-right: 28px;
      }
      .mc-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .mc-pills-tight {
        gap: 4px;
      }
      .mc-pills-sectors {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 8px;
      }
      .mc-pills-sectors .mc-pill {
        justify-content: center;
        height: 36px;
        font-size: 12.5px;
      }
      .mc-pill-sm {
        height: 28px;
        padding: 0 10px;
        font-size: 11.5px;
        min-width: 36px;
        justify-content: center;
      }
      .mc-count-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .mc-count-input {
        width: 86px;
        height: 36px;
        text-align: center;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        font-size: 14px;
      }
      .mc-count-input::-webkit-outer-spin-button,
      .mc-count-input::-webkit-inner-spin-button {
        opacity: 1;
      }
      .mc-pill {
        display: inline-flex;
        align-items: center;
        height: 32px;
        padding: 0 14px;
        font-size: 12px;
        font-weight: 500;
        background: var(--lb-bg);
        color: var(--lb-text-2);
        border: 1px solid var(--lb-border);
        border-radius: 999px;
        cursor: pointer;
        transition: background 160ms, color 160ms, border-color 160ms;
      }
      .mc-pill:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .mc-pill:hover:not(:disabled) {
        border-color: var(--lb-accent);
      }
      .mc-pill-on {
        background: var(--lb-accent);
        color: var(--lb-accent-fg);
        border-color: var(--lb-accent);
      }

      /* Category / sector-coloured pills */
      .mc-pill-cat-engineering.mc-pill-on { background: hsl(28, 100%, 52%); border-color: hsl(28, 100%, 52%); color: #fff; }
      .mc-pill-cat-public-works.mc-pill-on { background: hsl(195, 80%, 48%); border-color: hsl(195, 80%, 48%); color: #fff; }
      .mc-pill-cat-administration.mc-pill-on { background: hsl(265, 60%, 60%); border-color: hsl(265, 60%, 60%); color: #fff; }
      .mc-pill-cat-elected.mc-pill-on { background: hsl(345, 75%, 55%); border-color: hsl(345, 75%, 55%); color: #fff; }
      .mc-pill-cat-planning.mc-pill-on { background: hsl(45, 95%, 50%); border-color: hsl(45, 95%, 50%); color: #1a1a1a; }
      .mc-pill-cat-parks.mc-pill-on { background: hsl(135, 55%, 45%); border-color: hsl(135, 55%, 45%); color: #fff; }
      .mc-pill-cat-environment.mc-pill-on { background: hsl(155, 65%, 38%); border-color: hsl(155, 65%, 38%); color: #fff; }
      .mc-pill-cat-fire.mc-pill-on { background: hsl(8, 80%, 52%); border-color: hsl(8, 80%, 52%); color: #fff; }
      .mc-pill-cat-police.mc-pill-on { background: hsl(220, 60%, 45%); border-color: hsl(220, 60%, 45%); color: #fff; }
      .mc-pill-cat-other.mc-pill-on { background: hsl(160, 35%, 50%); border-color: hsl(160, 35%, 50%); color: #fff; }
      .mc-pill-clear { font-style: italic; opacity: 0.85; }

      /* Composite chip with a main filter button and a small × remove
         button on the right. Behaves like a pill but with two click
         targets — the user can toggle the filter without bulk-deleting. */
      .mc-pill-group {
        display: inline-flex;
        align-items: stretch;
        height: 32px;
        background: var(--lb-bg);
        color: var(--lb-text-2);
        border: 1px solid var(--lb-border);
        border-radius: 999px;
        overflow: hidden;
        transition: background 160ms, color 160ms, border-color 160ms;
      }
      .mc-pill-group:hover { border-color: var(--lb-accent); }
      .mc-pill-main {
        padding: 0 12px;
        font-size: 12px;
        font-weight: 500;
        background: transparent;
        color: inherit;
        border: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
      }
      .mc-pill-remove {
        width: 26px;
        background: transparent;
        color: inherit;
        border: 0;
        border-left: 1px solid var(--lb-border);
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.7;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .mc-pill-remove:hover { opacity: 1; background: rgba(239, 68, 68, 0.16); color: #ef4444; }

      /* When the group is active, paint the whole thing in the sector colour
         (mirrors the original .mc-pill-on look) but keep the remove button
         readable on top. */
      .mc-pill-group.mc-pill-on { color: #fff; border-color: transparent; }
      .mc-pill-group.mc-pill-on .mc-pill-remove { border-left-color: rgba(255,255,255,0.3); }
      .mc-pill-group.mc-pill-cat-engineering.mc-pill-on { background: hsl(28, 100%, 52%); }
      .mc-pill-group.mc-pill-cat-public-works.mc-pill-on { background: hsl(195, 80%, 48%); }
      .mc-pill-group.mc-pill-cat-administration.mc-pill-on { background: hsl(265, 60%, 60%); }
      .mc-pill-group.mc-pill-cat-elected.mc-pill-on { background: hsl(345, 75%, 55%); }
      .mc-pill-group.mc-pill-cat-planning.mc-pill-on { background: hsl(45, 95%, 50%); color: #1a1a1a; }
      .mc-pill-group.mc-pill-cat-parks.mc-pill-on { background: hsl(135, 55%, 45%); }
      .mc-pill-group.mc-pill-cat-environment.mc-pill-on { background: hsl(155, 65%, 38%); }
      .mc-pill-group.mc-pill-cat-fire.mc-pill-on { background: hsl(8, 80%, 52%); }
      .mc-pill-group.mc-pill-cat-police.mc-pill-on { background: hsl(220, 60%, 45%); }
      .mc-pill-group.mc-pill-cat-other.mc-pill-on { background: hsl(160, 35%, 50%); }

      .mc-form-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 18px;
        padding-top: 18px;
        border-top: 1px solid var(--lb-border);
        justify-content: flex-end;
      }
      .mc-form-actions .mc-readonly { margin-right: auto; }
      .mc-btn-cta {
        height: 44px;
        padding: 0 24px;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.005em;
      }
      .mc-btn {
        height: 38px;
        padding: 0 16px;
        font-size: 13px;
        font-weight: 600;
        background: var(--lb-bg);
        color: var(--lb-text);
        border: 1px solid var(--lb-border);
        border-radius: 10px;
        cursor: pointer;
        transition: border-color 160ms, background 160ms;
      }
      .mc-btn:hover:not(:disabled) {
        border-color: var(--lb-accent);
      }
      .mc-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .mc-btn-primary {
        background: var(--lb-accent);
        color: var(--lb-accent-fg);
        border-color: var(--lb-accent);
        box-shadow: var(--lb-glow-accent);
      }
      .mc-btn-primary:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .mc-readonly {
        font-size: 11.5px;
        color: var(--lb-text-3);
      }

      /* Sections */
      .mc-section-h {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--lb-text-3);
        margin: 0 0 12px;
      }

      /* Saved searches */
      .mc-searches { margin-bottom: 18px; }
      .mc-search-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 10px;
      }
      .mc-search-item {
        position: relative;
        padding: 12px 30px 12px 14px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: 10px;
        text-align: left;
        cursor: pointer;
        transition: border-color 160ms, background 160ms;
        font: inherit;
        color: inherit;
      }
      .mc-search-item:hover {
        border-color: var(--lb-accent);
      }
      .mc-search-item-on {
        border-color: var(--lb-accent);
        background: color-mix(in srgb, var(--lb-accent) 8%, var(--lb-bg-elev));
      }
      .mc-search-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--lb-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .mc-search-meta {
        font-size: 11px;
        color: var(--lb-text-3);
        margin-top: 3px;
      }
      .mc-search-del {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        color: var(--lb-text-3);
        cursor: pointer;
        border-radius: 50%;
      }
      .mc-search-del:hover {
        background: var(--lb-bg);
        color: #ef4444;
      }

      /* Results */
      .mc-results-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      .mc-results-meta {
        font-size: 12px;
        color: var(--lb-text-3);
      }
      .mc-results-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      /* Visual hairline between the HubSpot export buttons (left group)
         and the plain CSV button (right). Reads as: "two HubSpot options"
         | "raw CSV". Implemented with a margin-left so it doesn't add a
         DOM element and stays graceful when the bar wraps on narrow
         screens. */
      .mc-results-actions .mc-btn:last-child {
        margin-left: 12px;
        position: relative;
      }
      .mc-results-actions .mc-btn:last-child::before {
        content: "";
        position: absolute;
        left: -10px;
        top: 6px;
        bottom: 6px;
        width: 1px;
        background: var(--lb-border);
      }
      .mc-btn-secondary {
        background: var(--lb-bg-elev);
        color: var(--lb-text);
        border: 1px solid var(--lb-border);
      }
      .mc-btn-secondary:hover:not(:disabled) {
        border-color: var(--lb-accent);
        color: var(--lb-accent);
      }
      .mc-cat-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 14px;
      }

      .mc-muni-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
      }
      .mc-muni-card {
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: 12px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .mc-muni-head {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .mc-muni-name {
        font-size: 14px;
        font-weight: 700;
        color: var(--lb-text);
        letter-spacing: -0.01em;
      }
      .mc-muni-meta {
        font-size: 11px;
        color: var(--lb-text-3);
        text-transform: capitalize;
      }
      .mc-muni-link {
        font-size: 11.5px;
        color: var(--lb-accent);
        text-decoration: none;
      }
      .mc-muni-link:hover { text-decoration: underline; }

      .mc-contact-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .mc-contact {
        position: relative;
        padding: 10px 12px;
        background: var(--lb-bg);
        border: 1px solid var(--lb-border);
        border-radius: 10px;
      }
      .mc-contact-row1 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      .mc-cat-tag {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 999px;
        color: #fff;
        background: hsl(160, 35%, 50%);
      }
      .mc-cat-tag.mc-pill-cat-engineering { background: hsl(28, 100%, 52%); }
      .mc-cat-tag.mc-pill-cat-public-works { background: hsl(195, 80%, 48%); }
      .mc-cat-tag.mc-pill-cat-administration { background: hsl(265, 60%, 60%); }
      .mc-cat-tag.mc-pill-cat-elected { background: hsl(345, 75%, 55%); }
      .mc-cat-tag.mc-pill-cat-planning { background: hsl(45, 95%, 50%); color: #1a1a1a; }
      .mc-cat-tag.mc-pill-cat-parks { background: hsl(135, 55%, 45%); }
      .mc-cat-tag.mc-pill-cat-environment { background: hsl(155, 65%, 38%); }
      .mc-cat-tag.mc-pill-cat-fire { background: hsl(8, 80%, 52%); }
      .mc-cat-tag.mc-pill-cat-police { background: hsl(220, 60%, 45%); }
      .mc-cat-tag.mc-pill-cat-other { background: hsl(160, 35%, 50%); }

      .mc-contact-role {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--lb-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }
      .mc-contact-del {
        background: transparent;
        border: 0;
        color: var(--lb-text-3);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        padding: 2px 4px;
      }
      .mc-contact-del:hover { color: #ef4444; }
      .mc-contact-dept {
        font-size: 11.5px;
        color: var(--lb-text-2);
      }
      .mc-contact-name {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--lb-text);
        margin-top: 2px;
      }
      .mc-contact-services {
        font-size: 11.5px;
        color: var(--lb-text-2);
        line-height: 1.45;
        margin-top: 6px;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--lb-accent) 6%, var(--lb-bg-elev));
        border-left: 2px solid var(--lb-accent);
        border-radius: 4px;
      }
      .mc-contact-fields {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-top: 6px;
      }
      .mc-contact-field {
        font-size: 12px;
        color: var(--lb-text-2);
        text-decoration: none;
        word-break: break-all;
      }
      a.mc-contact-field:hover { color: var(--lb-accent); }
      .mc-contact-source { color: var(--lb-text-3); }
      .mc-contact-notes {
        font-size: 11px;
        color: var(--lb-text-3);
        font-style: italic;
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--lb-border);
      }

      .mc-empty {
        padding: 20px;
        text-align: center;
        color: var(--lb-text-3);
        font-size: 13px;
        background: var(--lb-bg-elev);
        border: 1px dashed var(--lb-border);
        border-radius: 12px;
      }

      .mc-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        padding: 10px 16px;
        border-radius: 10px;
        font-size: 12.5px;
        font-weight: 500;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
        z-index: 200;
      }
    `}</style>
  );
}
