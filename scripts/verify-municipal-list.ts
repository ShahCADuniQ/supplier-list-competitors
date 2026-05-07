// One-off sanity check after importing the Quebec municipality CSV.
// Confirms total count, samples the biggest cities, and shows the
// breakdown by designation so we can spot import issues at a glance.

import { db } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const total = await db.execute(
    sql`select count(*)::int as n from municipality_list_entries`,
  );
  const largest = await db.execute(
    sql`select name, designation, region, population, mayor from municipality_list_entries where population is not null order by population desc limit 5`,
  );
  const byType = await db.execute(
    sql`select designation, count(*)::int as n from municipality_list_entries group by designation order by n desc`,
  );
  const byRegion = await db.execute(
    sql`select region, count(*)::int as n from municipality_list_entries where region is not null group by region order by n desc limit 8`,
  );
  console.log("TOTAL:", total.rows[0]);
  console.log("\nLARGEST 5:");
  for (const r of largest.rows) console.log(" -", r);
  console.log("\nBY DESIGNATION:");
  for (const r of byType.rows) console.log(" -", r);
  console.log("\nTOP 8 REGIONS:");
  for (const r of byRegion.rows) console.log(" -", r);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
