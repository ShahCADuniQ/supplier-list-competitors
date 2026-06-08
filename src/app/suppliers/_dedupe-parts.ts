// Pure dedup for the Supplier Catalogue scope toggle.
// Lives in its own file so smoke tests (scripts/test-supplier-scope-filter.ts)
// can import it without dragging in the rest of the supplier-overview module
// (which transitively loads the DB client + React hooks).

// "all"             → every catalogue row, no dedup.
// "one-per-product" → exactly one row per cluster (rows sharing a globalProductId).
//                     Pick the row marked isPrimarySupplier; if none, pick the
//                     row with the most recent updatedAt. Rows with no
//                     globalProductId are their own cluster of one and always show.
export type SupplierCatalogueScope = "all" | "one-per-product";

export function dedupeParts<
  T extends {
    globalProductId: string | null;
    isPrimarySupplier: boolean;
    updatedAt: Date;
  },
>(parts: T[], scope: SupplierCatalogueScope): T[] {
  if (scope === "all") return parts;
  const groups = new Map<string, T[]>();
  const standalones: T[] = [];
  for (const p of parts) {
    if (!p.globalProductId) {
      standalones.push(p);
      continue;
    }
    const arr = groups.get(p.globalProductId) ?? [];
    arr.push(p);
    groups.set(p.globalProductId, arr);
  }
  const representatives: T[] = [];
  for (const rows of groups.values()) {
    const primary = rows.find((r) => r.isPrimarySupplier);
    if (primary) {
      representatives.push(primary);
      continue;
    }
    const sortedByRecent = [...rows].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    representatives.push(sortedByRecent[0]);
  }
  return [...standalones, ...representatives];
}
