// Per-deployment client branding. Each CADuniQ client (e.g. Lightbase) runs on
// its own deployment of this codebase. This module is the single source of
// truth for "who is this dashboard for" and "which CADuniQ product line do
// they get" — drives the top-bar badge, signed-out hero, page metadata, and
// any other place the company name or industry appears.
//
// Defaults: the Lightbase manufacturing deployment.
// Override at deploy time via env vars (both are NEXT_PUBLIC_* so they reach
// client components without an extra round-trip):
//   NEXT_PUBLIC_CLIENT_NAME      — display name, e.g. "Acme Builders"
//   NEXT_PUBLIC_CLIENT_INDUSTRY  — "manufacturing" or "construction"

export type CaduniqIndustry = "manufacturing" | "construction";

function parseIndustry(v: string | undefined): CaduniqIndustry {
  return v?.toLowerCase() === "construction" ? "construction" : "manufacturing";
}

export const CLIENT_CONFIG = {
  name: process.env.NEXT_PUBLIC_CLIENT_NAME ?? "Lightbase",
  industry: parseIndustry(process.env.NEXT_PUBLIC_CLIENT_INDUSTRY),
} as const;

// "CADuniQ Manufacturing" or "CADuniQ Construction" — the visible product line
// label everywhere ownership is surfaced.
export const CADUNIQ_PRODUCT_LABEL =
  CLIENT_CONFIG.industry === "construction"
    ? "CADuniQ Construction"
    : "CADuniQ Manufacturing";

// Just the industry word, capitalised, for places that want "CADuniQ" + a
// softer-styled suffix.
export const CADUNIQ_INDUSTRY_SUFFIX =
  CLIENT_CONFIG.industry === "construction" ? "Construction" : "Manufacturing";
