// One-off cleanup: delete every ideation item across all collections.
// User explicitly requested this in the chat ("delete every pic from
// ideation"). Run once with: npx tsx --env-file=.env scripts/clear-ideation.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(url);

async function main() {
  const before = await sql.query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE blob_pathname IS NOT NULL)::int AS uploaded FROM competitor_ideation_items`,
  ) as Array<{ n: number; uploaded: number }>;
  const total = before[0].n;
  const uploaded = before[0].uploaded;
  console.log(`Before: ${total} ideation item(s) (${uploaded} with uploaded blobs)`);

  if (total === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // Note: this only drops DB rows. Pinterest URLs are on i.pinimg.com and
  // not ours to delete. For uploaded blobs (Vercel Blob), the user can
  // re-run the per-item delete from the UI if they want those purged too —
  // for the current request the blob bytes will simply be orphaned.
  await sql.query(`DELETE FROM competitor_ideation_items`);
  const after = await sql.query(
    `SELECT COUNT(*)::int AS n FROM competitor_ideation_items`,
  ) as Array<{ n: number }>;
  console.log(`After: ${after[0].n} ideation item(s)`);
  console.log(`\nDeleted ${total} row(s). Done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
