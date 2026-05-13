-- Stage 1 design-engineering workflow projects. One row per "project" the
-- engineer starts; holds the CAD file refs, BOM, drawing settings, and
-- approval audit trail. See src/db/schema.ts for the camelCased Drizzle
-- model and src/app/design-engineering/actions.ts for the server actions
-- that read/write this table.
DO $$ BEGIN
  CREATE TYPE "design_project_status" AS ENUM ('draft', 'in-review', 'approved');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "design_projects" (
  "id" serial PRIMARY KEY,
  "clerk_user_id" text NOT NULL,
  "name" text NOT NULL,
  "niche" text,
  "description" text,
  "status" "design_project_status" NOT NULL DEFAULT 'draft',
  "cad_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "drawing_settings" jsonb NOT NULL DEFAULT '{"standard":"ANSI Y14.5","units":"mm","sheetSize":"A3","scale":"1:1"}'::jsonb,
  "bom_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fea_notes" text NOT NULL DEFAULT '',
  "manual_notes" text NOT NULL DEFAULT '',
  "approval_notes" text NOT NULL DEFAULT '',
  "approved_at" timestamp,
  "approved_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "design_projects_user_idx" ON "design_projects" ("clerk_user_id");
CREATE INDEX IF NOT EXISTS "design_projects_status_idx" ON "design_projects" ("status");
