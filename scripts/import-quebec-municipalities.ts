// Import the MAMH "Répertoire des municipalités" CSV into the
// municipality_list_entries table.
//
// Usage:
//   1. Save the CSV to data/quebec-municipalities.csv
//   2. npx tsx --env-file=.env scripts/import-quebec-municipalities.ts
//
// Re-running is safe: rows are upserted by source_code (mcode). Rows the
// user has flagged as not-imported (`is_imported = false`) are left
// untouched so manual edits don't get clobbered.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sql as dsql } from "drizzle-orm";
import { db } from "../src/db";
import { municipalityListEntries } from "../src/db/schema";

const CSV_PATH = resolve("data/quebec-municipalities.csv");

if (!existsSync(CSV_PATH)) {
  console.error(`CSV not found at ${CSV_PATH}`);
  console.error("Save the CSV there and re-run this script.");
  process.exit(1);
}

// ── Minimal CSV parser ─────────────────────────────────────────────────
// Handles quoted fields, embedded commas, and "" escaped quotes. Doesn't
// handle quoted newlines (the source file is flat — each row is one
// physical line) so we can split by line first.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

// ── Field helpers ──────────────────────────────────────────────────────
function emptyToNull(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  // Source uses "0" in numeric phone/fax columns to mean "not set".
  return t;
}
function intOrNull(v: string | undefined): number | null {
  const t = emptyToNull(v);
  if (t == null) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
function numericOrNull(v: string | undefined): string | null {
  // Drizzle `numeric` columns expect strings; we keep them as-is so we
  // don't lose precision.
  const t = emptyToNull(v);
  return t;
}
function phoneOrNull(v: string | undefined): string | null {
  const t = emptyToNull(v);
  if (t == null) return null;
  if (t === "0") return null;
  // Strip all whitespace; format as XXX-XXX-XXXX if it's a 10-digit number.
  const digits = t.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return t;
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`Reading ${CSV_PATH}…`);
  const raw = readFileSync(CSV_PATH, "utf8");
  const { headers, rows } = parseCsv(raw);
  console.log(`Parsed ${rows.length} rows with ${headers.length} columns.`);

  // Build a column → index lookup so we can grab fields by name.
  const idx = new Map<string, number>();
  headers.forEach((h, i) => idx.set(h.trim(), i));

  function get(row: string[], col: string): string | undefined {
    const i = idx.get(col);
    return i == null ? undefined : row[i];
  }

  // Pull the up-to-75 con1..conN columns into a single array, dropping
  // empty cells. Source data has many trailing empties.
  function gatherCouncillors(row: string[]): string[] {
    const list: string[] = [];
    for (let i = 1; i <= 75; i++) {
      const v = emptyToNull(get(row, `con${i}`));
      if (v) list.push(v);
    }
    return list;
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Insert in chunks so we don't blow up the connection on a 1k-row batch.
  const CHUNK = 50;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = chunk.map((row) => {
      const sourceCode = emptyToNull(get(row, "mcode"));
      const name = emptyToNull(get(row, "munnom")) ?? "(unnamed)";
      return {
        sourceCode,
        name,
        designationCode: intOrNull(get(row, "mcodedesi")),
        designation: emptyToNull(get(row, "mdes")),
        gentile: emptyToNull(get(row, "mgentile")),
        email: emptyToNull(get(row, "mcourriel")),
        website: emptyToNull(get(row, "mweb")),
        phone: phoneOrNull(get(row, "mtel")),
        fax: phoneOrNull(get(row, "mfax")),
        addressLine: emptyToNull(get(row, "madr1")),
        addressCity: emptyToNull(get(row, "madr2")),
        addressPostal: emptyToNull(get(row, "mcodpos")),
        region: emptyToNull(get(row, "regadm")),
        mrc: emptyToNull(get(row, "mrc")),
        mrcFull: emptyToNull(get(row, "admregionale")),
        areaKm2: numericOrNull(get(row, "msuperf")),
        population: intOrNull(get(row, "mpopul")),
        dateIncorporation: emptyToNull(get(row, "mdatcons")),
        dateElection: emptyToNull(get(row, "datelec")),
        electionMode: emptyToNull(get(row, "delecmode")),
        circonscription: emptyToNull(get(row, "mcirc")),
        mayor: emptyToNull(get(row, "maire")),
        councillors: gatherCouncillors(row),
        directorGeneral: emptyToNull(get(row, "dirgen")),
        deputyDg: emptyToNull(get(row, "dirsecpub")),
        treasurer: emptyToNull(get(row, "tres")),
        clerk: emptyToNull(get(row, "gref")),
        policeChief: emptyToNull(get(row, "polic")),
        fireChief: emptyToNull(get(row, "incen")),
        recreationDirector: emptyToNull(get(row, "loisir")),
        publicWorksDirector: emptyToNull(get(row, "trvpub")),
        emergencyMeasures: emptyToNull(get(row, "mesurg")),
        urbanPlanner: emptyToNull(get(row, "urban")),
        communications: emptyToNull(get(row, "communic")),
        permits: emptyToNull(get(row, "permis")),
        buildingInspector: emptyToNull(get(row, "batim")),
        isImported: true,
      };
    });

    try {
      // Upsert by source_code: if a row already exists with the same
      // mcode AND the user hasn't taken it over (is_imported still true),
      // refresh the imported fields. Otherwise keep the user's edits.
      const result = await db
        .insert(municipalityListEntries)
        .values(values)
        .onConflictDoUpdate({
          target: municipalityListEntries.sourceCode,
          set: {
            name: dsql`EXCLUDED.name`,
            designationCode: dsql`EXCLUDED.designation_code`,
            designation: dsql`EXCLUDED.designation`,
            gentile: dsql`EXCLUDED.gentile`,
            email: dsql`EXCLUDED.email`,
            website: dsql`EXCLUDED.website`,
            phone: dsql`EXCLUDED.phone`,
            fax: dsql`EXCLUDED.fax`,
            addressLine: dsql`EXCLUDED.address_line`,
            addressCity: dsql`EXCLUDED.address_city`,
            addressPostal: dsql`EXCLUDED.address_postal`,
            region: dsql`EXCLUDED.region`,
            mrc: dsql`EXCLUDED.mrc`,
            mrcFull: dsql`EXCLUDED.mrc_full`,
            areaKm2: dsql`EXCLUDED.area_km2`,
            population: dsql`EXCLUDED.population`,
            dateIncorporation: dsql`EXCLUDED.date_incorporation`,
            dateElection: dsql`EXCLUDED.date_election`,
            electionMode: dsql`EXCLUDED.election_mode`,
            circonscription: dsql`EXCLUDED.circonscription`,
            mayor: dsql`EXCLUDED.mayor`,
            councillors: dsql`EXCLUDED.councillors`,
            directorGeneral: dsql`EXCLUDED.director_general`,
            deputyDg: dsql`EXCLUDED.deputy_dg`,
            treasurer: dsql`EXCLUDED.treasurer`,
            clerk: dsql`EXCLUDED.clerk`,
            policeChief: dsql`EXCLUDED.police_chief`,
            fireChief: dsql`EXCLUDED.fire_chief`,
            recreationDirector: dsql`EXCLUDED.recreation_director`,
            publicWorksDirector: dsql`EXCLUDED.public_works_director`,
            emergencyMeasures: dsql`EXCLUDED.emergency_measures`,
            urbanPlanner: dsql`EXCLUDED.urban_planner`,
            communications: dsql`EXCLUDED.communications`,
            permits: dsql`EXCLUDED.permits`,
            buildingInspector: dsql`EXCLUDED.building_inspector`,
            updatedAt: dsql`now()`,
          },
          // Only refresh rows that haven't been taken over by a user.
          setWhere: dsql`${municipalityListEntries.isImported} = true`,
        })
        .returning({ id: municipalityListEntries.id });

      // We can't tell insert vs update from the returning clause alone,
      // so we count anything that came back as "touched". Skipped is
      // anything that conflicted on a user-locked row.
      const touched = result.length;
      inserted += touched;
      skipped += chunk.length - touched;
    } catch (e) {
      errors += chunk.length;
      console.error(
        `  chunk ${start}-${start + chunk.length - 1} failed:`,
        e instanceof Error ? `${e.name}: ${e.message}` : e,
      );
    }

    if ((start / CHUNK) % 5 === 0) {
      process.stdout.write(`  ${start + chunk.length}/${rows.length}…\n`);
    }
  }

  console.log(
    `\nDone. inserted/updated=${inserted}, skipped(user-locked)=${skipped}, errors=${errors}`,
  );
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
