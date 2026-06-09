// Smoke for filterForCatalogue. Run: npx tsx scripts/test-supplier-scope-filter.ts
import { filterForCatalogue } from "../src/app/suppliers/_dedupe-parts";

type Row = {
  id: number;
  kind: "standalone" | "parent" | "configuration";
  isPrimarySupplier: boolean;
  primaryConfigCount: number;
};

function row(
  id: number,
  kind: Row["kind"],
  isPrimary = false,
  primaryConfigCount = 0,
): Row {
  return { id, kind, isPrimarySupplier: isPrimary, primaryConfigCount };
}

function expect(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const standaloneA = row(1, "standalone", true);
const standaloneB = row(2, "standalone", false);
const parentA = row(3, "parent", false, 1); // 1 of N configs primary
const parentB = row(4, "parent", false, 0); // no primary configs
const configA = row(5, "configuration", true);
const configB = row(6, "configuration", false);

const all = [standaloneA, standaloneB, parentA, parentB, configA, configB];

// viewMode=all → hide parents, keep standalones + configurations.
const allNoPrimary = filterForCatalogue(all, "all", false);
expect(
  `all/no-primary keeps 2 standalones + 2 configurations, hides 2 parents — got ${allNoPrimary
    .map((r) => r.id)
    .sort()
    .join(",")}`,
  allNoPrimary.length === 4 &&
    allNoPrimary.every((r) => r.kind !== "parent"),
);

const allPrimary = filterForCatalogue(all, "all", true);
expect(
  `all/primary keeps only primary standalones + primary configs — got ${allPrimary
    .map((r) => r.id)
    .sort()
    .join(",")}`,
  allPrimary.length === 2 &&
    allPrimary.every((r) => r.isPrimarySupplier && r.kind !== "parent"),
);

const parentsNoPrimary = filterForCatalogue(all, "parents", false);
expect(
  `parents/no-primary keeps both parents AND both standalones, hides configs — got ${parentsNoPrimary
    .map((r) => r.id)
    .sort()
    .join(",")}`,
  parentsNoPrimary.length === 4 &&
    parentsNoPrimary.every((r) => r.kind !== "configuration"),
);

const parentsPrimary = filterForCatalogue(all, "parents", true);
expect(
  `parents/primary keeps parents with primary configs + standalones marked primary — got ${parentsPrimary
    .map((r) => r.id)
    .sort()
    .join(",")}`,
  parentsPrimary.length === 2 &&
    parentsPrimary.some((r) => r.id === parentA.id) &&
    parentsPrimary.some((r) => r.id === standaloneA.id),
);
