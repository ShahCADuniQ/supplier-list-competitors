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

export const CONTACT_CATEGORIES = [
  { code: "engineering", label: "Engineering" },
  { code: "public-works", label: "Public Works" },
  { code: "administration", label: "Administration" },
  { code: "elected", label: "Elected officials" },
  { code: "other", label: "Other" },
] as const;

export const COUNT_OPTIONS = [5, 10, 25, 50, 100] as const;

export type CategoryCode = (typeof CONTACT_CATEGORIES)[number]["code"];

export function categoryLabel(code: string | null | undefined): string {
  return CONTACT_CATEGORIES.find((c) => c.code === code)?.label ?? "Other";
}
