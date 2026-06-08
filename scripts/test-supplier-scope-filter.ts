// Quick smoke for dedupeParts. Run: npx tsx scripts/test-supplier-scope-filter.ts
import { dedupeParts } from "../src/app/suppliers/_dedupe-parts";

type Row = {
  id: number;
  globalProductId: string | null;
  isPrimarySupplier: boolean;
  updatedAt: Date;
};

function row(
  id: number,
  globalProductId: string | null,
  isPrimarySupplier: boolean,
  updatedAt: Date,
): Row {
  return { id, globalProductId, isPrimarySupplier, updatedAt };
}

function expect(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const t0 = new Date("2026-01-01");
const t1 = new Date("2026-02-01");
const t2 = new Date("2026-03-01");

// Cluster with a primary
const r1 = row(1, "gp-a", false, t0);
const r2 = row(2, "gp-a", true, t1);
const r3 = row(3, "gp-a", false, t2);
// Cluster with NO primary — must still surface ONE row (most recent)
const r4 = row(4, "gp-b", false, t0);
const r5 = row(5, "gp-b", false, t2);
// Standalone (null globalProductId) — always shows
const r6 = row(6, null, false, t1);

const all = [r1, r2, r3, r4, r5, r6];
const dedupAll = dedupeParts(all, "all");
expect("all mode returns every row", dedupAll.length === 6);

const dedup1 = dedupeParts(all, "one-per-product");
const ids = dedup1.map((r) => r.id).sort((a, b) => a - b);
expect(
  `one-per-product picks primary for gp-a, most-recent for gp-b, keeps standalone — got ids ${ids.join(",")}`,
  ids.length === 3 && ids.includes(2) && ids.includes(5) && ids.includes(6),
);

const dedupEmpty = dedupeParts([], "one-per-product");
expect("empty input is empty output", dedupEmpty.length === 0);
