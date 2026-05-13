"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MunicipalityListEntry } from "@/db/schema";
import {
  createEntry,
  updateEntry,
  deleteEntry,
  exportListToHubspot,
  type EntryInput,
} from "./actions";

// ── Page-level constants ──────────────────────────────────────────────
const PAGE_SIZE = 60;

// Population buckets for the filter pills. The thresholds match the
// rough split between hamlets / villages / towns / mid-size cities /
// big cities in Quebec — every bucket has hundreds of entries so no
// filter ends up empty.
const POP_BUCKETS = [
  { id: "all", label: "All sizes", test: (_n: number | null) => true },
  {
    id: "tiny",
    label: "<500",
    test: (n: number | null) => n != null && n < 500,
  },
  {
    id: "small",
    label: "500 – 2k",
    test: (n: number | null) => n != null && n >= 500 && n < 2000,
  },
  {
    id: "mid",
    label: "2k – 10k",
    test: (n: number | null) => n != null && n >= 2000 && n < 10000,
  },
  {
    id: "large",
    label: "10k – 50k",
    test: (n: number | null) => n != null && n >= 10000 && n < 50000,
  },
  {
    id: "big",
    label: "50k+",
    test: (n: number | null) => n != null && n >= 50000,
  },
] as const;

type Props = {
  entries: MunicipalityListEntry[];
  canEdit: boolean;
  // IDs of entries the current user has already exported to HubSpot.
  // Drives the "↓ HubSpot — N new" count and the empty-state toast.
  myExportedIds: number[];
};

// ── Default empty form (used by both Add and Edit) ────────────────────
const EMPTY_FORM: EntryInput = {
  name: "",
  designation: "",
  gentile: "",
  email: "",
  website: "",
  phone: "",
  fax: "",
  addressLine: "",
  addressCity: "",
  addressPostal: "",
  region: "",
  mrc: "",
  population: null,
  mayor: "",
  councillors: [],
  directorGeneral: "",
  treasurer: "",
  clerk: "",
  policeChief: "",
  fireChief: "",
  recreationDirector: "",
  publicWorksDirector: "",
  emergencyMeasures: "",
  urbanPlanner: "",
  communications: "",
  permits: "",
  buildingInspector: "",
  notes: "",
};

function entryToForm(e: MunicipalityListEntry): EntryInput {
  return {
    name: e.name,
    designation: e.designation ?? "",
    gentile: e.gentile ?? "",
    email: e.email ?? "",
    website: e.website ?? "",
    phone: e.phone ?? "",
    fax: e.fax ?? "",
    addressLine: e.addressLine ?? "",
    addressCity: e.addressCity ?? "",
    addressPostal: e.addressPostal ?? "",
    region: e.region ?? "",
    mrc: e.mrc ?? "",
    population: e.population,
    mayor: e.mayor ?? "",
    councillors: (e.councillors as string[] | null) ?? [],
    directorGeneral: e.directorGeneral ?? "",
    treasurer: e.treasurer ?? "",
    clerk: e.clerk ?? "",
    policeChief: e.policeChief ?? "",
    fireChief: e.fireChief ?? "",
    recreationDirector: e.recreationDirector ?? "",
    publicWorksDirector: e.publicWorksDirector ?? "",
    emergencyMeasures: e.emergencyMeasures ?? "",
    urbanPlanner: e.urbanPlanner ?? "",
    communications: e.communications ?? "",
    permits: e.permits ?? "",
    buildingInspector: e.buildingInspector ?? "",
    notes: e.notes ?? "",
  };
}

