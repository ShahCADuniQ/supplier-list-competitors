// Self-healing schema helper for the suppliers module. Same pattern as
// ensureUserProfileColumns in src/lib/permissions.ts — every entry point
// that reads/writes the new columns calls this first so a fresh deploy
// without `npm run db:apply` keeps working.
//
// Currently covers migration 0023 (suppliers.is_starred). Add new ALTERs
// here as the schema grows.
//
// NOT a "use server" file — exposes a plain async function callable from
// both server components (page.tsx) and server actions (actions.ts) without
// the RPC indirection that "use server" exports get.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureSupplierColumns(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      await db.execute(
        sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "is_starred" boolean NOT NULL DEFAULT false`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "suppliers_starred_idx" ON "suppliers" ("is_starred")`,
      );
    } catch (e) {
      console.warn(
        "[suppliers] ensureSupplierColumns failed — run `npm run db:apply` to apply migration 0023.",
        e,
      );
    }
  })();
  return _ensured;
}
