-- Stage 6 · OEE & Floor Ops
--
-- Real-time OEE tables + downtime / quality / alert ledgers. See
-- src/db/schema.ts for column comments and the OEE-calculation strategy.

DO $$ BEGIN
  CREATE TYPE "oee_machine_status" AS ENUM ('running','idle','down','maintenance','offline');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "oee_downtime_reason" AS ENUM ('breakdown','setup','material','changeover','maintenance','no-operator','quality-hold','other');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "oee_downtime_category" AS ENUM ('planned','unplanned');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "oee_quality_type" AS ENUM ('scrap','rework','defect');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "oee_alert_severity" AS ENUM ('info','warning','critical');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "oee_alert_status" AS ENUM ('open','acknowledged','resolved','escalated');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "oee_machines" (
  "id" serial PRIMARY KEY,
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "code" text,
  "line" text,
  "location" text,
  "ideal_cycle_seconds" numeric(8,3) NOT NULL DEFAULT 60,
  "status" "oee_machine_status" NOT NULL DEFAULT 'idle',
  "status_since" timestamp NOT NULL DEFAULT now(),
  "notes" text,
  "crm_account_id" integer REFERENCES "crm_accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oee_machines_owner_idx" ON "oee_machines" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "oee_machines_status_idx" ON "oee_machines" ("status");
CREATE INDEX IF NOT EXISTS "oee_machines_line_idx" ON "oee_machines" ("line");

CREATE TABLE IF NOT EXISTS "oee_runs" (
  "id" serial PRIMARY KEY,
  "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
  "part_number" text NOT NULL,
  "part_name" text,
  "planned_start" timestamp NOT NULL,
  "planned_end" timestamp NOT NULL,
  "actual_start" timestamp,
  "actual_end" timestamp,
  "target_count" integer NOT NULL DEFAULT 0,
  "good_count" integer NOT NULL DEFAULT 0,
  "scrap_count" integer NOT NULL DEFAULT 0,
  "rework_count" integer NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oee_runs_machine_idx" ON "oee_runs" ("machine_id");
CREATE INDEX IF NOT EXISTS "oee_runs_planned_start_idx" ON "oee_runs" ("planned_start");

CREATE TABLE IF NOT EXISTS "oee_downtime_events" (
  "id" serial PRIMARY KEY,
  "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
  "run_id" integer REFERENCES "oee_runs"("id") ON DELETE SET NULL,
  "reason" "oee_downtime_reason" NOT NULL,
  "category" "oee_downtime_category" NOT NULL,
  "start_at" timestamp NOT NULL,
  "end_at" timestamp,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oee_downtime_machine_idx" ON "oee_downtime_events" ("machine_id");
CREATE INDEX IF NOT EXISTS "oee_downtime_start_idx" ON "oee_downtime_events" ("start_at");
CREATE INDEX IF NOT EXISTS "oee_downtime_reason_idx" ON "oee_downtime_events" ("reason");

CREATE TABLE IF NOT EXISTS "oee_quality_events" (
  "id" serial PRIMARY KEY,
  "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
  "run_id" integer REFERENCES "oee_runs"("id") ON DELETE SET NULL,
  "type" "oee_quality_type" NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "defect_code" text,
  "notes" text,
  "occurred_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oee_quality_machine_idx" ON "oee_quality_events" ("machine_id");
CREATE INDEX IF NOT EXISTS "oee_quality_occurred_idx" ON "oee_quality_events" ("occurred_at");

CREATE TABLE IF NOT EXISTS "oee_alerts" (
  "id" serial PRIMARY KEY,
  "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
  "severity" "oee_alert_severity" NOT NULL DEFAULT 'warning',
  "status" "oee_alert_status" NOT NULL DEFAULT 'open',
  "code" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "crm_ticket_id" integer REFERENCES "crm_tickets"("id") ON DELETE SET NULL,
  "raised_at" timestamp NOT NULL DEFAULT now(),
  "acknowledged_at" timestamp,
  "resolved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oee_alerts_machine_idx" ON "oee_alerts" ("machine_id");
CREATE INDEX IF NOT EXISTS "oee_alerts_status_idx" ON "oee_alerts" ("status");
CREATE INDEX IF NOT EXISTS "oee_alerts_raised_idx" ON "oee_alerts" ("raised_at");
