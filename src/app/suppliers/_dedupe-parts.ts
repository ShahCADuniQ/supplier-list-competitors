// Pure filter for the Supplier Catalogue scope toggle.
// Lives in its own file so smoke tests (scripts/test-supplier-scope-filter.ts)
// can import it without dragging in the rest of the supplier-overview module
// (which transitively loads the DB client + React hooks).

// "all"     → every catalogue row, no filtering.
// "primary" → only rows where isPrimarySupplier === true. Strict.
//             If you haven't marked anything primary yet, this view is empty —
//             open any product card and click "Mark as primary" inside it to
//             promote a row into this view.
export type SupplierCatalogueScope = "all" | "primary";

export function filterByScope<
  T extends { isPrimarySupplier: boolean },
>(parts: T[], scope: SupplierCatalogueScope): T[] {
  if (scope === "all") return parts;
  return parts.filter((p) => p.isPrimarySupplier === true);
}
