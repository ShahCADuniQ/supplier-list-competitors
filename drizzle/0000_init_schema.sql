CREATE TYPE "public"."competitor_tier" AS ENUM('mass', 'mid', 'spec', 'premium');--> statement-breakpoint
CREATE TYPE "public"."project_entry_status" AS ENUM('Quoted', 'PO Issued', 'In Production', 'Shipped', 'Delivered', 'Closed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."supplier_status" AS ENUM('Active', 'Historical');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member', 'pending');--> statement-breakpoint
CREATE TABLE "competitor_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"competitor_id" integer NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"url" text NOT NULL,
	"blob_pathname" text,
	"uploader_clerk_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_clerk_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection_id" integer NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"parent" text,
	"tier_key" "competitor_tier" DEFAULT 'mid' NOT NULL,
	"tier" text,
	"segment" text,
	"country" text,
	"product_lines" text,
	"channel" text,
	"notes" text,
	"capabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"cat_id" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"url" text NOT NULL,
	"blob_pathname" text,
	"uploader" text,
	"uploader_clerk_id" text,
	"date" date DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"text" text NOT NULL,
	"project_num" text,
	"author" text,
	"author_clerk_id" text,
	"date" date DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_project_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"project_num" text NOT NULL,
	"po_number" text,
	"status" "project_entry_status" DEFAULT 'Quoted' NOT NULL,
	"quote_date" date,
	"po_date" date,
	"expected_delivery" date,
	"actual_delivery" date,
	"quoted_lead_time" integer DEFAULT 0 NOT NULL,
	"actual_lead_time" integer DEFAULT 0 NOT NULL,
	"ordered_quantity" integer DEFAULT 0 NOT NULL,
	"delivered_quantity" integer DEFAULT 0 NOT NULL,
	"defective_quantity" integer DEFAULT 0 NOT NULL,
	"returned_quantity" integer DEFAULT 0 NOT NULL,
	"quoted_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"actual_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD',
	"incoterms" text,
	"payment_terms" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"sub_category" text,
	"origin" text,
	"status" "supplier_status" DEFAULT 'Active' NOT NULL,
	"website" text,
	"email" text,
	"phone" text,
	"contact_name" text,
	"products" text,
	"source" text,
	"tested" text,
	"onboarded" date,
	"notes" text,
	"kpis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" "user_role" DEFAULT 'pending' NOT NULL,
	"can_view_suppliers" boolean DEFAULT false NOT NULL,
	"can_view_competitors" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"approved_by" text
);
--> statement-breakpoint
ALTER TABLE "competitor_attachments" ADD CONSTRAINT "competitor_attachments_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_collection_id_competitor_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."competitor_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_attachments" ADD CONSTRAINT "supplier_attachments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_comments" ADD CONSTRAINT "supplier_comments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_project_entries" ADD CONSTRAINT "supplier_project_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_attachments_competitor_idx" ON "competitor_attachments" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "competitor_collections_name_idx" ON "competitor_collections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "competitors_collection_idx" ON "competitors" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "competitors_name_idx" ON "competitors" USING btree ("name");--> statement-breakpoint
CREATE INDEX "competitors_tier_idx" ON "competitors" USING btree ("tier_key");--> statement-breakpoint
CREATE INDEX "supplier_attachments_supplier_idx" ON "supplier_attachments" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_attachments_cat_idx" ON "supplier_attachments" USING btree ("cat_id");--> statement-breakpoint
CREATE INDEX "supplier_comments_supplier_idx" ON "supplier_comments" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "project_entries_supplier_idx" ON "supplier_project_entries" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "project_entries_status_idx" ON "supplier_project_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "suppliers_name_idx" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "suppliers_category_idx" ON "suppliers" USING btree ("category");--> statement-breakpoint
CREATE INDEX "suppliers_origin_idx" ON "suppliers" USING btree ("origin");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_email_idx" ON "user_profiles" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_profiles_role_idx" ON "user_profiles" USING btree ("role");