export default function MunicipalContactListView({
  entries,
  canEdit,
  myExportedIds,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [exportBusy, setExportBusy] = useState(false);

  // O(1) lookup for the export-status check inside the filter loop.
  const exportedSet = useMemo(
    () => new Set(myExportedIds),
    [myExportedIds],
  );

  // ── Filter state ─────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState<string>("");
  const [mrc, setMrc] = useState<string>("");
  const [designation, setDesignation] = useState<string>("");
  const [popBucket, setPopBucket] = useState<string>("all");
  const [page, setPage] = useState(0);

  // ── Drawer / form state ──────────────────────────────────────────
  // mode "view" shows read-only details; "edit" shows the form for an
  // existing row; "create" shows the form for a brand-new row.
  const [drawer, setDrawer] = useState<
    | { kind: "closed" }
    | { kind: "view"; id: number }
    | { kind: "edit"; id: number; form: EntryInput }
    | { kind: "create"; form: EntryInput }
  >({ kind: "closed" });

  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(
    null,
  );

  // ── Distinct filter options computed from the data ───────────────
  // Sorted alphabetically. We strip the trailing " (NN)" code suffix from
  // the source to keep the dropdowns readable; the raw region/mrc strings
  // still match exactly because we filter against the original column.
  const regionOptions = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => e.region && set.add(e.region));
    return Array.from(set).sort();
  }, [entries]);

  const mrcOptions = useMemo(() => {
    // MRC list is conditional on selected region — most users want to
    // narrow by region first then pick an MRC inside it.
    const set = new Set<string>();
    entries.forEach((e) => {
      if (region && e.region !== region) return;
      if (e.mrc) set.add(e.mrc);
    });
    return Array.from(set).sort();
  }, [entries, region]);

  const designationOptions = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => e.designation && set.add(e.designation));
    return Array.from(set).sort();
  }, [entries]);

  // ── Apply filters ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const popTest =
      POP_BUCKETS.find((b) => b.id === popBucket)?.test ?? (() => true);

    return entries.filter((e) => {
      if (region && e.region !== region) return false;
      if (mrc && e.mrc !== mrc) return false;
      if (designation && e.designation !== designation) return false;
      if (!popTest(e.population)) return false;
      if (q) {
        const hay = [
          e.name,
          e.mayor,
          e.email,
          e.addressCity,
          e.addressPostal,
          e.directorGeneral,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, region, mrc, designation, popBucket]);

  // Reset to page 0 when filters change so users don't end up looking at
  // an empty page.
  const filterKey = `${search}|${region}|${mrc}|${designation}|${popBucket}`;
  const lastFilterKey = useMemo(() => filterKey, [filterKey]);
  if (page > 0 && filtered.length <= page * PAGE_SIZE) {
    // Pagination overshoot — snap back. Done in render so we don't need
    // an effect for this trivial reset.
    setTimeout(() => setPage(0), 0);
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const activeEntry =
    drawer.kind === "view" || drawer.kind === "edit"
      ? entries.find((e) => e.id === drawer.id) ?? null
      : null;

  // ── Mutations ────────────────────────────────────────────────────
  function handleSave() {
    if (drawer.kind !== "edit" && drawer.kind !== "create") return;
    const form = drawer.form;
    if (!form.name?.trim()) {
      setToast({ msg: "Name is required", err: true });
      return;
    }
    startTransition(async () => {
      const result =
        drawer.kind === "edit"
          ? await updateEntry(drawer.id, form)
          : await createEntry(form);
      if (!result.ok) {
        setToast({ msg: result.error, err: true });
        return;
      }
      setToast({
        msg: drawer.kind === "edit" ? "Saved." : "Added.",
      });
      setDrawer({ kind: "closed" });
      router.refresh();
    });
  }

  // ── Export counts (recompute from filtered set) ────────────────
  // Filtered set is the user's current narrowing — region / MRC /
  // designation / population / search. Export buttons act on it, so
  // these counts adapt live. "newCount" excludes anything this user has
  // already exported.
  const newCount = useMemo(() => {
    let n = 0;
    for (const e of filtered) if (!exportedSet.has(e.id)) n++;
    return n;
  }, [filtered, exportedSet]);

  function downloadCsvBlob(csv: string, fileName: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ── HubSpot export (mode = "new" | "all") ──────────────────────
  // "new": ships only entries this user hasn't exported yet, then marks
  //        them as exported. Repeatedly clickable; the count drops to 0.
  // "all": ships every entry in the current filter; marks them exported.
  async function handleHubspotExport(mode: "new" | "all") {
    if (filtered.length === 0) {
      setToast({ msg: "No municipalities in current filter", err: true });
      return;
    }
    setExportBusy(true);
    try {
      const result = await exportListToHubspot({
        mode,
        entryIds: filtered.map((e) => e.id),
      });
      if (!result.ok) {
        setToast({ msg: result.error, err: true });
        return;
      }
      if (result.data.exportedRowCount === 0) {
        setToast({ msg: "Nothing new to export — you're up to date." });
        return;
      }
      downloadCsvBlob(result.data.csv, result.data.fileName);
      setToast({
        msg: `Exported ${result.data.exportedRowCount} contact${
          result.data.exportedRowCount === 1 ? "" : "s"
        } from ${result.data.exportedEntryCount} municipalit${
          result.data.exportedEntryCount === 1 ? "y" : "ies"
        }.`,
      });
      router.refresh(); // refresh exported set so "N new" updates
    } catch (e) {
      setToast({
        msg: e instanceof Error ? e.message : "Export failed",
        err: true,
      });
    } finally {
      setExportBusy(false);
    }
  }

  // ── Plain CSV (one row per municipality, no HubSpot mapping) ────
  // Doesn't touch export state — meant for ad-hoc spreadsheet use, won't
  // affect "N new" counts. Generated client-side from the filtered list
  // because there's nothing dynamic the server needs to add.
  function handlePlainCsv() {
    if (filtered.length === 0) {
      setToast({ msg: "No municipalities in current filter", err: true });
      return;
    }
    const headers = [
      "Name",
      "Type",
      "Region",
      "MRC",
      "Population",
      "Address",
      "City",
      "Postal Code",
      "Phone",
      "Fax",
      "Email",
      "Website",
      "Mayor",
      "Councillors",
      "Director General",
      "Treasurer",
      "Clerk",
      "Police Chief",
      "Fire Chief",
      "Public Works",
      "Recreation",
      "Urban Planner",
      "Building Inspector",
      "Permits",
      "Communications",
      "Emergency Measures",
      "Notes",
    ];
    const rows = filtered.map((e) => {
      const councillors = (e.councillors as string[] | null) ?? [];
      return [
        e.name,
        e.designation ?? "",
        e.region ?? "",
        e.mrc ?? "",
        e.population == null ? "" : String(e.population),
        e.addressLine ?? "",
        e.addressCity ?? "",
        e.addressPostal ?? "",
        e.phone ?? "",
        e.fax ?? "",
        e.email ?? "",
        e.website ?? "",
        e.mayor ?? "",
        councillors.join(" | "),
        e.directorGeneral ?? "",
        e.treasurer ?? "",
        e.clerk ?? "",
        e.policeChief ?? "",
        e.fireChief ?? "",
        e.publicWorksDirector ?? "",
        e.recreationDirector ?? "",
        e.urbanPlanner ?? "",
        e.buildingInspector ?? "",
        e.permits ?? "",
        e.communications ?? "",
        e.emergencyMeasures ?? "",
        e.notes ?? "",
      ];
    });
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // UTF-8 BOM up front so Excel renders accented French names
    // correctly without manual encoding selection.
    const BOM = "﻿";
    const csv =
      BOM +
      [headers, ...rows]
        .map((r) => r.map(escape).join(","))
        .join("\r\n") +
      "\r\n";
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    downloadCsvBlob(csv, `municipalities-${stamp}.csv`);
    setToast({
      msg: `Downloaded ${filtered.length} municipalit${
        filtered.length === 1 ? "y" : "ies"
      } as CSV.`,
    });
  }

  function handleDelete() {
    if (drawer.kind !== "view" && drawer.kind !== "edit") return;
    if (!confirm("Delete this card? This cannot be undone.")) return;
    const id = drawer.id;
    startTransition(async () => {
      const result = await deleteEntry(id);
      if (!result.ok) {
        setToast({ msg: result.error, err: true });
        return;
      }
      setToast({ msg: "Deleted." });
      setDrawer({ kind: "closed" });
      router.refresh();
    });
  }

  // ── Empty state (table missing or never imported) ────────────────
  if (entries.length === 0) {
    return (
      <div className="mcl-wrap">
        <div className="mcl-empty">
          <h2>No municipalities loaded yet</h2>
          <p>
            Save the source CSV to{" "}
            <code>data/quebec-municipalities.csv</code> and run the import
            script:
          </p>
          <pre>
            npx tsx --env-file=.env scripts/import-quebec-municipalities.ts
          </pre>
          <p>
            Or click <strong>Add municipality</strong> to start with an
            empty list.
          </p>
          {canEdit && (
            <button
              className="mcl-btn mcl-btn-primary"
              onClick={() =>
                setDrawer({ kind: "create", form: { ...EMPTY_FORM } })
              }
            >
              + Add municipality
            </button>
          )}
        </div>
        {drawer.kind === "create" && (
          <EditDrawer
            mode="create"
            form={drawer.form}
            onChange={(f) => setDrawer({ kind: "create", form: f })}
            onSave={handleSave}
            onClose={() => setDrawer({ kind: "closed" })}
            saving={pending}
          />
        )}
        <Toast toast={toast} onDismiss={() => setToast(null)} />
        <Styles />
      </div>
    );
  }

  return (
    <div className="mcl-wrap">
      {/* ── Search + add ────────────────────────────────────────── */}
      <div className="mcl-toolbar">
        <input
          type="search"
          className="mcl-search"
          placeholder="Search name, mayor, postal code, email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        {canEdit && (
          <button
            className="mcl-btn mcl-btn-primary"
            onClick={() =>
              setDrawer({ kind: "create", form: { ...EMPTY_FORM } })
            }
          >
            + Add municipality
          </button>
        )}
      </div>

      {/* ── Export bar ─────────────────────────────────────────────
          Three options matching the lead-generator tab:
            1. HubSpot — N new : only entries this user hasn't exported
                                 yet (within the current filter).
            2. HubSpot · all N : every entry in the current filter.
            3. CSV             : plain row-per-municipality CSV; doesn't
                                 touch export state.
          The hairline separator before the CSV button reads as
          "two HubSpot options | raw CSV", same convention as the other
          tab. */}
      <div className="mcl-export-bar">
        <button
          className="mcl-btn mcl-btn-primary"
          disabled={exportBusy || newCount === 0}
          onClick={() => handleHubspotExport("new")}
          title={
            newCount === 0
              ? "You've already exported every municipality in this filter."
              : `Download ${newCount} new-for-you municipalit${
                  newCount === 1 ? "y" : "ies"
                } as a HubSpot-ready CSV. Already-exported (by you) entries are skipped.`
          }
        >
          {exportBusy
            ? "Exporting…"
            : newCount > 0
              ? `↓ HubSpot — ${newCount.toLocaleString()} new`
              : "↓ HubSpot — up to date"}
        </button>
        <button
          className="mcl-btn"
          disabled={exportBusy || filtered.length === 0}
          onClick={() => handleHubspotExport("all")}
          title="Download every municipality in the current filter as a HubSpot-ready CSV. Marks them all as exported for you."
        >
          {exportBusy
            ? "Exporting…"
            : `↓ HubSpot · all ${filtered.length.toLocaleString()}`}
        </button>
        <button
          className="mcl-btn mcl-csv-btn"
          disabled={exportBusy || filtered.length === 0}
          onClick={handlePlainCsv}
          title="Plain CSV — one row per municipality, no HubSpot column mapping. Doesn't change your export state."
        >
          ↓ CSV
        </button>
      </div>

      {/* ── Filter pills ────────────────────────────────────────── */}
      <div className="mcl-filters">
        <FilterSelect
          label="Region"
          value={region}
          onChange={(v) => {
            setRegion(v);
            setMrc(""); // reset dependent MRC filter
            setPage(0);
          }}
          options={regionOptions}
        />
        <FilterSelect
          label="MRC"
          value={mrc}
          onChange={(v) => {
            setMrc(v);
            setPage(0);
          }}
          options={mrcOptions}
        />
        <FilterSelect
          label="Type"
          value={designation}
          onChange={(v) => {
            setDesignation(v);
            setPage(0);
          }}
          options={designationOptions}
        />
        <div className="mcl-pill-row">
          {POP_BUCKETS.map((b) => (
            <button
              key={b.id}
              className={`mcl-pill ${popBucket === b.id ? "active" : ""}`}
              onClick={() => {
                setPopBucket(b.id);
                setPage(0);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        {(region || mrc || designation || popBucket !== "all" || search) && (
          <button
            className="mcl-clear"
            onClick={() => {
              setSearch("");
              setRegion("");
              setMrc("");
              setDesignation("");
              setPopBucket("all");
              setPage(0);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Stats line ──────────────────────────────────────────── */}
      <div className="mcl-stats">
        <strong>{filtered.length.toLocaleString()}</strong>
        {filtered.length === entries.length
          ? " municipalities"
          : ` of ${entries.length.toLocaleString()} municipalities`}
        {filtered.length > PAGE_SIZE && (
          <span className="mcl-stats-page">
            {" "}· page {page + 1} of {totalPages}
          </span>
        )}
      </div>

      {/* ── Card grid ───────────────────────────────────────────── */}
      <div className="mcl-grid">
        {visible.map((e) => (
          <Card
            key={e.id}
            entry={e}
            onClick={() => setDrawer({ kind: "view", id: e.id })}
          />
        ))}
        {filtered.length === 0 && (
          <div className="mcl-no-results">
            No municipalities match these filters.
          </div>
        )}
      </div>

      {/* ── Pagination ──────────────────────────────────────────── */}
      {filtered.length > PAGE_SIZE && (
        <div className="mcl-pager">
          <button
            className="mcl-pager-btn"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </button>
          <span className="mcl-pager-num">
            {page + 1} / {totalPages}
          </span>
          <button
            className="mcl-pager-btn"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            Next →
          </button>
        </div>
      )}

      {/* ── Drawer ─────────────────────────────────────────────── */}
      {drawer.kind === "view" && activeEntry && (
        <DetailDrawer
          entry={activeEntry}
          canEdit={canEdit}
          onEdit={() =>
            setDrawer({
              kind: "edit",
              id: activeEntry.id,
              form: entryToForm(activeEntry),
            })
          }
          onDelete={handleDelete}
          onClose={() => setDrawer({ kind: "closed" })}
        />
      )}
      {(drawer.kind === "edit" || drawer.kind === "create") && (
        <EditDrawer
          mode={drawer.kind}
          form={drawer.form}
          onChange={(f) =>
            setDrawer(
              drawer.kind === "edit"
                ? { kind: "edit", id: drawer.id, form: f }
                : { kind: "create", form: f },
            )
          }
          onSave={handleSave}
          onDelete={drawer.kind === "edit" ? handleDelete : undefined}
          onClose={() => setDrawer({ kind: "closed" })}
          saving={pending}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <Styles />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Filter <select> styled to match the pill aesthetic. Plain HTML select
// is intentionally simple — combobox / type-ahead is overkill for the
// ~17 regions and ~100 MRCs in the dropdowns.
// ─────────────────────────────────────────────────────────────────────
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      className="mcl-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{label}: any</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card — compact summary shown in the grid. Click opens the detail
// drawer. Designed to surface the most-asked-for fields at a glance:
// name + designation, region, mayor, primary contact (phone/email).
// ─────────────────────────────────────────────────────────────────────
function Card({
  entry,
  onClick,
}: {
  entry: MunicipalityListEntry;
  onClick: () => void;
}) {
  return (
    <button className="mcl-card" onClick={onClick}>
      <div className="mcl-card-head">
        <div className="mcl-card-name">{entry.name}</div>
        {entry.designation && (
          <div className="mcl-card-type">{entry.designation}</div>
        )}
      </div>
      {entry.region && (
        <div className="mcl-card-region">
          {entry.mrc ?? entry.region}
        </div>
      )}
      <div className="mcl-card-meta">
        {entry.population != null && (
          <span>👥 {entry.population.toLocaleString()}</span>
        )}
        {entry.mayor && <span>🏛 {entry.mayor}</span>}
      </div>
      <div className="mcl-card-contact">
        {entry.phone && <div>📞 {entry.phone}</div>}
        {entry.email && (
          <div className="mcl-card-email">✉ {entry.email}</div>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Detail drawer — read-only full view of an entry, with Edit / Delete
// affordances. Shows councillors and admin staff in their own sections
// because there are 6+ councillors and ~13 admin roles per row.
// ─────────────────────────────────────────────────────────────────────
function DetailDrawer({
  entry,
  canEdit,
  onEdit,
  onDelete,
  onClose,
}: {
  entry: MunicipalityListEntry;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const councillors = (entry.councillors as string[] | null) ?? [];

  // List the named admin roles in display order. Filter out empty ones
  // so the section doesn't show "Police chief: —" for the 90% of small
  // municipalities that don't have one.
  const adminRoles: Array<{ label: string; value: string | null }> = [
    { label: "Director general", value: entry.directorGeneral },
    { label: "Deputy DG", value: entry.deputyDg },
    { label: "Treasurer", value: entry.treasurer },
    { label: "Clerk", value: entry.clerk },
    { label: "Police chief", value: entry.policeChief },
    { label: "Fire chief", value: entry.fireChief },
    { label: "Recreation director", value: entry.recreationDirector },
    { label: "Public works", value: entry.publicWorksDirector },
    { label: "Emergency measures", value: entry.emergencyMeasures },
    { label: "Urban planner", value: entry.urbanPlanner },
    { label: "Communications", value: entry.communications },
    { label: "Permits", value: entry.permits },
    { label: "Building inspector", value: entry.buildingInspector },
  ].filter((r) => r.value);

  return (
    <div className="mcl-drawer-backdrop" onClick={onClose}>
      <div className="mcl-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="mcl-drawer-head">
          <div>
            <div className="mcl-drawer-name">{entry.name}</div>
            {entry.designation && (
              <div className="mcl-drawer-type">
                {entry.designation}
                {entry.gentile && (
                  <span className="mcl-drawer-gentile">
                    {" "}· {entry.gentile}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="mcl-drawer-actions">
            {canEdit && (
              <>
                <button className="mcl-btn" onClick={onEdit}>
                  Edit
                </button>
                <button className="mcl-btn mcl-btn-danger" onClick={onDelete}>
                  Delete
                </button>
              </>
            )}
            <button className="mcl-btn-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="mcl-drawer-body">
          {/* Geo + size */}
          <Section title="Location">
            {entry.region && <Field label="Region" value={entry.region} />}
            {entry.mrc && <Field label="MRC" value={entry.mrc} />}
            {entry.addressLine && (
              <Field label="Address" value={entry.addressLine} />
            )}
            {(entry.addressCity || entry.addressPostal) && (
              <Field
                label="City / postal"
                value={[entry.addressCity, entry.addressPostal]
                  .filter(Boolean)
                  .join(" — ")}
              />
            )}
            {entry.population != null && (
              <Field
                label="Population"
                value={entry.population.toLocaleString()}
              />
            )}
            {entry.areaKm2 && (
              <Field label="Area" value={`${entry.areaKm2} km²`} />
            )}
          </Section>

          {/* Contact */}
          <Section title="Contact">
            {entry.phone && <Field label="Phone" value={entry.phone} />}
            {entry.fax && <Field label="Fax" value={entry.fax} />}
            {entry.email && (
              <Field
                label="Email"
                value={
                  <a href={`mailto:${entry.email}`}>{entry.email}</a>
                }
              />
            )}
            {entry.website && (
              <Field
                label="Website"
                value={
                  <a
                    href={
                      entry.website.startsWith("http")
                        ? entry.website
                        : `https://${entry.website}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {entry.website}
                  </a>
                }
              />
            )}
          </Section>

          {/* Council */}
          <Section title="Elected officials">
            {entry.mayor && <Field label="Mayor" value={entry.mayor} />}
            {councillors.length > 0 && (
              <div className="mcl-councillor-list">
                <div className="mcl-field-label">
                  Councillors ({councillors.length})
                </div>
                <ul>
                  {councillors.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* Admin roles */}
          {adminRoles.length > 0 && (
            <Section title="Administration">
              {adminRoles.map((r) => (
                <Field key={r.label} label={r.label} value={r.value!} />
              ))}
            </Section>
          )}

          {/* Election */}
          {(entry.dateElection ||
            entry.electionMode ||
            entry.circonscription ||
            entry.dateIncorporation) && (
            <Section title="Governance">
              {entry.dateIncorporation && (
                <Field label="Founded" value={entry.dateIncorporation} />
              )}
              {entry.dateElection && (
                <Field label="Next election" value={entry.dateElection} />
              )}
              {entry.electionMode && (
                <Field label="Election mode" value={entry.electionMode} />
              )}
              {entry.circonscription && (
                <Field
                  label="Circonscription"
                  value={entry.circonscription}
                />
              )}
            </Section>
          )}

          {/* User notes */}
          {entry.notes && (
            <Section title="Notes">
              <div className="mcl-notes">{entry.notes}</div>
            </Section>
          )}
        </div>
      </div>
    </div>
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
    <div className="mcl-section">
      <div className="mcl-section-title">{title}</div>
      <div className="mcl-section-body">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | React.ReactNode;
}) {
  return (
    <div className="mcl-field">
      <div className="mcl-field-label">{label}</div>
      <div className="mcl-field-value">{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edit drawer — same layout shape as the detail drawer but every field
// is an input. Used for both Create (mode="create") and Edit
// (mode="edit"). Councillor list is a textarea, one name per line —
// keeps the UI simple vs an array-of-inputs widget.
// ─────────────────────────────────────────────────────────────────────
function EditDrawer({
  mode,
  form,
  onChange,
  onSave,
  onDelete,
  onClose,
  saving,
}: {
  mode: "edit" | "create";
  form: EntryInput;
  onChange: (f: EntryInput) => void;
  onSave: () => void;
  onDelete?: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  function update<K extends keyof EntryInput>(key: K, value: EntryInput[K]) {
    onChange({ ...form, [key]: value });
  }

  const councillorText = (form.councillors ?? []).join("\n");

  return (
    <div className="mcl-drawer-backdrop" onClick={onClose}>
      <div className="mcl-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="mcl-drawer-head">
          <div>
            <div className="mcl-drawer-name">
              {mode === "create" ? "New municipality" : `Editing ${form.name}`}
            </div>
            <div className="mcl-drawer-type">
              {mode === "create"
                ? "All fields optional except Name"
                : "Edits flag this card as user-managed (not overwritten on re-import)"}
            </div>
          </div>
          <div className="mcl-drawer-actions">
            <button
              className="mcl-btn mcl-btn-primary"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {onDelete && (
              <button
                className="mcl-btn mcl-btn-danger"
                onClick={onDelete}
                disabled={saving}
              >
                Delete
              </button>
            )}
            <button className="mcl-btn-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="mcl-drawer-body">
          <Section title="Identification">
            <Input
              label="Name *"
              value={form.name}
              onChange={(v) => update("name", v)}
            />
            <Input
              label="Designation"
              placeholder="Ville, Municipalité, Paroisse, Canton…"
              value={form.designation ?? ""}
              onChange={(v) => update("designation", v)}
            />
            <Input
              label="Gentile"
              placeholder="e.g. Sherbrookois, oise"
              value={form.gentile ?? ""}
              onChange={(v) => update("gentile", v)}
            />
          </Section>

          <Section title="Location">
            <Input
              label="Region"
              value={form.region ?? ""}
              onChange={(v) => update("region", v)}
            />
            <Input
              label="MRC"
              value={form.mrc ?? ""}
              onChange={(v) => update("mrc", v)}
            />
            <Input
              label="Address"
              value={form.addressLine ?? ""}
              onChange={(v) => update("addressLine", v)}
            />
            <div className="mcl-row-2">
              <Input
                label="City"
                value={form.addressCity ?? ""}
                onChange={(v) => update("addressCity", v)}
              />
              <Input
                label="Postal code"
                value={form.addressPostal ?? ""}
                onChange={(v) => update("addressPostal", v)}
              />
            </div>
            <Input
              label="Population"
              type="number"
              value={form.population == null ? "" : String(form.population)}
              onChange={(v) =>
                update("population", v === "" ? null : parseInt(v, 10) || null)
              }
            />
          </Section>

          <Section title="Contact">
            <div className="mcl-row-2">
              <Input
                label="Phone"
                value={form.phone ?? ""}
                onChange={(v) => update("phone", v)}
              />
              <Input
                label="Fax"
                value={form.fax ?? ""}
                onChange={(v) => update("fax", v)}
              />
            </div>
            <Input
              label="Email"
              type="email"
              value={form.email ?? ""}
              onChange={(v) => update("email", v)}
            />
            <Input
              label="Website"
              value={form.website ?? ""}
              onChange={(v) => update("website", v)}
            />
          </Section>

          <Section title="Elected officials">
            <Input
              label="Mayor"
              value={form.mayor ?? ""}
              onChange={(v) => update("mayor", v)}
            />
            <Textarea
              label="Councillors (one per line)"
              value={councillorText}
              rows={6}
              onChange={(v) =>
                update(
                  "councillors",
                  v
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </Section>

          <Section title="Administration">
            <Input
              label="Director general"
              value={form.directorGeneral ?? ""}
              onChange={(v) => update("directorGeneral", v)}
            />
            <div className="mcl-row-2">
              <Input
                label="Treasurer"
                value={form.treasurer ?? ""}
                onChange={(v) => update("treasurer", v)}
              />
              <Input
                label="Clerk"
                value={form.clerk ?? ""}
                onChange={(v) => update("clerk", v)}
              />
            </div>
            <div className="mcl-row-2">
              <Input
                label="Police chief"
                value={form.policeChief ?? ""}
                onChange={(v) => update("policeChief", v)}
              />
              <Input
                label="Fire chief"
                value={form.fireChief ?? ""}
                onChange={(v) => update("fireChief", v)}
              />
            </div>
            <div className="mcl-row-2">
              <Input
                label="Recreation"
                value={form.recreationDirector ?? ""}
                onChange={(v) => update("recreationDirector", v)}
              />
              <Input
                label="Public works"
                value={form.publicWorksDirector ?? ""}
                onChange={(v) => update("publicWorksDirector", v)}
              />
            </div>
            <div className="mcl-row-2">
              <Input
                label="Urban planner"
                value={form.urbanPlanner ?? ""}
                onChange={(v) => update("urbanPlanner", v)}
              />
              <Input
                label="Building inspector"
                value={form.buildingInspector ?? ""}
                onChange={(v) => update("buildingInspector", v)}
              />
            </div>
            <div className="mcl-row-2">
              <Input
                label="Permits"
                value={form.permits ?? ""}
                onChange={(v) => update("permits", v)}
              />
              <Input
                label="Communications"
                value={form.communications ?? ""}
                onChange={(v) => update("communications", v)}
              />
            </div>
            <Input
              label="Emergency measures"
              value={form.emergencyMeasures ?? ""}
              onChange={(v) => update("emergencyMeasures", v)}
            />
          </Section>

          <Section title="Notes">
            <Textarea
              label="Free-form notes"
              value={form.notes ?? ""}
              rows={4}
              onChange={(v) => update("notes", v)}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="mcl-input-label">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mcl-input"
      />
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="mcl-input-label">
      <span>{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="mcl-input mcl-textarea"
      />
    </label>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: { msg: string; err?: boolean } | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  return (
    <div
      className={`mcl-toast ${toast.err ? "err" : ""}`}
      onClick={onDismiss}
      role="status"
    >
      {toast.msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles — scoped to .mcl- classes, kept inline so this view is
// self-contained (matches the pattern used by the existing
// MunicipalContactsView).
// ─────────────────────────────────────────────────────────────────────
function Styles() {
  return (
    <style>{`
      .mcl-wrap {
        max-width: 1280px;
        margin: 0 auto;
        padding: 20px 28px 48px;
        color: var(--lb-text);
      }

      .mcl-empty {
        background: var(--lb-bg-elev);
        border: 1px dashed var(--lb-border);
        border-radius: 14px;
        padding: 36px 32px;
        text-align: center;
        color: var(--lb-text-2);
      }
      .mcl-empty h2 { margin: 0 0 8px; color: var(--lb-text); }
      .mcl-empty pre {
        background: var(--lb-bg);
        border: 1px solid var(--lb-border);
        padding: 10px 12px;
        border-radius: 8px;
        font-size: 12.5px;
        overflow-x: auto;
        margin: 12px auto;
        max-width: 600px;
      }

      /* Toolbar */
      .mcl-toolbar {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }

      /* Export buttons row — sits between the search/add toolbar and
         the filter pills. The CSS hairline before the CSV button reads
         as: "[HubSpot new] [HubSpot all] | [raw CSV]". */
      .mcl-export-bar {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .mcl-export-bar .mcl-btn { height: 36px; font-size: 12.5px; }
      .mcl-csv-btn {
        margin-left: 8px;
        position: relative;
      }
      .mcl-csv-btn::before {
        content: "";
        position: absolute;
        left: -10px;
        top: 8px;
        bottom: 8px;
        width: 1px;
        background: var(--lb-border);
      }
      .mcl-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .mcl-search {
        flex: 1;
        height: 42px;
        padding: 0 16px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: var(--lb-radius-pill);
        color: var(--lb-text);
        font-size: 14px;
        outline: none;
      }
      .mcl-search:focus { border-color: var(--lb-accent); }

      /* Filters */
      .mcl-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
        align-items: center;
      }
      .mcl-select {
        height: 36px;
        padding: 0 30px 0 14px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: var(--lb-radius-pill);
        color: var(--lb-text);
        font-size: 13px;
        outline: none;
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%23999' d='M0 0l5 6 5-6z'/></svg>");
        background-repeat: no-repeat;
        background-position: right 12px center;
        max-width: 260px;
      }
      .mcl-pill-row {
        display: flex;
        gap: 4px;
        align-items: center;
        padding-left: 4px;
      }
      .mcl-pill {
        height: 30px;
        padding: 0 12px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: var(--lb-radius-pill);
        color: var(--lb-text-2);
        font-size: 12px;
        cursor: pointer;
        transition: background 120ms, color 120ms, border-color 120ms;
      }
      .mcl-pill:hover { color: var(--lb-text); }
      .mcl-pill.active {
        background: var(--lb-accent);
        color: var(--lb-accent-fg);
        border-color: var(--lb-accent);
      }
      .mcl-clear {
        background: transparent;
        border: none;
        color: var(--lb-text-3);
        font-size: 12px;
        text-decoration: underline;
        cursor: pointer;
        margin-left: 4px;
      }
      .mcl-clear:hover { color: var(--lb-text-2); }

      /* Stats */
      .mcl-stats {
        font-size: 12.5px;
        color: var(--lb-text-3);
        padding: 6px 2px 14px;
      }
      .mcl-stats strong { color: var(--lb-text); font-weight: 700; }
      .mcl-stats-page { color: var(--lb-text-3); }

      /* Grid */
      .mcl-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px;
      }
      .mcl-no-results {
        grid-column: 1 / -1;
        padding: 28px;
        text-align: center;
        color: var(--lb-text-3);
        font-size: 13px;
        background: var(--lb-bg-elev);
        border: 1px dashed var(--lb-border);
        border-radius: 12px;
      }

      /* Card */
      .mcl-card {
        text-align: left;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: 12px;
        padding: 14px 16px;
        cursor: pointer;
        color: var(--lb-text);
        font-family: inherit;
        transition: border-color 140ms, transform 100ms, box-shadow 140ms;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .mcl-card:hover {
        border-color: var(--lb-accent);
        transform: translateY(-1px);
      }
      .mcl-card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }
      .mcl-card-name {
        font-size: 14.5px;
        font-weight: 700;
        letter-spacing: -0.005em;
        line-height: 1.25;
      }
      .mcl-card-type {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--lb-text-3);
        flex-shrink: 0;
      }
      .mcl-card-region {
        font-size: 12px;
        color: var(--lb-text-2);
      }
      .mcl-card-meta {
        font-size: 12px;
        color: var(--lb-text-2);
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .mcl-card-contact {
        font-size: 12px;
        color: var(--lb-text-2);
        margin-top: 4px;
        border-top: 1px solid var(--lb-border);
        padding-top: 8px;
      }
      .mcl-card-email {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Pager */
      .mcl-pager {
        display: flex;
        gap: 12px;
        align-items: center;
        justify-content: center;
        padding: 24px 0 8px;
      }
      .mcl-pager-btn {
        height: 36px;
        padding: 0 16px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: var(--lb-radius-pill);
        color: var(--lb-text);
        cursor: pointer;
        font-size: 13px;
      }
      .mcl-pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .mcl-pager-num { font-size: 13px; color: var(--lb-text-2); }

      /* Buttons */
      .mcl-btn {
        height: 38px;
        padding: 0 16px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: var(--lb-radius-pill);
        color: var(--lb-text);
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
      }
      .mcl-btn:hover { border-color: var(--lb-accent); }
      .mcl-btn-primary {
        background: var(--lb-accent);
        color: var(--lb-accent-fg);
        border-color: var(--lb-accent);
        font-weight: 600;
      }
      .mcl-btn-primary:hover { filter: brightness(1.05); }
      .mcl-btn-danger {
        background: transparent;
        color: #ff6b6b;
        border-color: rgba(255, 107, 107, 0.4);
      }
      .mcl-btn-danger:hover {
        background: rgba(255, 107, 107, 0.1);
        border-color: #ff6b6b;
      }
      .mcl-btn-close {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: transparent;
        border: 1px solid var(--lb-border);
        color: var(--lb-text-2);
        cursor: pointer;
        font-size: 14px;
      }
      .mcl-btn-close:hover { color: var(--lb-text); }

      /* Drawer */
      .mcl-drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        z-index: 50;
        display: flex;
        justify-content: flex-end;
      }
      .mcl-drawer {
        width: min(640px, 92vw);
        height: 100vh;
        background: var(--lb-bg);
        border-left: 1px solid var(--lb-border);
        display: flex;
        flex-direction: column;
      }
      .mcl-drawer-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 22px;
        border-bottom: 1px solid var(--lb-border);
        flex-shrink: 0;
      }
      .mcl-drawer-name {
        font-size: 19px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--lb-text);
      }
      .mcl-drawer-type {
        font-size: 12px;
        color: var(--lb-text-3);
        margin-top: 2px;
      }
      .mcl-drawer-gentile { color: var(--lb-text-2); }
      .mcl-drawer-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .mcl-drawer-body {
        overflow-y: auto;
        padding: 18px 22px;
        flex: 1;
      }

      /* Sections / fields */
      .mcl-section {
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--lb-border);
      }
      .mcl-section:last-child { border-bottom: none; }
      .mcl-section-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--lb-text-3);
        margin-bottom: 10px;
      }
      .mcl-section-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .mcl-field {
        display: grid;
        grid-template-columns: 130px 1fr;
        gap: 12px;
        font-size: 13px;
      }
      .mcl-field-label {
        color: var(--lb-text-3);
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        padding-top: 1px;
      }
      .mcl-field-value { color: var(--lb-text); word-break: break-word; }
      .mcl-field-value a { color: var(--lb-accent); }

      .mcl-councillor-list ul {
        list-style: none;
        padding: 4px 0 0;
        margin: 6px 0 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px 12px;
      }
      .mcl-councillor-list li {
        font-size: 13px;
        color: var(--lb-text);
        padding: 4px 0;
      }
      .mcl-notes {
        font-size: 13px;
        color: var(--lb-text);
        white-space: pre-wrap;
        background: var(--lb-bg-elev);
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--lb-border);
      }

      /* Inputs */
      .mcl-input-label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--lb-text-3);
      }
      .mcl-input {
        height: 36px;
        padding: 0 12px;
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        border-radius: 8px;
        color: var(--lb-text);
        font-size: 13.5px;
        font-family: inherit;
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
        outline: none;
      }
      .mcl-input:focus { border-color: var(--lb-accent); }
      .mcl-textarea {
        height: auto;
        padding: 8px 12px;
        line-height: 1.4;
        resize: vertical;
      }
      .mcl-row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      /* Toast */
      .mcl-toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--lb-bg-elev);
        border: 1px solid var(--lb-border);
        color: var(--lb-text);
        padding: 12px 20px;
        border-radius: var(--lb-radius-pill);
        font-size: 13px;
        z-index: 100;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      }
      .mcl-toast.err {
        border-color: #ff6b6b;
        color: #ff6b6b;
      }

      @media (max-width: 600px) {
        .mcl-field { grid-template-columns: 1fr; gap: 2px; }
        .mcl-row-2 { grid-template-columns: 1fr; }
        .mcl-councillor-list ul { grid-template-columns: 1fr; }
      }
    `}</style>
  );
}
