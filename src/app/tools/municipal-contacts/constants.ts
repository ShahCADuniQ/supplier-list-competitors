// Constants shared between the server actions, the page, and the client UI.
// Lives in its own file so it can be imported into the "use server" actions
// file without violating the "all exports must be async" rule.

export const CANADIAN_PROVINCES = [
  { code: "QC", name: "Quebec" },
  { code: "ON", name: "Ontario" },
  { code: "BC", name: "British Columbia" },
  { code: "AB", name: "Alberta" },
  { code: "MB", name: "Manitoba" },
  { code: "SK", name: "Saskatchewan" },
  { code: "NS", name: "Nova Scotia" },
  { code: "NB", name: "New Brunswick" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "YT", name: "Yukon" },
  { code: "NT", name: "Northwest Territories" },
  { code: "NU", name: "Nunavut" },
] as const;

export const SCOPE_TYPES = [
  { code: "city", label: "Cities" },
  { code: "town", label: "Towns" },
  { code: "village", label: "Villages" },
  { code: "municipality", label: "Other municipalities" },
] as const;

/**
 * Sector definitions = canonical category buckets.
 *
 * - `code` is the value stored in `municipality_contacts.category` and the
 *   value users pick in the form's "Sectors" pre-filter.
 * - `label` is shown in pills, tags, and the saved-searches list.
 * - `promptHint` is the long-form description Perplexity sees so its
 *   research lines up with the bucket Claude later classifies into.
 */
export const SECTOR_OPTIONS = [
  {
    code: "engineering",
    label: "Engineering services",
    promptHint:
      "Engineering / génie municipal — Director of Engineering, City Engineer, Chief Engineer, Civil Engineer, Traffic Engineer, Geomatics, Project Engineer, Service du génie",
  },
  {
    code: "public-works",
    label: "Public Works",
    promptHint:
      "Public Works / Travaux publics — Director of Public Works, Infrastructure, Roads, Water, Sewer, Wastewater, Voirie",
  },
  {
    code: "administration",
    label: "Administration",
    promptHint:
      "Administration — City Manager, Director General / Directeur général (DG), Town Clerk / Greffier(ère), City Hall, Finance, Procurement, HR",
  },
  {
    code: "elected",
    label: "Elected officials",
    promptHint:
      "Elected officials — Mayor / Maire, Deputy Mayor, Councillors / Conseillers municipaux",
  },
  {
    code: "planning",
    label: "Urban planning",
    promptHint:
      "Urban planning / Urbanisme — Director of Planning, Urban Planner / Urbaniste, Land use, Zoning, Permits",
  },
  {
    code: "parks",
    label: "Parks & Recreation",
    promptHint:
      "Parks & Recreation / Parcs et loisirs — Director of Parks, Sports facilities, Recreation programs, Loisirs",
  },
  {
    code: "environment",
    label: "Environment",
    promptHint:
      "Environment / Environnement — Sustainability, Climate, Sanitation / Matières résiduelles, Recycling, Sustainable development",
  },
  {
    code: "fire",
    label: "Fire & Emergency",
    promptHint:
      "Fire & Emergency / Service de sécurité incendie — Fire Chief / Directeur du SSI, Public safety, Civil security",
  },
  {
    code: "police",
    label: "Police",
    promptHint:
      "Police — Chief of Police, Police Department / Service de police, Public Safety Liaison",
  },
  {
    code: "other",
    label: "Other",
    promptHint:
      "Other notable departments not covered above — IT, Communications, Library / Bibliothèque, Tourism / Tourisme",
  },
] as const;

export type SectorCode = (typeof SECTOR_OPTIONS)[number]["code"];
export const ALL_SECTOR_CODES: readonly string[] = SECTOR_OPTIONS.map((s) => s.code);

/** Back-compat: parts of the UI still call these "categories". */
export const CONTACT_CATEGORIES = SECTOR_OPTIONS;

export function sectorLabel(code: string | null | undefined): string {
  return SECTOR_OPTIONS.find((s) => s.code === code)?.label ?? "Other";
}

/** Alias kept for old call sites. */
export const categoryLabel = sectorLabel;

/** Quick-pick chips next to the count input. Free-form values work too. */
export const COUNT_OPTIONS = [5, 10, 25, 50, 100, 200] as const;
export const COUNT_MIN = 1;
export const COUNT_MAX = 200;

export type CategoryCode = SectorCode;
