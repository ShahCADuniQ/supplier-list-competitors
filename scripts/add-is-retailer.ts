// One-off: add `is_retailer` to user_profiles for the new retailer
// public-signup role. Idempotent.
//
// Run with: npx tsx --env-file=.env scripts/add-is-retailer.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = neon(url);

async function main() {
  await sql.query(`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "is_retailer" boolean NOT NULL DEFAULT false`);
  console.log("ok: ALTER TABLE add column");
  await sql.query(`CREATE INDEX IF NOT EXISTS "user_profiles_is_retailer_idx" ON "user_profiles" ("is_retailer")`);
  console.log("ok: CREATE INDEX");
  const cols = await sql.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='user_profiles'
       AND column_name LIKE 'is_%' ORDER BY column_name`,
  );
  console.log("is_* columns:", cols);
}
main().catch((e) => { console.error(e); process.exit(1); });
