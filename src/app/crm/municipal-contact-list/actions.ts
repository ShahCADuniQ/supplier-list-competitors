"use server";

// Tools / Municipal Contact List — CRUD for the curated directory of
// Quebec municipalities. The list is seeded by
// `scripts/import-quebec-municipalities.ts` from the MAMH CSV; users can
// then add new cards (e.g. an out-of-province municipality), edit any
// field, or delete entries that aren't useful to them.

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  municipalityListEntries,
  municipalityListExports,
  type MunicipalityListEntry,
} from "@/db/schema";
import { getOrCreateProfile, canEdit } from "@/lib/permissions";

// ── Public input shape ────────────────────────────────────────────────
// Same field set as the table minus auto-managed columns. All optional
// except `name`. The form sends partial updates; we strip undefined so
// the user can clear a field by passing "" (becomes null on write).
export type EntryInput = {
  name: string;
  designation?: string | null;
  gentile?: string | null;
  email?: string | null;
  website?: string | null;
  phone?: string | null;
  fax?: string | null;
  addressLine?: string | null;
  addressCity?: string | null;
  addressPostal?: string | null;
  region?: string | null;
  mrc?: string | null;
  population?: number | null;
  mayor?: string | null;
  councillors?: string[] | null;
  directorGeneral?: string | null;
  treasurer?: string | null;
  clerk?: string | null;
  policeChief?: string | null;
  fireChief?: string | null;
  recreationDirector?: string | null;
  publicWorksDirector?: string | null;
  emergencyMeasures?: string | null;
  urbanPlanner?: string | null;
  communications?: string | null;
  permits?: string | null;
  buildingInspector?: string | null;
  notes?: string | null;
};

type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function requireEditor() {
  const profile = await getOrCreateProfile();
  if (!profile) return { ok: false as const, error: "Not signed in" };
  if (!canEdit(profile))
    return { ok: false as const, error: "Read-only access" };
  return { ok: true as const, profile };
}

// ── Normalize input ──────────────────────────────────────────────────
// "" → null so blank fields don't litter the DB with empty strings.
// Trim every string. Keep arrays as-is (UI sends already-cleaned lists).
function clean<T extends Record<string, unknown>>(input: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (typeof v === "string") {
      const t = v.trim();
      out[k] = t === "" ? null : t;
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ── Create ────────────────────────────────────────────────────────────
export async function createEntry(
  input: EntryInput,
): Promise<ActionResult<MunicipalityListEntry>> {
  const auth = await requireEditor();
  if (!auth.ok) return auth;

  const data = clean(input);
  if (!data.name) return { ok: false, error: "Name is required" };

  try {
    const [row] = await db
      .insert(municipalityListEntries)
      .values({
        ...data,
        // User-added rows don't come from the import, so re-imports
        // won't overwrite them.
        isImported: false,
        createdByClerkId: auth.profile.clerkUserId,
      })
      .returning();
    revalidatePath("/crm/municipal-contact-list");
    return { ok: true, data: row };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Insert failed",
    };
  }
}

// ── Update ────────────────────────────────────────────────────────────
export async function updateEntry(
  id: number,
  input: EntryInput,
): Promise<ActionResult<MunicipalityListEntry>> {
  const auth = await requireEditor();
  if (!auth.ok) return auth;

  const data = clean(input);
  if (!data.name) return { ok: false, error: "Name is required" };

  try {
    const [row] = await db
      .update(municipalityListEntries)
      .set({
        ...data,
        // Once a user has touched a card, mark it as no longer
        // import-managed so re-imports don't blow away their edits.
        isImported: false,
        updatedAt: new Date(),
      })
      .where(eq(municipalityListEntries.id, id))
      .returning();

    if (!row) return { ok: false, error: "Entry not found" };
    revalidatePath("/crm/municipal-contact-list");
    return { ok: true, data: row };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Update failed",
    };
  }
}

