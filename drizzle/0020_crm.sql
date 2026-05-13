-- Stage 4 CRM tables: accounts, contacts, opportunities, activities,
-- tickets. See src/db/schema.ts for the camelCased Drizzle model and
-- src/app/crm/actions.ts for the server actions that touch these tables.

DO $$ BEGIN
  CREATE TYPE "crm_account_tier" AS ENUM ('lead', 'prospect', 'customer', 'partner', 'churned');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "crm_opportunity_stage" AS ENUM ('lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won', 'lost', 'on-hold');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "crm_activity_type" AS ENUM ('call', 'email', 'meeting', 'note', 'task');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "crm_ticket_status" AS ENUM ('open', 'in-progress', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "crm_ticket_priority" AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "crm_accounts" (
  "id" serial PRIMARY KEY,
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "website" text,
  "industry" text,
  "tier" "crm_account_tier" NOT NULL DEFAULT 'lead',
  "country" text,
  "employee_count" integer,
  "annual_revenue_usd" numeric(14,2),
  "notes" text,
  "health_score" integer NOT NULL DEFAULT 50,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "crm_accounts_owner_idx" ON "crm_accounts" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "crm_accounts_tier_idx" ON "crm_accounts" ("tier");
CREATE INDEX IF NOT EXISTS "crm_accounts_name_idx" ON "crm_accounts" ("name");

CREATE TABLE IF NOT EXISTS "crm_contacts" (
  "id" serial PRIMARY KEY,
  "account_id" integer NOT NULL REFERENCES "crm_accounts"("id") ON DELETE CASCADE,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL DEFAULT '',
  "email" text,
  "phone" text,
  "role" text,
  "is_primary" boolean NOT NULL DEFAULT false,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "crm_contacts_account_idx" ON "crm_contacts" ("account_id");
CREATE INDEX IF NOT EXISTS "crm_contacts_email_idx" ON "crm_contacts" ("email");

CREATE TABLE IF NOT EXISTS "crm_opportunities" (
  "id" serial PRIMARY KEY,
  "account_id" integer NOT NULL REFERENCES "crm_accounts"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "stage" "crm_opportunity_stage" NOT NULL DEFAULT 'lead',
  "amount_usd" numeric(14,2) NOT NULL DEFAULT 0,
  "probability" integer NOT NULL DEFAULT 20,
  "expected_close_date" date,
  "closed_at" timestamp,
  "closed_reason" text,
  "next_step" text,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "crm_opportunities_account_idx" ON "crm_opportunities" ("account_id");
CREATE INDEX IF NOT EXISTS "crm_opportunities_stage_idx" ON "crm_opportunities" ("stage");

CREATE TABLE IF NOT EXISTS "crm_activities" (
  "id" serial PRIMARY KEY,
  "account_id" integer NOT NULL REFERENCES "crm_accounts"("id") ON DELETE CASCADE,
  "contact_id" integer REFERENCES "crm_contacts"("id") ON DELETE SET NULL,
  "opportunity_id" integer REFERENCES "crm_opportunities"("id") ON DELETE SET NULL,
  "type" "crm_activity_type" NOT NULL DEFAULT 'note',
  "subject" text NOT NULL,
  "body" text,
  "occurred_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "crm_activities_account_idx" ON "crm_activities" ("account_id");
CREATE INDEX IF NOT EXISTS "crm_activities_occurred_idx" ON "crm_activities" ("occurred_at");

CREATE TABLE IF NOT EXISTS "crm_tickets" (
  "id" serial PRIMARY KEY,
  "account_id" integer NOT NULL REFERENCES "crm_accounts"("id") ON DELETE CASCADE,
  "contact_id" integer REFERENCES "crm_contacts"("id") ON DELETE SET NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "status" "crm_ticket_status" NOT NULL DEFAULT 'open',
  "priority" "crm_ticket_priority" NOT NULL DEFAULT 'medium',
  "resolved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "crm_tickets_account_idx" ON "crm_tickets" ("account_id");
CREATE INDEX IF NOT EXISTS "crm_tickets_status_idx" ON "crm_tickets" ("status");
