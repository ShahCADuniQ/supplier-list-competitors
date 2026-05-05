// Direct migration runner — applies any drizzle SQL file that hasn't been
// applied yet. Uses @neondatabase/serverless directly because drizzle-kit's
// migrate command hangs on the current SDK version mismatch.
//
// Usage: npx tsx --env-file=.env scripts/apply-migrations.ts

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}

const sql = neon(url);
const MIGRATIONS_DIR = resolve("drizzle");

async function ensureMigrationsTable() {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS __applied_migrations (
      filename text PRIMARY KEY,
      applied_at timestamp DEFAULT now() NOT NULL
    );
  `);
}

async function alreadyApplied(filename: string): Promise<boolean> {
  const rows = (await sql.query(
    `SELECT filename FROM __applied_migrations WHERE filename = $1 LIMIT 1`,
    [filename],
  )) as Array<{ filename: string }>;
  return rows.length > 0;
}

async function recordApplied(filename: string) {
  await sql.query(
    `INSERT INTO __applied_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
    [filename],
  );
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = (await sql.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName],
  )) as Array<{ "?column?": number }>;
  return rows.length > 0;
}

// Run a SQL file by splitting on the drizzle "--> statement-breakpoint"
// marker (drizzle-kit emits this between every DDL statement). Each part
// goes through sql.query() in sequence so we get clear error messages.
async function applyFile(filename: string) {
  const path = resolve(MIGRATIONS_DIR, filename);
  const raw = readFileSync(path, "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`  ${filename}: ${statements.length} statement(s)`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await sql.query(stmt);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // CREATE TYPE / CREATE TABLE that already exists is fine — older
      // installs may have the schema partially applied.
      if (
        /already exists|duplicate_object/i.test(msg) ||
        /relation .* already exists/i.test(msg)
      ) {
        console.log(`    [${i + 1}] skipped (already exists)`);
        continue;
      }
      console.error(`    [${i + 1}] FAILED:`, msg);
      console.error(`    statement: ${stmt.slice(0, 200)}…`);
      throw e;
    }
  }
}

async function main() {
  console.log("Connecting to database…");
  await ensureMigrationsTable();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  console.log(`Found ${files.length} migration file(s).`);

  let appliedCount = 0;
  for (const f of files) {
    if (await alreadyApplied(f)) {
      console.log(`✓ ${f} (already applied)`);
      continue;
    }
    console.log(`→ applying ${f}…`);
    await applyFile(f);
    await recordApplied(f);
    appliedCount++;
    console.log(`✓ ${f}`);
  }

  // Sanity check: the ideation items table should now exist.
  const ok = await tableExists("competitor_ideation_items");
  console.log(
    `\ncompetitor_ideation_items: ${ok ? "EXISTS ✓" : "MISSING ✗"}`,
  );
  console.log(`\nDone. Applied ${appliedCount} new migration(s).`);
}

main().catch((e) => {
  console.error("\nMigration failed:", e);
  process.exit(1);
});