// ── Delete ────────────────────────────────────────────────────────────
export async function deleteEntry(id: number): Promise<ActionResult> {
  const auth = await requireEditor();
  if (!auth.ok) return auth;

  try {
    await db
      .delete(municipalityListEntries)
      .where(eq(municipalityListEntries.id, id));
    revalidatePath("/crm/municipal-contact-list");
    return { ok: true, data: undefined };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Delete failed",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// HUBSPOT EXPORT — same pattern as the lead-generator tab.
//
//   • mode "new":  only entries the CURRENT user hasn't exported yet.
//                  Stamps them as exported afterward so the next run
//                  picks up only the diff.
//   • mode "all":  every entry in `entryIds`. Stamps all of them.
//                  Use to ship the full filtered set into HubSpot
//                  (e.g. after switching the active filter).
//   • mode "everything": every entry in `entryIds` but DOES NOT change
//                  export state. Used by the plain CSV button so it
//                  doesn't poison the "N new" counter.
//
// `entryIds` is whatever the user has filtered to in the UI — so a region
// or population filter narrows the export naturally without needing
// server-side filter duplication.
//
// HubSpot row-per-PERSON: each municipality contributes one row for the
// mayor + one row per councillor + one row per filled admin role. Company
// = the municipality name; phone/email come from the municipality's
// general contact (we don't have per-person contact details). That makes
// the import create one Contact per official, all linked to the same
// Company in HubSpot.
// ─────────────────────────────────────────────────────────────────────

export type HubspotExportMode = "new" | "all" | "everything";

export type HubspotExportInput = {
  mode: HubspotExportMode;
  entryIds: number[];
};

export type HubspotExportResult = {
  csv: string;
  fileName: string;
  // Number of HubSpot rows generated (people, not municipalities).
  exportedRowCount: number;
  // Number of municipality entries actually included.
  exportedEntryCount: number;
};

export async function exportListToHubspot(
  input: HubspotExportInput,
): Promise<ActionResult<HubspotExportResult>> {
  const profile = await getOrCreateProfile();
  if (!profile) return { ok: false, error: "Sign in required" };

  const ids = input.entryIds.filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    return { ok: false, error: "No entries selected" };
  }

  // Pull the user's existing exports for this entry set so we can
  // narrow to "new" rows when requested.
  const myExports = await db
    .select({ entryId: municipalityListExports.entryId })
    .from(municipalityListExports)
    .where(eq(municipalityListExports.clerkUserId, profile.clerkUserId));
  const myExportedIds = new Set(myExports.map((e) => e.entryId));

  const idsToFetch =
    input.mode === "new"
      ? ids.filter((id) => !myExportedIds.has(id))
      : ids;

  if (idsToFetch.length === 0) {
    return {
      ok: true,
      data: {
        csv: "",
        fileName: "",
        exportedRowCount: 0,
        exportedEntryCount: 0,
      },
    };
  }

  const entries = await db
    .select()
    .from(municipalityListEntries)
    .where(inArray(municipalityListEntries.id, idsToFetch));

  const csv = buildHubspotCsv(entries);

  const exportedAt = new Date();
  if (input.mode !== "everything") {
    // Upsert one tracking row per (entry, user). Refresh exported_at
    // even on conflict so the user can see "last exported on X" later.
    await db
      .insert(municipalityListExports)
      .values(
        entries.map((e) => ({
          entryId: e.id,
          clerkUserId: profile.clerkUserId,
          exportedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          municipalityListExports.entryId,
          municipalityListExports.clerkUserId,
        ],
        set: { exportedAt },
      });
  }

  const stamp = exportedAt
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const fileName = `hubspot-municipalities-${input.mode}-${stamp}.csv`;

  // Count HubSpot rows by re-tallying — quicker than threading the count
  // through `buildHubspotCsv`, and the CSV string already has it
  // implicitly (line count - 1 header).
  const rowCount = csv ? csv.split("\r\n").filter(Boolean).length - 1 : 0;

  revalidatePath("/crm/municipal-contact-list");

  return {
    ok: true,
    data: {
      csv,
      fileName,
      exportedRowCount: rowCount,
      exportedEntryCount: entries.length,
    },
  };
}

/**
 * Build a HubSpot-import-ready CSV. One row per PERSON: mayor, each
 * councillor, and each filled admin role. Company = municipality name so
 * HubSpot links every contact to the same Company record on import.
 *
 * UTF-8 BOM is prepended so Excel renders accented French names
 * correctly when the user opens the file before re-importing.
 */
function buildHubspotCsv(
  entries: Array<typeof municipalityListEntries.$inferSelect>,
): string {
  const headers = [
    "First Name",
    "Last Name",
    "Email",
    "Phone Number",
    "Job Title",
    "Company",
    "Website",
    "Address",
    "City",
    "State/Region",
    "Country/Region",
    "Lead Source",
    "Department",
    "Municipality Type",
    "MRC",
    "Population",
    "Notes",
  ];

  const lines: string[] = [headers.map(csvCell).join(",")];

  // Named admin roles in display order. Each becomes a Contact row if
  // the field is filled. "Sector" is the canonical bucket name we'd use
  // in the HubSpot Sector property — matches the lead-generator tab.
  const adminRoles: Array<{
    field: keyof MunicipalityListEntry;
    title: string;
    sector: string;
  }> = [
    { field: "directorGeneral", title: "Director General", sector: "Administration" },
    { field: "deputyDg", title: "Deputy Director General", sector: "Administration" },
    { field: "treasurer", title: "Treasurer", sector: "Administration" },
    { field: "clerk", title: "Clerk / Greffier", sector: "Administration" },
    { field: "policeChief", title: "Police Chief", sector: "Public Safety" },
    { field: "fireChief", title: "Fire Chief", sector: "Public Safety" },
    { field: "recreationDirector", title: "Recreation Director", sector: "Recreation" },
    { field: "publicWorksDirector", title: "Public Works Director", sector: "Public Works" },
    { field: "emergencyMeasures", title: "Emergency Measures", sector: "Public Safety" },
    { field: "urbanPlanner", title: "Urban Planner", sector: "Engineering" },
    { field: "communications", title: "Communications", sector: "Administration" },
    { field: "permits", title: "Permits", sector: "Engineering" },
    { field: "buildingInspector", title: "Building Inspector", sector: "Engineering" },
  ];

  for (const e of entries) {
    const company = (e.name ?? "").trim();
    const website = (e.website ?? "").trim();
    const phone = formatPhone(e.phone);
    const email = (e.email ?? "").trim();
    const muniType = (e.designation ?? "").trim();
    const mrc = (e.mrc ?? "").trim();
    const population = e.population == null ? "" : String(e.population);
    const region = (e.region ?? "Quebec").trim();
    const city = (e.addressCity ?? "").trim();
    const address = [e.addressLine, e.addressCity, e.addressPostal]
      .filter(Boolean)
      .join(", ");

    function pushRow(
      personName: string,
      jobTitle: string,
      department: string,
    ) {
      const { firstName, lastName } = splitName(personName);
      lines.push(
        [
          firstName,
          lastName,
          email,
          phone,
          jobTitle,
          company,
          website,
          address,
          city,
          region,
          "Canada",
          "Lightbase municipal contact list",
          department,
          muniType,
          mrc,
          population,
          (e.notes ?? "").trim(),
        ]
          .map(csvCell)
          .join(","),
      );
    }

    if (e.mayor && e.mayor.trim()) pushRow(e.mayor, "Mayor", "Elected");
    const councillors = (e.councillors as string[] | null) ?? [];
    for (const c of councillors) {
      const t = c.trim();
      if (!t || /^poste vacant/i.test(t) || /^vacant/i.test(t)) continue;
      pushRow(t, "Councillor", "Elected");
    }
    for (const role of adminRoles) {
      const v = (e[role.field] as string | null | undefined)?.trim();
      if (!v) continue;
      // Filter out "Poste Vacant" / placeholder values so HubSpot doesn't
      // get a Contact named "Vacant".
      if (/^poste vacant/i.test(v) || /^vacant/i.test(v)) continue;
      pushRow(v, role.title, role.sector);
    }
  }

  // CRLF + UTF-8 BOM for Excel compatibility.
  const BOM = "﻿";
  return BOM + lines.join("\r\n") + "\r\n";
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const t = full.trim().replace(/\s+/g, " ");
  if (!t) return { firstName: "", lastName: "" };
  const parts = t.split(" ");
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function formatPhone(p: string | null | undefined): string {
  if (!p) return "";
  return p.trim().replace(/\s+/g, " ");
}

/**
 * Per-user "have I exported this entry yet?" set. Returns a plain
 * number[] so the page server-component can pre-fetch it once and
 * pass to the client view, where it drives the "↓ HubSpot — N new"
 * count without an extra round-trip per filter change.
 */
export async function getMyExportedEntryIds(): Promise<number[]> {
  const profile = await getOrCreateProfile();
  if (!profile) return [];
  const rows = await db
    .select({ entryId: municipalityListExports.entryId })
    .from(municipalityListExports)
    .where(eq(municipalityListExports.clerkUserId, profile.clerkUserId));
  return rows.map((r) => r.entryId);
}
