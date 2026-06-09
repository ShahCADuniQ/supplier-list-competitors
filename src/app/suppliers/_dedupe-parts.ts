// Pure filter for the Supplier Catalogue view-mode toggle.
// Lives in its own file so smoke tests (scripts/test-supplier-scope-filter.ts)
// can import it without dragging in the rest of the supplier-overview module
// (which transitively loads the DB client + React hooks).
//
// Two orthogonal axes drive the rendering:
//
//   viewMode = "all"     → every purchasable unit
//     - every standalone part (no children of its own)
//     - every configuration row (rendered as its own card with thumbnail
//       and files inherited from the parent)
//     - parent cards are HIDDEN here because each parent is already
//       represented by its configurations
//
//   viewMode = "parents" → catalogue grouped by parent
//     - every parent part (those that have ≥ 1 configurations)
//     - configurations and standalones are HIDDEN
//
// Primary-only is an INDEPENDENT filter inside each view:
//
//   primaryOnly + viewMode="all"
//     - keep standalones where isPrimarySupplier=true
//     - keep configurations where isPrimarySupplier=true
//
//   primaryOnly + viewMode="parents"
//     - keep parents that have at least one configuration marked primary
//       (primaryConfigCount > 0)
//
// Rule (UI + server-enforced): a parent that has configurations is itself
// never eligible to be primary. Only its configurations are.

export type CatalogueViewMode = "all" | "parents";

export function filterForCatalogue<
  T extends {
    kind: "standalone" | "parent" | "configuration";
    isPrimarySupplier: boolean;
    primaryConfigCount: number;
  },
>(parts: T[], viewMode: CatalogueViewMode, primaryOnly: boolean): T[] {
  return parts.filter((p) => {
    if (viewMode === "all") {
      if (p.kind === "parent") return false;
      if (primaryOnly && !p.isPrimarySupplier) return false;
      return true;
    }
    // viewMode === "parents"
    if (p.kind !== "parent") return false;
    if (primaryOnly && p.primaryConfigCount === 0) return false;
    return true;
  });
}
