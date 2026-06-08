// Smoke for filterByScope. Run: npx tsx scripts/test-supplier-scope-filter.ts
import { filterByScope } from "../src/app/suppliers/_dedupe-parts";

type Row = { id: number; isPrimarySupplier: boolean };

function row(id: number, isPrimary: boolean): Row {
  return { id, isPrimarySupplier: isPrimary };
}

function expect(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const rows = [
  row(1, false),
  row(2, true),
  row(3, false),
  row(4, true),
  row(5, false),
];

const all = filterByScope(rows, "all");
expect("all mode returns every row", all.length === 5);

const primary = filterByScope(rows, "primary");
const ids = primary.map((r) => r.id).sort((a, b) => a - b);
expect(
  `primary mode returns only rows with isPrimarySupplier=true — got ids ${ids.join(",")}`,
  ids.length === 2 && ids[0] === 2 && ids[1] === 4,
);

const emptyAll = filterByScope([], "all");
expect("empty input, all → empty", emptyAll.length === 0);

const emptyPrimary = filterByScope([], "primary");
expect("empty input, primary → empty", emptyPrimary.length === 0);

const nonePrimary = filterByScope([row(1, false), row(2, false)], "primary");
expect(
  "no primaries marked → empty list (intentional, see empty-state copy)",
  nonePrimary.length === 0,
);
