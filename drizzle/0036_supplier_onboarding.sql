-- Supplier onboarding gate — new vendors must complete a checklist + company
-- info form before they can access the catalog / orders / chat. Lightbase
-- admins review the submission and approve or reject.

DO $$ BEGIN
  CREATE TYPE "supplier_onboarding_status" AS ENUM (
    'pending',
    'submitted',
    'approved',
    'rejected'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- Existing suppliers default to 'approved' so they don't get locked out
-- of their dashboards while the new gate rolls out. New portal sign-ups
-- (via createOrFindSupplierForUser or similar) explicitly set 'pending'.
ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "onboarding_status" "supplier_onboarding_status" NOT NULL DEFAULT 'approved';
--> statement-breakpoint
ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "onboarding_submitted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "onboarding_reviewed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "onboarding_reviewed_by_clerk_id" text;
--> statement-breakpoint
ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "onboarding_reviewer_notes" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_onboarding_submissions" (
  "id"                       serial PRIMARY KEY,
  "supplier_id"              integer NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "form_data"                jsonb NOT NULL DEFAULT '{}'::jsonb,
  "score"                    integer,
  "score_max"                integer,
  "verdict"                  text,
  "submitted_at"             timestamp NOT NULL DEFAULT now(),
  "submitted_by_clerk_id"    text,
  "reviewed_at"              timestamp,
  "reviewed_by_clerk_id"     text,
  "reviewer_notes"           text,
  "created_at"               timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_onboarding_submissions_supplier_idx" ON "supplier_onboarding_submissions" ("supplier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_onboarding_submissions_submitted_idx" ON "supplier_onboarding_submissions" ("submitted_at");
