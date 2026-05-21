// Self-healing schema helper for the supplier onboarding gate (migration
// 0036). Same pattern as the other ensure-schema modules: every server
// action calls this first so a fresh deploy without `npm run db:apply`
// keeps working. Memoised per Node process.

import { sql } from "drizzle-orm";
import { db } from "@/db";

let _ensured: Promise<void> | null = null;

export function ensureOnboardingSchema(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "supplier_onboarding_status" AS ENUM (
          'pending', 'submitted', 'approved', 'rejected'
        );
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_status" "supplier_onboarding_status" NOT NULL DEFAULT 'approved'`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_submitted_at" timestamp`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_reviewed_at" timestamp`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_reviewed_by_clerk_id" text`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_reviewer_notes" text`);
      // Auto-saved step-2 form state. Written every few seconds while the
      // supplier is filling in the compliance checklist so they don't lose
      // work if they sign out mid-flow. Cleared on a successful submit
      // (the submission row in supplier_onboarding_submissions becomes
      // authoritative at that point).
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_draft" jsonb`);
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "onboarding_draft_updated_at" timestamp`);
      // Buy & sell supplier flag — set when the onboarding wizard's
      // "I'm a distributor" checkbox is ticked. The manufacturing and
      // materials arrays stay empty in that case.
      await db.execute(sql`ALTER TABLE "suppliers"
        ADD COLUMN IF NOT EXISTS "is_distributor" boolean NOT NULL DEFAULT false`);
      // Shared taxonomy of custom manufacturing capabilities + materials
      // added by suppliers. UNIONed with the curated constants whenever
      // the onboarding form's MultiSelect renders. See
      // addSupplierTaxonomyTerm / listSupplierTaxonomyTerms.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS "supplier_taxonomy_terms" (
        "id" serial PRIMARY KEY,
        "kind" text NOT NULL,
        "value" text NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "supplier_taxonomy_terms_kind_idx" ON "supplier_taxonomy_terms" ("kind")`,
      );
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "supplier_taxonomy_terms_kind_value_idx" ON "supplier_taxonomy_terms" ("kind", "value")`,
      );
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "supplier_onboarding_submissions" (
          "id" serial PRIMARY KEY,
          "supplier_id" integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
          "form_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "score" integer,
          "score_max" integer,
          "verdict" text,
          "submitted_at" timestamp NOT NULL DEFAULT now(),
          "submitted_by_clerk_id" text,
          "reviewed_at" timestamp,
          "reviewed_by_clerk_id" text,
          "reviewer_notes" text,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_onboarding_submissions_supplier_idx" ON "supplier_onboarding_submissions" ("supplier_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "supplier_onboarding_submissions_submitted_idx" ON "supplier_onboarding_submissions" ("submitted_at")`);
    } catch (e) {
      _ensured = null;
      throw e;
    }
  })();
  return _ensured;
}
