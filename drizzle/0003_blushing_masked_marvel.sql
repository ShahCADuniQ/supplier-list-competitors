CREATE TYPE "public"."handbook_revision_status" AS ENUM('draft', 'final');--> statement-breakpoint
CREATE TABLE "handbook_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_clerk_id" text NOT NULL,
	"name" text DEFAULT 'Untitled' NOT NULL,
	"content" jsonb NOT NULL,
	"status" "handbook_revision_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "handbook_revisions_owner_idx" ON "handbook_revisions" USING btree ("owner_clerk_id");--> statement-breakpoint
CREATE INDEX "handbook_revisions_status_idx" ON "handbook_revisions" USING btree ("status");