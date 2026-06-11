import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigint,
  index,
  uniqueIndex,
  pgEnum,
  primaryKey,
  date,
  numeric,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// USER PROFILES & ACCESS CONTROL
// ─────────────────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", ["admin", "member", "pending"]);

// Per-user email connections. One row per user per provider — the user
// can connect Outlook AND Gmail if they want, with the most-recently-
// updated row winning when the platform needs to pick a sender.
// access_token + refresh_token are AES-256-GCM encrypted at rest (see
// src/lib/email/crypto.ts). expires_at is the absolute UTC moment the
// access token stops working; the transport refreshes on demand.
export const emailProvider = pgEnum("email_provider", [
  "microsoft", // Outlook + Microsoft 365 via Microsoft Graph
  "google",    // Gmail via Gmail API
]);

export const userEmailConnections = pgTable(
  "user_email_connections",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    provider: emailProvider("provider").notNull(),
    // The actual address the OAuth flow returned. Stored separately
    // from the user_profiles email so a personal Gmail connection
    // doesn't override a tenant user_profile.
    emailAddress: text("email_address").notNull(),
    // Encrypted blobs — never log these. The encryption helper handles
    // base64 framing of the IV + ciphertext + auth tag.
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    expiresAt: timestamp("expires_at").notNull(),
    scope: text("scope"),
    // Audit. lastSyncAt is bumped each time we fetch inbox messages so
    // the user can see when the last refresh happened.
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Only one row per (user, provider) pair — reconnecting overwrites.
    userProviderIdx: uniqueIndex("user_email_connections_user_provider_idx").on(
      t.clerkUserId,
      t.provider,
    ),
    clerkUserIdx: index("user_email_connections_clerk_user_idx").on(t.clerkUserId),
  }),
);
export type UserEmailConnection = typeof userEmailConnections.$inferSelect;

export const userProfiles = pgTable(
  "user_profiles",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("pending"),
    // Set on first sign-in when the email matches a `suppliers.email` row.
    // Supplier users get the simplified vendor portal and are blocked from
    // every internal section (ERP / CRM / OEE / Tools / Admin). Migration
    // 0026; self-healed in src/lib/permissions.ts.
    isSupplier: boolean("is_supplier").notNull().default(false),
    // Retailer / buyer users — companies that BUY finished goods from a
    // CADuniQ engineering company (the third public sign-up role on
    // /get-started). They see a curated buyer portal at /retailer and
    // are blocked from every internal section. Self-healed by
    // ensureUserProfileColumns().
    isRetailer: boolean("is_retailer").notNull().default(false),
    // Job role within their company (CEO, COO, Operations, Procurement, …).
    // See JOB_ROLES in src/lib/job-roles.ts. Migration 0027.
    jobRole: text("job_role"),
    // Tenant scope — which client this user works for. NULL means CADuniQ
    // staff (cross-client). Defaults to the deployment's default client on
    // first run via the backfill in ensure-orders-schema's sibling helper.
    // Migration 0027.
    clientId: integer("client_id"),
    // Tracks the role the user picked on /get-started but hasn't yet
    // completed onboarding for ("engineering" | "supplier" | "retailer").
    // Set when they first land on /onboarding?role=X, used by the home page
    // to resume them on the correct wizard if they sign out mid-flow.
    // Stays set after onboarding completes (claim flags + clientId are the
    // authoritative routing inputs once any of them flip on).
    pendingSignupRole: text("pending_signup_role"),
    canViewSuppliers: boolean("can_view_suppliers").notNull().default(false),
    canViewCompetitors: boolean("can_view_competitors").notNull().default(false),
    canViewHandbook: boolean("can_view_handbook").notNull().default(false),
    canViewEngineering: boolean("can_view_engineering").notNull().default(false),
    // Per-module gates added in 0022 to back the expanded Admin matrix.
    // Each one maps 1:1 to a sidebar surface. Defaults to false so new
    // sign-ups stay locked out until an admin opts them in.
    canViewDesignEngineering: boolean("can_view_design_engineering")
      .notNull()
      .default(false),
    canViewCrm: boolean("can_view_crm").notNull().default(false),
    canViewOee: boolean("can_view_oee").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    approvedAt: timestamp("approved_at"),
    approvedBy: text("approved_by"),
  },
  (t) => ({
    emailIdx: uniqueIndex("user_profiles_email_idx").on(t.email),
    roleIdx: index("user_profiles_role_idx").on(t.role),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIERS
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS — multi-tenant scope. Each row represents one of CADuniQ's
// client companies (Lightbase, Acme, …). user_profiles.client_id and
// suppliers.client_id reference this; null means cross-tenant (CADuniQ
// staff or shared supplier). Migration 0027.
//
// A bootstrap row matching CLIENT_CONFIG.name is auto-created in the
// self-heal helper so existing single-tenant deployments keep working.
// ─────────────────────────────────────────────────────────────────────────────

export const clients = pgTable(
  "clients",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    industry: text("industry"), // "manufacturing" / "construction"
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    // Brand mark used as letterhead on every generated RFQ / Quote / PO PDF.
    // Uploaded by an admin from the client config screen. Migration 0030.
    logoUrl: text("logo_url"),
    logoName: text("logo_name"),
    logoPathname: text("logo_pathname"),
    // Per-client module gates. Set by CADuniQ admins from the CADuniQ HQ
    // dashboard. Effective module access for a user is the AND of these
    // tenant-level gates with the per-user gates on user_profiles, so a
    // CADuniQ admin can shut off entire modules for a whole client even
    // if individual users on that client have can_view_* enabled.
    // Default true so existing tenants (Lightbase) keep working; new
    // tenants created via claimEngineeringCompany also default to all
    // modules enabled — the CADuniQ admin opts down per client as needed.
    canUseSuppliers: boolean("can_use_suppliers").notNull().default(true),
    canUseCompetitors: boolean("can_use_competitors").notNull().default(true),
    canUseHandbook: boolean("can_use_handbook").notNull().default(true),
    canUseEngineering: boolean("can_use_engineering").notNull().default(true),
    canUseDesignEngineering: boolean("can_use_design_engineering").notNull().default(true),
    canUseCrm: boolean("can_use_crm").notNull().default(true),
    canUseOee: boolean("can_use_oee").notNull().default(true),
    // Email integration is opt-in per tenant and gated by CADuniQ HQ.
    // Lifecycle: none (default) → requested (tenant admin clicked the
    // home-page "Connect work email" card) → approved | rejected
    // (CADuniQ HQ decision). Only `approved` tenants can actually run
    // the Nylas OAuth flow; the request columns capture audit info so
    // the HQ queue shows who asked when.
    emailIntegrationStatus: text("email_integration_status")
      .notNull()
      .default("none"),
    emailIntegrationRequestedBy: text("email_integration_requested_by"),
    emailIntegrationRequestedAt: timestamp("email_integration_requested_at"),
    emailIntegrationDecidedBy: text("email_integration_decided_by"),
    emailIntegrationDecidedAt: timestamp("email_integration_decided_at"),
    emailIntegrationNotes: text("email_integration_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("clients_name_idx").on(t.name),
  }),
);

export type Client = typeof clients.$inferSelect;

export const supplierStatus = pgEnum("supplier_status", ["Active", "Historical"]);

// Onboarding gate — new suppliers signing in via the portal land in
// `pending`, fill out the checklist + company info, submit it (→ `submitted`),
// then Lightbase admins approve (`approved`) or reject (`rejected`). Until
// the row is `approved`, the supplier portal shows ONLY the onboarding
// form — no catalogue, no orders, no chat. Existing suppliers are
// back-filled to `approved` by the migration so they don't get locked out.
export const supplierOnboardingStatus = pgEnum("supplier_onboarding_status", [
  "pending",
  "submitted",
  "approved",
  "rejected",
]);

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category"),
    subCategory: text("sub_category"),
    origin: text("origin"),
    status: supplierStatus("status").notNull().default("Active"),
    website: text("website"),
    email: text("email"),
    phone: text("phone"),
    contactName: text("contact_name"),
    products: text("products"),
    source: text("source"),
    tested: text("tested"),
    onboarded: date("onboarded"),
    notes: text("notes"),
    // KPIs / commercial terms / compliance — stored as JSON for flexibility.
    // Shape: { leadTime, moq, capacity, paymentTerms, currency, incoterms, risk,
    //          backup, insurance, iso, ul, ce, rohs, nda, msa }
    kpis: jsonb("kpis").$type<Record<string, string>>().notNull().default({}),
    // Manufacturing-specific tags. Empty for non-Manufacturing suppliers; an
    // AI web-search action populates these on demand when the user clicks
    // "Auto-fill from web" inside the supplier panel.
    manufacturingTypes: text("manufacturing_types")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    materials: text("materials")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    // When set, this row is the supplier mirror of a competitor brand.
    // The category column is automatically "Competitor" for these rows.
    // ON DELETE CASCADE so removing the competitor also removes its
    // mirror; user can re-add it as a regular supplier afterwards if
    // they still want to keep the contact.
    competitorId: integer("competitor_id"),
    // Starred suppliers surface in the "Current suppliers" panel at the top
    // of /suppliers — a curated short-list of who the company actively buys
    // from right now (vs the long tail of historical / one-off / vetted-but-
    // unused suppliers). Toggle per row from the star button on the table or
    // the supplier detail header. Migration 0023; self-healed in actions.ts.
    isStarred: boolean("is_starred").notNull().default(false),
    // Long-lived magic-link token that grants the supplier access to their
    // stable home portal at /vendor/home/[token]. The home portal lists
    // every RFQ they've been invited to + lets them see status updates
    // across the board. Separate from per-RFQ tokens (rfq_recipients.access_token)
    // so the admin can revoke the supplier's entire portal access in one
    // shot without invalidating in-flight RFQs. Migration 0025.
    portalToken: text("portal_token"),
    // Tenant scope. NULL means cross-client (shared supplier). Suppliers
    // owned by a single client (the common case) get assigned to that
    // client. Migration 0027.
    clientId: integer("client_id"),
    // Supplier's own brand mark. Used as the letterhead on the supplier's
    // generated quotation PDF so when they print it for the buyer, it
    // carries their identity instead of a generic Lightbase mark. Migration 0030.
    logoUrl: text("logo_url"),
    logoName: text("logo_name"),
    logoPathname: text("logo_pathname"),
    // Onboarding gate. Migration 0036 — default 'approved' for back-fill
    // so existing rows aren't locked out; new portal sign-ups default to
    // 'pending' via the createOrFindSupplierForUser flow.
    onboardingStatus: supplierOnboardingStatus("onboarding_status")
      .notNull()
      .default("approved"),
    onboardingSubmittedAt: timestamp("onboarding_submitted_at"),
    onboardingReviewedAt: timestamp("onboarding_reviewed_at"),
    onboardingReviewedByClerkId: text("onboarding_reviewed_by_clerk_id"),
    onboardingReviewerNotes: text("onboarding_reviewer_notes"),
    // Buy-and-sell flag. Set when a supplier identifies as a pure
    // distributor / reseller — they don't manufacture in-house and
    // don't work directly with raw materials. When true the onboarding
    // wizard hides the manufacturing-capabilities and materials
    // questions entirely; both arrays stay empty. The admin sees this
    // explicit signal instead of having to infer from empty arrays.
    isDistributor: boolean("is_distributor").notNull().default(false),
    // Auto-saved step-2 form state. Whenever the supplier edits a field
    // in the compliance checklist we debounce-write the whole form blob
    // here so a sign-out / sign back in restores their progress. Wiped
    // after a successful submit (the submission row in
    // supplier_onboarding_submissions becomes the authoritative copy).
    onboardingDraft: jsonb("onboarding_draft").$type<Record<string, unknown>>(),
    onboardingDraftUpdatedAt: timestamp("onboarding_draft_updated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: index("suppliers_name_idx").on(t.name),
    categoryIdx: index("suppliers_category_idx").on(t.category),
    originIdx: index("suppliers_origin_idx").on(t.origin),
    competitorIdx: uniqueIndex("suppliers_competitor_idx").on(t.competitorId),
    starredIdx: index("suppliers_starred_idx").on(t.isStarred),
    portalTokenIdx: uniqueIndex("suppliers_portal_token_idx").on(t.portalToken),
  }),
);

export const projectEntryStatus = pgEnum("project_entry_status", [
  "Quoted",
  "PO Issued",
  "In Production",
  "Shipped",
  "Delivered",
  "Closed",
  "Cancelled",
]);

export const supplierProjectEntries = pgTable(
  "supplier_project_entries",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    projectNum: text("project_num").notNull(),
    poNumber: text("po_number"),
    status: projectEntryStatus("status").notNull().default("Quoted"),
    quoteDate: date("quote_date"),
    poDate: date("po_date"),
    expectedDelivery: date("expected_delivery"),
    actualDelivery: date("actual_delivery"),
    quotedLeadTime: integer("quoted_lead_time").notNull().default(0),
    actualLeadTime: integer("actual_lead_time").notNull().default(0),
    orderedQuantity: integer("ordered_quantity").notNull().default(0),
    deliveredQuantity: integer("delivered_quantity").notNull().default(0),
    defectiveQuantity: integer("defective_quantity").notNull().default(0),
    returnedQuantity: integer("returned_quantity").notNull().default(0),
    quotedAmount: numeric("quoted_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    actualAmount: numeric("actual_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    currency: text("currency").default("USD"),
    incoterms: text("incoterms"),
    paymentTerms: text("payment_terms"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("project_entries_supplier_idx").on(t.supplierId),
    statusIdx: index("project_entries_status_idx").on(t.status),
  }),
);

export const supplierComments = pgTable(
  "supplier_comments",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    projectNum: text("project_num"),
    author: text("author"),
    authorClerkId: text("author_clerk_id"),
    date: date("date").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("supplier_comments_supplier_idx").on(t.supplierId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER CONTACTS — multiple points of contact per supplier. The
// suppliers.email column stays as the "primary" denormalised contact
// (so legacy queries keep working) but additional contacts (sales,
// engineering, accounts payable, etc.) live in this table. Migration 0028.
// ─────────────────────────────────────────────────────────────────────────────

export const supplierContacts = pgTable(
  "supplier_contacts",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    name: text("name"),
    email: text("email").notNull(),
    phone: text("phone"),
    role: text("role"),               // e.g. "Sales", "Engineering", "AP"
    isPrimary: boolean("is_primary").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("supplier_contacts_supplier_idx").on(t.supplierId),
    emailIdx: index("supplier_contacts_email_idx").on(t.email),
  }),
);

export type SupplierContact = typeof supplierContacts.$inferSelect;

export const supplierAttachments = pgTable(
  "supplier_attachments",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    catId: text("cat_id").notNull(),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    // Public Blob URL (served via Vercel's CDN). `blobPathname` is what we pass
    // to `del()` when the row is removed so storage doesn't leak.
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    uploader: text("uploader"),
    uploaderClerkId: text("uploader_clerk_id"),
    date: date("date").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("supplier_attachments_supplier_idx").on(t.supplierId),
    catIdx: index("supplier_attachments_cat_idx").on(t.catId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER ONBOARDING SUBMISSIONS (Migration 0036)
//
// Captures the full checklist + company-info payload the supplier fills
// out before getting access to the rest of the portal. The form data is
// stored as JSON to stay flexible — the question schema evolves
// (regulations change, new product categories get added) and we don't
// want to migrate the table every time. Critical structured fields
// (status, timestamps, reviewer) stay as columns for indexability.
// ─────────────────────────────────────────────────────────────────────────────

export const supplierOnboardingSubmissions = pgTable(
  "supplier_onboarding_submissions",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    // Full form payload: company info, country, category, every Yes/No
    // answer, score, comments. The shape is owned by SupplierOnboardingForm.
    formData: jsonb("form_data").$type<Record<string, unknown>>().notNull().default({}),
    // Computed at submission time so the admin list can show "Pre-qualified
    // 18/20" without re-running the score logic.
    score: integer("score"),
    scoreMax: integer("score_max"),
    verdict: text("verdict"), // 'pre-qualified' | 'conditional' | 'not-qualified'
    // Submission lifecycle.
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    submittedByClerkId: text("submitted_by_clerk_id"),
    reviewedAt: timestamp("reviewed_at"),
    reviewedByClerkId: text("reviewed_by_clerk_id"),
    reviewerNotes: text("reviewer_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("supplier_onboarding_submissions_supplier_idx").on(t.supplierId),
    submittedIdx: index("supplier_onboarding_submissions_submitted_idx").on(t.submittedAt),
  }),
);
export type SupplierOnboardingSubmission = typeof supplierOnboardingSubmissions.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER TAXONOMY TERMS — shared, append-only catalog of custom
// manufacturing capabilities + materials added by suppliers during
// onboarding. The MultiSelect for both fields shows the curated
// constants (MANUFACTURING_TYPES, SUPPLIER_MATERIALS) UNIONed with
// every row in this table for the corresponding `kind`. When a new
// supplier types a custom entry the addSupplierTaxonomyTerm action
// upserts it here so the next supplier sees it as a normal option.
//
// kind: 'manufacturing' | 'material'
// value: the user-facing text. Unique per kind (case-insensitive).
// ─────────────────────────────────────────────────────────────────────────────

export const supplierTaxonomyTerms = pgTable(
  "supplier_taxonomy_terms",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    kindIdx: index("supplier_taxonomy_terms_kind_idx").on(t.kind),
    // Postgres unique on (kind, lower(value)) — declared as a regular
    // unique index on (kind, value) here; the case-insensitive guard
    // lives in the upsert action which lowercases before comparing.
    uniqIdx: uniqueIndex("supplier_taxonomy_terms_kind_value_idx").on(
      t.kind,
      t.value,
    ),
  }),
);
export type SupplierTaxonomyTerm = typeof supplierTaxonomyTerms.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER PRODUCT CATALOG (Migration 0034)
//
// Each supplier maintains their own catalog of products they offer.
// Conceptually distinct from `inventory_items` (Lightbase's own parts &
// assemblies):
//   • inventory_items   = parts WE order / hold in inventory.
//   • supplier_products = parts the VENDOR sells. A vendor may list
//     thousands; we only ever order a subset.
//
// Both Lightbase admins (via the Supplier Inventory tab) AND the supplier
// themselves (via their portal) can create + edit rows here. The
// `created_by_role` column is audit-only — it does NOT restrict edits.
// ─────────────────────────────────────────────────────────────────────────────

export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    // Optional parent product. When NULL the row is a top-level "part"
    // (the thing the supplier actually sells); when set, the row is a
    // model / configuration / variant nested under its parent part. The
    // attachments table (supplier_product_attachments) is shared across
    // both levels — a part's attachments hang off the part row, and
    // each model's attachments hang off its own row. Self-reference
    // with ON DELETE CASCADE so deleting a part wipes its models too.
    parentProductId: integer("parent_product_id"),
    // Cross-supplier product identity. Two supplier_products rows
    // representing the SAME (or near-equivalent) part on different
    // suppliers share the same globalProductId. Lets the catalogue
    // show "primary + alternatives" for backup-supplier planning.
    // Auto-populated on create (a fresh UUID when the row starts a
    // new family, or inherited from the existing family when the row
    // is added as an alternative).
    globalProductId: text("global_product_id"),
    // Within a globalProductId group, exactly one row is the primary
    // supplier; the rest are alternatives/backups. New top-level
    // parts default to true; alternatives added via the "+ Add
    // alternative supplier" picker default to false.
    isPrimarySupplier: boolean("is_primary_supplier").notNull().default(true),
    name: text("name").notNull(),
    productCode: text("product_code"),
    description: text("description"),
    category: text("category"),
    notes: text("notes"),
    // Source / reference URL — the brand/storefront product page (e.g. the
    // Shopify variant URL) so the team can jump straight to the original
    // listing for spec / pricing / availability checks. Auto-filled by the
    // Add Product URL flow; editable in the drawer. Optional.
    productUrl: text("product_url"),
    // Additional places-to-buy this exact product (Amazon, AliExpress,
    // DigiKey, etc.). Stored as a flat JSON list ON the product row itself
    // — adding a source does NOT create a new catalogue card; it just
    // appends here. Each entry: { id, name, url, website?, notes?, addedAt,
    // addedByClerkId? }. id is a uuid so individual entries can be
    // removed/edited without depending on array index.
    purchaseSources: jsonb("purchase_sources")
      .$type<Array<{
        id: string;
        name: string;
        url: string;
        website?: string | null;
        notes?: string | null;
        addedAt: string;
        addedByClerkId?: string | null;
      }>>()
      .notNull()
      .default([]),
    thumbnailUrl: text("thumbnail_url"),
    thumbnailPathname: text("thumbnail_pathname"),
    archived: boolean("archived").notNull().default(false),
    // 'lightbase' (a team member added it on behalf of the supplier) or
    // 'supplier' (the vendor added it via their portal). Audit-only.
    createdByRole: text("created_by_role").notNull().default("lightbase"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("supplier_products_supplier_idx").on(t.supplierId),
    archivedIdx: index("supplier_products_archived_idx").on(t.archived),
    nameIdx: index("supplier_products_name_idx").on(t.name),
    parentIdx: index("supplier_products_parent_idx").on(t.parentProductId),
    globalIdx: index("supplier_products_global_idx").on(t.globalProductId),
  }),
);
export type SupplierProduct = typeof supplierProducts.$inferSelect;

// Six fixed attachment categories — locked to an enum so the UI always
// has predictable tab labels and we can index by category cheaply.
export const supplierProductAttachmentCategory = pgEnum(
  "supplier_product_attachment_category",
  [
    "spec_datasheet",            // Specifications & Datasheet
    "ies_file",                  // IES Photometric Files
    "drawing",                   // Drawings (CAD / PDF)
    "quote_pricing",             // (LEGACY — migrated to project_doc + quote)
    "contract_nda",              // Contracts & NDAs
    "certification_compliance",  // Certifications & Compliance
    "test_report_qc",            // Test Reports & QC
    "photo_media",               // Photos & Media
    "other_file",                // Other Files (with comment)
    "project_doc",               // Projects bucket — file lives under a project_num + project_doc_type
  ],
);

// Per-project document type for attachments stored under the new
// "Projects" sidebar bucket. Replaces the old single "quote_pricing"
// category — every uploaded doc now sits inside a project and is
// tagged with one of these five canonical types.
export const supplierProductProjectDocType = pgEnum(
  "supplier_product_project_doc_type",
  ["rfq", "quote", "po", "pi", "invoice"],
);

export const supplierProductAttachments = pgTable(
  "supplier_product_attachments",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => supplierProducts.id, { onDelete: "cascade" }),
    category: supplierProductAttachmentCategory("category").notNull(),
    // When the supplier creates a free-text section, the row is stored
    // with category='other_file' (the catch-all enum value) and the
    // user-defined section name is preserved here. NULL → not part of a
    // custom section. The UI groups custom-labeled rows by this column.
    customCategoryLabel: text("custom_category_label"),
    // Project routing — set when category='project_doc'. The number ties
    // back to supplier_project_entries.project_num so the Projects panel
    // can show project metadata (PO #, status, dates) pulled from the
    // existing supplier project tracker. NULL means "no project / ad-hoc".
    projectNum: text("project_num"),
    // Which of the 5 project document slots this file lives in. NULL for
    // non-project attachments (every other category).
    projectDocType: supplierProductProjectDocType("project_doc_type"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    contentType: text("content_type"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    uploadedByRole: text("uploaded_by_role").notNull().default("lightbase"),
    uploadedByClerkId: text("uploaded_by_clerk_id"),
    // Explicit submission timestamp surfaced on every UI card — required
    // per the brief ("everything should be dated by submission date and
    // time"). Distinct from createdAt only by name; same semantics.
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  },
  (t) => ({
    productIdx: index("supplier_product_attachments_product_idx").on(t.productId),
    categoryIdx: index("supplier_product_attachments_category_idx").on(t.category),
    uploadedIdx: index("supplier_product_attachments_uploaded_idx").on(t.uploadedAt),
  }),
);
export type SupplierProductAttachment = typeof supplierProductAttachments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITORS
// ─────────────────────────────────────────────────────────────────────────────

export const competitorTier = pgEnum("competitor_tier", [
  "mass",
  "mid",
  "spec",
  "premium",
]);

export const competitorCollections = pgTable(
  "competitor_collections",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: index("competitor_collections_name_idx").on(t.name),
  }),
);

export const competitors = pgTable(
  "competitors",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => competitorCollections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    parent: text("parent"),
    tierKey: competitorTier("tier_key").notNull().default("mid"),
    tier: text("tier"),
    segment: text("segment"),
    country: text("country"),
    productLines: text("product_lines"),
    channel: text("channel"),
    notes: text("notes"),
    capabilities: text("capabilities")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    collectionIdx: index("competitors_collection_idx").on(t.collectionId),
    nameIdx: index("competitors_name_idx").on(t.name),
    tierIdx: index("competitors_tier_idx").on(t.tierKey),
  }),
);

export const competitorAttachments = pgTable(
  "competitor_attachments",
  {
    id: serial("id").primaryKey(),
    competitorId: integer("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    uploaderClerkId: text("uploader_clerk_id"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({
    competitorIdx: index("competitor_attachments_competitor_idx").on(t.competitorId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITOR PRODUCTS — individual SKUs/products under a competitor brand,
// with their photos, dimensions, colors, certs, etc. Populated automatically
// by the AI extractor when the user drops a catalog or the brand's website.
// ─────────────────────────────────────────────────────────────────────────────

export const competitorProducts = pgTable(
  "competitor_products",
  {
    id: serial("id").primaryKey(),
    competitorId: integer("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    productCode: text("product_code"),
    productCategory: text("product_category"), // e.g. "Linear Pendant", "High-Bay"
    description: text("description"),
    // Image URLs scraped from the competitor's site or catalog. Stored as raw
    // remote URLs — they may break if the source site is restructured.
    imageUrls: text("image_urls")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    // Loose, flexible spec bag — see `ProductSpecs` shape in extract.ts.
    specs: jsonb("specs").$type<Record<string, string | string[]>>().notNull().default({}),
    sourceUrl: text("source_url"), // deep link to the product page if known
    // Content hash of the inputs that produced the current `specs` value
    // (sorted attachment url:size pairs + sourceUrl + Claude model).
    // refreshProductSpecsFromFiles skips re-analysis when this matches the
    // current input hash, so bulk "Re-analyze all" only pays for products
    // whose attachments actually changed.
    specsAnalysisHash: text("specs_analysis_hash"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    competitorIdx: index("competitor_products_competitor_idx").on(t.competitorId),
    nameIdx: index("competitor_products_name_idx").on(t.name),
  }),
);

export const competitorProductAttachments = pgTable(
  "competitor_product_attachments",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => competitorProducts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    kind: text("kind"), // "drawing", "datasheet", "ies", "image", etc.
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    uploaderClerkId: text("uploader_clerk_id"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({
    productIdx: index("competitor_product_attachments_product_idx").on(t.productId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITOR IDEATION — collection-scoped image board for brainstorming.
// Each item is an image (uploaded or referenced via URL) with a title, free-form
// notes, optional product/competitor link, and an optional sketch overlay. The
// `annotations` blob is an array of stroke paths drawn on top of the image:
//   { strokes: [{ color, width, points: [{x,y}] }] }
// stored normalized 0-1 so it scales with any rendered size.
// ─────────────────────────────────────────────────────────────────────────────

export const competitorIdeationKind = pgEnum("competitor_ideation_kind", [
  // Original values — kept for backwards compatibility with existing rows.
  "reference",   // photo of a real product / market reference
  "sketch",      // hand sketch / wireframe
  "moodboard",   // texture/finish/color reference
  "mounting",    // mounting detail
  "ai-generated", // image generated from a prompt (future use)
  // Architectural-lighting brainstorm categories added in 0006_ideation_categories.
  "lens",
  "decorative",
  "profile",
  "finish",
  "optic",
  "endcap",
  "effect",
  "control",
]);

export const competitorIdeationItems = pgTable(
  "competitor_ideation_items",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => competitorCollections.id, { onDelete: "cascade" }),
    title: text("title"),
    notes: text("notes"),
    imageUrl: text("image_url").notNull(),
    blobPathname: text("blob_pathname"),
    mimeType: text("mime_type"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    kind: competitorIdeationKind("kind").notNull().default("reference"),
    // Optional links — when set, this item is associated with a specific brand
    // or product so it shows up alongside that brand's benchmark view.
    competitorId: integer("competitor_id").references(
      () => competitors.id,
      { onDelete: "set null" },
    ),
    productId: integer("product_id").references(
      () => competitorProducts.id,
      { onDelete: "set null" },
    ),
    // Sketch strokes drawn over the image. Shape: { strokes: Stroke[] }.
    annotations: jsonb("annotations").$type<Record<string, unknown>>().notNull().default({}),
    // Free-form tag list — e.g. "mounting", "finish", "asymmetric"
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    // When true, the idea applies to every "ideation product" in the
    // collection (the products WE'RE developing). When false, the
    // idea only applies to the products linked through ideation_item_products.
    isGlobal: boolean("is_global").notNull().default(true),
    // Additional images beyond the primary `imageUrl`. The drawer shows
    // the cover first, then these in order, with prev/next navigation
    // and per-image delete. Blob pathnames track the matching ones in
    // Vercel Blob so we can clean storage when an image is removed.
    extraImageUrls: text("extra_image_urls")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    extraBlobPathnames: text("extra_blob_pathnames")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    addedByClerkId: text("added_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    collectionIdx: index("competitor_ideation_collection_idx").on(t.collectionId),
    competitorIdx: index("competitor_ideation_competitor_idx").on(t.competitorId),
    productIdx: index("competitor_ideation_product_idx").on(t.productId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// IDEATION PRODUCTS — the products the company is developing, scoped to a
// collection. Each idea (competitorIdeationItems row) can either apply to
// every product in the collection (is_global=true) or only to specific
// products via the ideation_item_products junction table below.
// ─────────────────────────────────────────────────────────────────────────────

export const ideationProducts = pgTable(
  "ideation_products",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => competitorCollections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("#2563ff"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    collectionIdx: index("ideation_products_collection_idx").on(t.collectionId),
  }),
);

export const ideationItemProducts = pgTable(
  "ideation_item_products",
  {
    ideationItemId: integer("ideation_item_id")
      .notNull()
      .references(() => competitorIdeationItems.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => ideationProducts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ideationItemId, t.productId] }),
    productIdx: index("ideation_item_products_product_idx").on(t.productId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// IDEATION PRODUCT FILES — uploads attached to either a specific ideation
// product (productId set) or to the collection itself (productId null).
// fileKind is a free-form text slot so we can grow categories without a
// schema change. Current product slots: image, design_drawing, specsheet,
// installation_manual, assembly_manual, specification_table, bom,
// arborescence. Collection slot: collection_brochure (one row per
// collection by convention; UI replaces the existing row when a new
// brochure is uploaded).
// ─────────────────────────────────────────────────────────────────────────────

export const ideationProductFiles = pgTable(
  "ideation_product_files",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => competitorCollections.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => ideationProducts.id, {
      onDelete: "cascade",
    }),
    fileKind: text("file_kind").notNull(),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    uploaderClerkId: text("uploader_clerk_id"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({
    productIdx: index("ideation_product_files_product_idx").on(t.productId),
    collectionIdx: index("ideation_product_files_collection_idx").on(t.collectionId),
    kindIdx: index("ideation_product_files_kind_idx").on(t.fileKind),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// HANDBOOK REVISIONS — snapshots of the interactive Process Handbook content
// for a given user. Each row holds the full {data, itemState, _uid} blob from
// the in-page editor. Drafts can be saved repeatedly; submitting flips status
// to "final" but does not lock the row — users can keep editing afterward.
// ─────────────────────────────────────────────────────────────────────────────

export const handbookRevisionStatus = pgEnum("handbook_revision_status", [
  "draft",
  "final",
]);

export const handbookRevisions = pgTable(
  "handbook_revisions",
  {
    id: serial("id").primaryKey(),
    ownerClerkId: text("owner_clerk_id").notNull(),
    name: text("name").notNull().default("Untitled"),
    content: jsonb("content").notNull(),
    status: handbookRevisionStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("handbook_revisions_owner_idx").on(t.ownerClerkId),
    statusIdx: index("handbook_revisions_status_idx").on(t.status),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONS (for typed joins)
// ─────────────────────────────────────────────────────────────────────────────

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  projectEntries: many(supplierProjectEntries),
  comments: many(supplierComments),
  attachments: many(supplierAttachments),
  products: many(supplierProducts),
}));

export const supplierProductsRelations = relations(
  supplierProducts,
  ({ one, many }) => ({
    supplier: one(suppliers, {
      fields: [supplierProducts.supplierId],
      references: [suppliers.id],
    }),
    attachments: many(supplierProductAttachments),
  }),
);

export const supplierProductAttachmentsRelations = relations(
  supplierProductAttachments,
  ({ one }) => ({
    product: one(supplierProducts, {
      fields: [supplierProductAttachments.productId],
      references: [supplierProducts.id],
    }),
  }),
);

export const supplierProjectEntriesRelations = relations(
  supplierProjectEntries,
  ({ one }) => ({
    supplier: one(suppliers, {
      fields: [supplierProjectEntries.supplierId],
      references: [suppliers.id],
    }),
  }),
);

export const supplierCommentsRelations = relations(supplierComments, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [supplierComments.supplierId],
    references: [suppliers.id],
  }),
}));

export const supplierAttachmentsRelations = relations(
  supplierAttachments,
  ({ one }) => ({
    supplier: one(suppliers, {
      fields: [supplierAttachments.supplierId],
      references: [suppliers.id],
    }),
  }),
);

export const competitorCollectionsRelations = relations(
  competitorCollections,
  ({ many }) => ({
    competitors: many(competitors),
    ideationItems: many(competitorIdeationItems),
  }),
);

export const competitorIdeationItemsRelations = relations(
  competitorIdeationItems,
  ({ one }) => ({
    collection: one(competitorCollections, {
      fields: [competitorIdeationItems.collectionId],
      references: [competitorCollections.id],
    }),
    competitor: one(competitors, {
      fields: [competitorIdeationItems.competitorId],
      references: [competitors.id],
    }),
    product: one(competitorProducts, {
      fields: [competitorIdeationItems.productId],
      references: [competitorProducts.id],
    }),
  }),
);

export const competitorsRelations = relations(competitors, ({ one, many }) => ({
  collection: one(competitorCollections, {
    fields: [competitors.collectionId],
    references: [competitorCollections.id],
  }),
  attachments: many(competitorAttachments),
  products: many(competitorProducts),
}));

export const competitorAttachmentsRelations = relations(
  competitorAttachments,
  ({ one }) => ({
    competitor: one(competitors, {
      fields: [competitorAttachments.competitorId],
      references: [competitors.id],
    }),
  }),
);

export const competitorProductsRelations = relations(
  competitorProducts,
  ({ one, many }) => ({
    competitor: one(competitors, {
      fields: [competitorProducts.competitorId],
      references: [competitors.id],
    }),
    attachments: many(competitorProductAttachments),
  }),
);

export const competitorProductAttachmentsRelations = relations(
  competitorProductAttachments,
  ({ one }) => ({
    product: one(competitorProducts, {
      fields: [competitorProductAttachments.productId],
      references: [competitorProducts.id],
    }),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type UserProfile = typeof userProfiles.$inferSelect;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type SupplierProjectEntry = typeof supplierProjectEntries.$inferSelect;
export type NewSupplierProjectEntry = typeof supplierProjectEntries.$inferInsert;
export type SupplierComment = typeof supplierComments.$inferSelect;
export type SupplierAttachment = typeof supplierAttachments.$inferSelect;
export type CompetitorCollection = typeof competitorCollections.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type NewCompetitor = typeof competitors.$inferInsert;
export type CompetitorAttachment = typeof competitorAttachments.$inferSelect;
export type CompetitorProduct = typeof competitorProducts.$inferSelect;
export type NewCompetitorProduct = typeof competitorProducts.$inferInsert;
export type CompetitorProductAttachment = typeof competitorProductAttachments.$inferSelect;
export type HandbookRevision = typeof handbookRevisions.$inferSelect;
export type NewHandbookRevision = typeof handbookRevisions.$inferInsert;
export type CompetitorIdeationItem = typeof competitorIdeationItems.$inferSelect;
export type NewCompetitorIdeationItem = typeof competitorIdeationItems.$inferInsert;
export type IdeationProduct = typeof ideationProducts.$inferSelect;
export type NewIdeationProduct = typeof ideationProducts.$inferInsert;
export type IdeationItemProduct = typeof ideationItemProducts.$inferSelect;
export type IdeationProductFile = typeof ideationProductFiles.$inferSelect;
export type NewIdeationProductFile = typeof ideationProductFiles.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// MUNICIPAL CONTACTS — Tools / Canadian municipality contact directory.
// A user picks a province + scope (cities / towns / villages / all) and an
// optional municipality name filter, sets a target count, and the system
// asks Perplexity for engineering + administration contacts and stores them
// here. Each search row groups its own contact list. Searches are kept so
// the user can re-open / refine / re-export later.
// ─────────────────────────────────────────────────────────────────────────────

export const municipalitySearches = pgTable(
  "municipality_searches",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull().default("Canada"),
    province: text("province").notNull(),
    // Comma-list of "city" | "town" | "village" | "municipality" | "all".
    scopeTypes: text("scope_types").notNull().default("all"),
    // Comma-list of category codes ("engineering", "public-works",
    // "administration", "elected", "other") to bias the Perplexity research
    // toward, or "all" for no filter. Mirrors municipalityContacts.category.
    sectors: text("sectors").notNull().default("all"),
    cityFilter: text("city_filter"), // optional: limit to one named municipality
    requestedCount: integer("requested_count").notNull().default(25),
    title: text("title"), // free-form label set by the user
    notes: text("notes"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    provinceIdx: index("municipality_searches_province_idx").on(t.province),
    createdAtIdx: index("municipality_searches_created_at_idx").on(t.createdAt),
  }),
);

export const municipalityContacts = pgTable(
  "municipality_contacts",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id")
      .notNull()
      .references(() => municipalitySearches.id, { onDelete: "cascade" }),
    municipalityName: text("municipality_name").notNull(),
    municipalityType: text("municipality_type"), // city / town / village / municipality
    province: text("province").notNull(),
    department: text("department"), // "Engineering", "Public Works", "Administration", etc.
    role: text("role"), // "City Engineer", "Director of Public Works", "Mayor", "Town Clerk"
    category: text("category"), // canonical bucket: "engineering" | "administration" | "public-works" | "other"
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    website: text("website"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    // Free-form summary of what services this department offers / what
    // they do. Filled by Perplexity during research and shown on the
    // contact card so users don't have to click through to a source page
    // to know whether the lead is relevant.
    servicesSummary: text("services_summary"),
    // Timestamp set when this contact was downloaded as part of a HubSpot
    // export. Drives the "Export N new" vs "Re-export all" UI logic so the
    // user only re-exports what's been added since the last download.
    exportedAt: timestamp("exported_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    searchIdx: index("municipality_contacts_search_idx").on(t.searchId),
    categoryIdx: index("municipality_contacts_category_idx").on(t.category),
    provinceIdx: index("municipality_contacts_province_idx").on(t.province),
    exportedAtIdx: index("municipality_contacts_exported_at_idx").on(t.exportedAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PER-USER HUBSPOT EXPORT TRACKING
//
// Each user has their own "what have I exported?" view. So if user A pulls
// the full directory into HubSpot, user B still sees every contact as "new"
// for their own pipeline. Many-to-many between contacts and clerk users.
// Row gets inserted (or its exported_at refreshed) the first time the user
// downloads that contact.
// ─────────────────────────────────────────────────────────────────────────────

export const municipalityContactExports = pgTable(
  "municipality_contact_exports",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => municipalityContacts.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    exportedAt: timestamp("exported_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.contactId, t.clerkUserId] }),
    userIdx: index("municipality_contact_exports_user_idx").on(t.clerkUserId),
  }),
);

export type MunicipalitySearch = typeof municipalitySearches.$inferSelect;
export type NewMunicipalitySearch = typeof municipalitySearches.$inferInsert;
export type MunicipalityContact = typeof municipalityContacts.$inferSelect;
export type NewMunicipalityContact = typeof municipalityContacts.$inferInsert;
export type MunicipalityContactExport = typeof municipalityContactExports.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// MUNICIPAL CONTACT LIST — Tools / static directory of every Quebec
// municipality, seeded from the MAMH "Répertoire des municipalités" CSV.
// One row per municipality (~1,100 rows). Unlike `municipality_contacts`,
// which is generated on-demand by Perplexity + Claude, this table is a
// curated reference list the user can filter/edit/extend over time.
//
// Council members are stored as a JSONB array because the source CSV has
// up to 75 councillor columns most of which are empty — flattening them
// into named columns would waste schema. Other admin roles (DG, treasurer,
// clerk, fire, public works, etc.) are kept as named columns so they're
// easy to filter on in SQL and surface in the UI.
// ─────────────────────────────────────────────────────────────────────────────

export const municipalityListEntries = pgTable(
  "municipality_list_entries",
  {
    id: serial("id").primaryKey(),
    // Source code from MAMH CSV (mcode). Unique so re-running the import
    // upserts rather than duplicates. Null for user-added entries.
    sourceCode: text("source_code"),

    // Name + designation
    name: text("name").notNull(),
    designationCode: integer("designation_code"), // mcodedesi
    designation: text("designation"), // mdes ("Ville", "Municipalité", "Paroisse", "Canton", ...)
    gentile: text("gentile"), // residents' demonym

    // Contact
    email: text("email"),
    website: text("website"),
    phone: text("phone"),
    fax: text("fax"),

    // Address
    addressLine: text("address_line"),
    addressCity: text("address_city"),
    addressPostal: text("address_postal"),

    // Geography
    region: text("region"), // regadm
    mrc: text("mrc"),
    mrcFull: text("mrc_full"),

    // Stats
    areaKm2: numeric("area_km2"),
    population: integer("population"),

    // Election + governance
    dateIncorporation: text("date_incorporation"),
    dateElection: text("date_election"),
    electionMode: text("election_mode"),
    circonscription: text("circonscription"),

    // Mayor
    mayor: text("mayor"),

    // Councillors — array of names (variable length, ~6 typical)
    councillors: jsonb("councillors").$type<string[]>(),

    // Administrative staff (key roles)
    directorGeneral: text("director_general"),
    deputyDg: text("deputy_dg"),
    treasurer: text("treasurer"),
    clerk: text("clerk"),
    policeChief: text("police_chief"),
    fireChief: text("fire_chief"),
    recreationDirector: text("recreation_director"),
    publicWorksDirector: text("public_works_director"),
    emergencyMeasures: text("emergency_measures"),
    urbanPlanner: text("urban_planner"),
    communications: text("communications"),
    permits: text("permits"),
    buildingInspector: text("building_inspector"),

    // User-managed metadata
    notes: text("notes"),
    // false for cards the user added manually after import; lets us avoid
    // overwriting hand-edited rows on re-import.
    isImported: boolean("is_imported").notNull().default(true),

    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    sourceCodeIdx: uniqueIndex("municipality_list_entries_source_code_idx").on(
      t.sourceCode,
    ),
    nameIdx: index("municipality_list_entries_name_idx").on(t.name),
    regionIdx: index("municipality_list_entries_region_idx").on(t.region),
    mrcIdx: index("municipality_list_entries_mrc_idx").on(t.mrc),
    designationIdx: index("municipality_list_entries_designation_idx").on(
      t.designation,
    ),
  }),
);

export type MunicipalityListEntry =
  typeof municipalityListEntries.$inferSelect;
export type NewMunicipalityListEntry =
  typeof municipalityListEntries.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// PER-USER EXPORT TRACKING for the curated municipal list — same shape as
// `municipality_contact_exports` but pointing at `municipality_list_entries`.
// Drives the "↓ HubSpot — N new" button label: each user has their own
// "what have I exported?" view, so user A pulling the full directory still
// leaves user B's "new" count intact.
// ─────────────────────────────────────────────────────────────────────────────

export const municipalityListExports = pgTable(
  "municipality_list_exports",
  {
    entryId: integer("entry_id")
      .notNull()
      .references(() => municipalityListEntries.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    exportedAt: timestamp("exported_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entryId, t.clerkUserId] }),
    userIdx: index("municipality_list_exports_user_idx").on(t.clerkUserId),
  }),
);

export type MunicipalityListExport =
  typeof municipalityListExports.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN & ENGINEERING — Stage 1 workflow projects
//
// A "design project" is one CADuniQ workflow run: the engineer uploads a CAD,
// builds a BOM, gets AI material/process recommendations, optionally attaches
// FEA/installation-manual placeholders, and finally approves the package.
// Modeled after the seven-step Stage 1 flow in CADuniQ_Concept_Guide.html.
// ─────────────────────────────────────────────────────────────────────────────

export const designProjectStatus = pgEnum("design_project_status", [
  "draft",
  "in-review",
  "approved",
]);

export type DesignCadFile = {
  url: string;
  name: string;
  size: number;
  mime: string | null;
  blobPathname: string;
};

export type DesignBomItem = {
  /** Stable client-side ID so re-orders / edits don't conflict. */
  id: string;
  itemNumber: string;
  partName: string;
  productCode: string;
  description: string;
  quantity: number;
  material: string;
  process: string;
  notes: string;
  /** Set by aiRecommendMaterialProcess when the user runs the recommender. */
  aiRecommendation?: {
    material: string;
    process: string;
    rationale: string;
    estimatedCostUsd: number | null;
    model: string;
    at: string;
  } | null;
};

export type DesignDrawingSettings = {
  standard: "ANSI Y14.5" | "ISO 128" | "JIS B 0001" | "DIN" | "";
  units: "mm" | "in" | "";
  sheetSize: "A4" | "A3" | "A2" | "A1" | "A0" | "Letter" | "Tabloid" | "";
  scale: string;
};

export const designProjects = pgTable(
  "design_projects",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    name: text("name").notNull(),
    niche: text("niche"),
    description: text("description"),
    status: designProjectStatus("status").notNull().default("draft"),
    cadFiles: jsonb("cad_files")
      .$type<DesignCadFile[]>()
      .notNull()
      .default([]),
    drawingSettings: jsonb("drawing_settings")
      .$type<DesignDrawingSettings>()
      .notNull()
      .default({
        standard: "ANSI Y14.5",
        units: "mm",
        sheetSize: "A3",
        scale: "1:1",
      }),
    bomItems: jsonb("bom_items")
      .$type<DesignBomItem[]>()
      .notNull()
      .default([]),
    feaNotes: text("fea_notes").notNull().default(""),
    manualNotes: text("manual_notes").notNull().default(""),
    approvalNotes: text("approval_notes").notNull().default(""),
    approvedAt: timestamp("approved_at"),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("design_projects_user_idx").on(t.clerkUserId),
    statusIdx: index("design_projects_status_idx").on(t.status),
  }),
);

export type DesignProject = typeof designProjects.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// CRM — Stage 4 (Customer Lifecycle)
//
// Five tables that together form the customer system of record:
//   crm_accounts        — companies / organisations
//   crm_contacts        — people, FK to account
//   crm_opportunities   — pipeline deals, FK to account
//   crm_activities      — timeline events (calls, emails, meetings, notes)
//   crm_tickets         — support requests, FK to account
//
// All five live behind a row-level "ownerUserId" check so non-admin users
// see only what they own; admins see every record. Same pattern as
// design_projects.
// ─────────────────────────────────────────────────────────────────────────────

export const crmAccountTier = pgEnum("crm_account_tier", [
  "lead",
  "prospect",
  "customer",
  "partner",
  "churned",
]);

// 8-stage pipeline. Concept guide §1 calls for 10; we collapse the rarely-
// used "Active" / "Renewal" into a single "Customer" terminal state since
// those are post-sale customer-success motions handled in the account
// record itself (tier=customer).
export const crmOpportunityStage = pgEnum("crm_opportunity_stage", [
  "lead",
  "qualified",
  "demo",
  "proposal",
  "negotiation",
  "won",
  "lost",
  "on-hold",
]);

export const crmActivityType = pgEnum("crm_activity_type", [
  "call",
  "email",
  "meeting",
  "note",
  "task",
]);

export const crmTicketStatus = pgEnum("crm_ticket_status", [
  "open",
  "in-progress",
  "resolved",
  "closed",
]);

export const crmTicketPriority = pgEnum("crm_ticket_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const crmAccounts = pgTable(
  "crm_accounts",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    website: text("website"),
    industry: text("industry"),
    tier: crmAccountTier("tier").notNull().default("lead"),
    country: text("country"),
    employeeCount: integer("employee_count"),
    annualRevenueUsd: numeric("annual_revenue_usd", { precision: 14, scale: 2 }),
    notes: text("notes"),
    // 0-100 score derived from activity + opportunity + ticket signals.
    // The Stage 4e full 11-input model lands later; this is the seed.
    healthScore: integer("health_score").notNull().default(50),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("crm_accounts_owner_idx").on(t.ownerUserId),
    tierIdx: index("crm_accounts_tier_idx").on(t.tier),
    nameIdx: index("crm_accounts_name_idx").on(t.name),
  }),
);

export type CrmAccount = typeof crmAccounts.$inferSelect;

export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => crmAccounts.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    accountIdx: index("crm_contacts_account_idx").on(t.accountId),
    emailIdx: index("crm_contacts_email_idx").on(t.email),
  }),
);

export type CrmContact = typeof crmContacts.$inferSelect;

export const crmOpportunities = pgTable(
  "crm_opportunities",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => crmAccounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    stage: crmOpportunityStage("stage").notNull().default("lead"),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    // 0-100 win probability. The product-led variant (4i) replaces this
    // with an ML model trained on platform usage signals; for now the user
    // sets it.
    probability: integer("probability").notNull().default(20),
    expectedCloseDate: date("expected_close_date"),
    closedAt: timestamp("closed_at"),
    closedReason: text("closed_reason"),
    nextStep: text("next_step"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    accountIdx: index("crm_opportunities_account_idx").on(t.accountId),
    stageIdx: index("crm_opportunities_stage_idx").on(t.stage),
  }),
);

export type CrmOpportunity = typeof crmOpportunities.$inferSelect;

export const crmActivities = pgTable(
  "crm_activities",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => crmAccounts.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => crmContacts.id, {
      onDelete: "set null",
    }),
    opportunityId: integer("opportunity_id").references(
      () => crmOpportunities.id,
      { onDelete: "set null" },
    ),
    type: crmActivityType("type").notNull().default("note"),
    subject: text("subject").notNull(),
    body: text("body"),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    accountIdx: index("crm_activities_account_idx").on(t.accountId),
    occurredIdx: index("crm_activities_occurred_idx").on(t.occurredAt),
  }),
);

export type CrmActivity = typeof crmActivities.$inferSelect;

export const crmTickets = pgTable(
  "crm_tickets",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => crmAccounts.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => crmContacts.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull(),
    body: text("body").notNull().default(""),
    status: crmTicketStatus("status").notNull().default("open"),
    priority: crmTicketPriority("priority").notNull().default("medium"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    accountIdx: index("crm_tickets_account_idx").on(t.accountId),
    statusIdx: index("crm_tickets_status_idx").on(t.status),
  }),
);

export type CrmTicket = typeof crmTickets.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 6 · OEE & FLOOR OPS
//
// Real-time OEE / TRS monitoring. A "machine" is one physical asset; a
// "production run" is one scheduled batch on that machine; "downtime events"
// pause runs (planned changeovers or unplanned breakdowns); "quality events"
// record scrap or rework against a run. OEE is recalculated on demand from
// these tables — Availability = run_time / planned_time, Performance =
// (ideal_cycle * good_count) / run_time, Quality = good / total.
// "Alerts" fire when a machine has been down too long or its OEE has dropped
// below a threshold; an alert can be escalated to a CRM ticket so the
// account team picks it up. Schema is intentionally hand-maintained (not
// IoT-fed) for v1 — operators record runs / downtime / quality through the
// UI, so the app is functional from day one without sensor plumbing.
// ─────────────────────────────────────────────────────────────────────────────

export const oeeMachineStatus = pgEnum("oee_machine_status", [
  "running",
  "idle",
  "down",
  "maintenance",
  "offline",
]);

export const oeeDowntimeReason = pgEnum("oee_downtime_reason", [
  "breakdown",
  "setup",
  "material",
  "changeover",
  "maintenance",
  "no-operator",
  "quality-hold",
  "other",
]);

export const oeeDowntimeCategory = pgEnum("oee_downtime_category", [
  "planned",
  "unplanned",
]);

export const oeeQualityType = pgEnum("oee_quality_type", [
  "scrap",
  "rework",
  "defect",
]);

export const oeeAlertSeverity = pgEnum("oee_alert_severity", [
  "info",
  "warning",
  "critical",
]);

export const oeeAlertStatus = pgEnum("oee_alert_status", [
  "open",
  "acknowledged",
  "resolved",
  "escalated",
]);

export const oeeMachines = pgTable(
  "oee_machines",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    line: text("line"),
    location: text("location"),
    // Ideal cycle time in seconds-per-unit. The "performance" leg of OEE
    // is `ideal_cycle * good_count / run_time` — without this number the
    // calculation can't run.
    idealCycleSeconds: numeric("ideal_cycle_seconds", {
      precision: 8,
      scale: 3,
    }).notNull().default("60"),
    status: oeeMachineStatus("status").notNull().default("idle"),
    statusSince: timestamp("status_since").defaultNow().notNull(),
    // Free-form notes (asset tag, serial, manufacturer).
    notes: text("notes"),
    // Optional CRM account this machine belongs to — if set, alerts can
    // auto-escalate to a CRM ticket on this account.
    crmAccountId: integer("crm_account_id").references(() => crmAccounts.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("oee_machines_owner_idx").on(t.ownerUserId),
    statusIdx: index("oee_machines_status_idx").on(t.status),
    lineIdx: index("oee_machines_line_idx").on(t.line),
  }),
);

export type OeeMachine = typeof oeeMachines.$inferSelect;

export const oeeRuns = pgTable(
  "oee_runs",
  {
    id: serial("id").primaryKey(),
    machineId: integer("machine_id")
      .notNull()
      .references(() => oeeMachines.id, { onDelete: "cascade" }),
    partNumber: text("part_number").notNull(),
    partName: text("part_name"),
    plannedStart: timestamp("planned_start").notNull(),
    plannedEnd: timestamp("planned_end").notNull(),
    actualStart: timestamp("actual_start"),
    actualEnd: timestamp("actual_end"),
    targetCount: integer("target_count").notNull().default(0),
    goodCount: integer("good_count").notNull().default(0),
    scrapCount: integer("scrap_count").notNull().default(0),
    reworkCount: integer("rework_count").notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    machineIdx: index("oee_runs_machine_idx").on(t.machineId),
    startIdx: index("oee_runs_planned_start_idx").on(t.plannedStart),
  }),
);

export type OeeRun = typeof oeeRuns.$inferSelect;

export const oeeDowntimeEvents = pgTable(
  "oee_downtime_events",
  {
    id: serial("id").primaryKey(),
    machineId: integer("machine_id")
      .notNull()
      .references(() => oeeMachines.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => oeeRuns.id, {
      onDelete: "set null",
    }),
    reason: oeeDowntimeReason("reason").notNull(),
    category: oeeDowntimeCategory("category").notNull(),
    startAt: timestamp("start_at").notNull(),
    endAt: timestamp("end_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    machineIdx: index("oee_downtime_machine_idx").on(t.machineId),
    startIdx: index("oee_downtime_start_idx").on(t.startAt),
    reasonIdx: index("oee_downtime_reason_idx").on(t.reason),
  }),
);

export type OeeDowntimeEvent = typeof oeeDowntimeEvents.$inferSelect;

export const oeeQualityEvents = pgTable(
  "oee_quality_events",
  {
    id: serial("id").primaryKey(),
    machineId: integer("machine_id")
      .notNull()
      .references(() => oeeMachines.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => oeeRuns.id, {
      onDelete: "set null",
    }),
    type: oeeQualityType("type").notNull(),
    quantity: integer("quantity").notNull().default(1),
    defectCode: text("defect_code"),
    notes: text("notes"),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    machineIdx: index("oee_quality_machine_idx").on(t.machineId),
    occurredIdx: index("oee_quality_occurred_idx").on(t.occurredAt),
  }),
);

export type OeeQualityEvent = typeof oeeQualityEvents.$inferSelect;

export const oeeAlerts = pgTable(
  "oee_alerts",
  {
    id: serial("id").primaryKey(),
    machineId: integer("machine_id")
      .notNull()
      .references(() => oeeMachines.id, { onDelete: "cascade" }),
    severity: oeeAlertSeverity("severity").notNull().default("warning"),
    status: oeeAlertStatus("status").notNull().default("open"),
    code: text("code").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Set when escalated to CRM — points at the crm_tickets.id created from
    // this alert so we don't accidentally duplicate-escalate.
    crmTicketId: integer("crm_ticket_id").references(() => crmTickets.id, {
      onDelete: "set null",
    }),
    raisedAt: timestamp("raised_at").defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    machineIdx: index("oee_alerts_machine_idx").on(t.machineId),
    statusIdx: index("oee_alerts_status_idx").on(t.status),
    raisedIdx: index("oee_alerts_raised_idx").on(t.raisedAt),
  }),
);

export type OeeAlert = typeof oeeAlerts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// ERP · RFQs → SUPPLIER QUOTES → PURCHASE ORDERS
//
// End-to-end procurement workflow. Replaces the manual employee-driven flow
// where an RFQ Excel got emailed to suppliers and each quote came back as a
// PDF. New flow:
//   1. Buyer creates an `rfqs` row (project, niche, transport preference,
//      target currency) with one or more `rfq_items` line items.
//   2. Buyer invites N suppliers (`rfq_recipients`). Each recipient gets a
//      unique magic-link token granting access to /vendor/[token].
//   3. Supplier opens the link, fills out `supplier_quotes` + per-item
//      `supplier_quote_lines` and uploads `supplier_quote_attachments`
//      (datasheets, certs, brochures). New suppliers auto-create a row in
//      `suppliers` on first submission.
//   4. Buyer compares quotes side-by-side, picks one, and `purchase_orders`
//      is generated from the winning quote with the company's PO template.
//   5. Every meaningful event (RFQ sent, quote received, RFQ awarded, PO
//      issued) lands in `erp_notifications` so the team gets bell alerts.
//
// Migration 0024. Self-healed in src/app/suppliers/_ensure-orders-schema.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const rfqStatus = pgEnum("rfq_status", [
  "draft",
  "sent",
  "quotes-in",
  "reviewed",
  "awarded",
  "closed",
  "cancelled",
]);

export const rfqStage = pgEnum("rfq_stage", [
  "selection",   // shopping the market — multiple suppliers competing
  "committed",   // we already know who we're using; just need the paperwork
]);

export const rfqTransportMode = pgEnum("rfq_transport_mode", [
  "air",
  "sea",
  "truck",
  "rail",
  "courier",
  "any",
]);

export const quoteStatus = pgEnum("supplier_quote_status", [
  "invited",      // token issued, no portal access yet
  "viewed",       // supplier opened the portal
  "draft",        // supplier started filling out
  "submitted",    // supplier finished + locked
  "declined",     // supplier said "no thanks"
  "expired",      // validity passed without award
]);

export const poStatus = pgEnum("purchase_order_status", [
  "draft",
  "sent",
  "acknowledged",
  "in-production",
  "shipped",
  "received",
  "closed",
  "cancelled",
]);

export const notificationKind = pgEnum("erp_notification_kind", [
  "rfq.sent",
  "rfq.quote-received",
  "rfq.awarded",
  "po.issued",
  "po.acknowledged",
  "po.shipped",
  "supplier.signed-up",
  "supplier.status-update",
  // Migration 0029 — payment + tracking workflow
  "po.payment-method-set",
  "po.invoice-issued",
  "po.invoice-status",
  "po.payment-recorded",
  "po.timeline-update",
]);

export const poInvoiceStatus = pgEnum("po_invoice_status", [
  "issued",
  "received",
  "approved",
  "scheduled",
  "paid",
  "disputed",
  "cancelled",
]);

export const rfqs = pgTable(
  "rfqs",
  {
    id: serial("id").primaryKey(),
    rfqNumber: text("rfq_number").notNull(),     // human-readable, e.g. "RFQ-260515-001"
    projectNum: text("project_num").notNull(),   // e.g. "1425"
    projectName: text("project_name"),            // e.g. "Ledco"
    niche: text("niche"),                          // category we're shopping
    stage: rfqStage("stage").notNull().default("selection"),
    status: rfqStatus("status").notNull().default("draft"),
    transportMode: rfqTransportMode("transport_mode")
      .notNull()
      .default("any"),
    targetCurrency: text("target_currency").notNull().default("USD"),
    incoterms: text("incoterms"),                  // FOB, EXW, DAP, DDP, etc.
    targetDeliveryDate: date("target_delivery_date"),
    quoteDeadline: timestamp("quote_deadline"),
    notes: text("notes"),
    ownerClerkId: text("owner_clerk_id").notNull(),
    awardedQuoteId: integer("awarded_quote_id"),  // FK fixed up in migration
    // Optional buyer-uploaded RFQ PDF (e.g. external RFQ format with logos /
    // covering pages). When present, the supplier sees this PDF; when
    // absent, they see the platform-generated print view. Migration 0028.
    sourcePdfUrl: text("source_pdf_url"),
    sourcePdfName: text("source_pdf_name"),
    sourcePdfPathname: text("source_pdf_pathname"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    numberIdx: uniqueIndex("rfqs_number_idx").on(t.rfqNumber),
    projectIdx: index("rfqs_project_idx").on(t.projectNum),
    statusIdx: index("rfqs_status_idx").on(t.status),
    ownerIdx: index("rfqs_owner_idx").on(t.ownerClerkId),
  }),
);

export type Rfq = typeof rfqs.$inferSelect;

export const rfqItems = pgTable(
  "rfq_items",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    clientRef: text("client_ref"),               // L18SM, L18, etc.
    productCode: text("product_code"),            // internal product code
    description: text("description").notNull(),   // 2X2 PANEL, 120-347V, 5000K, SURFACE MOUNT
    specifications: text("specifications"),       // long-form spec text
    qty: integer("qty").notNull().default(1),
    securityStock: integer("security_stock").notNull().default(0),
    targetUnitPrice: numeric("target_unit_price", { precision: 12, scale: 4 }),
    productUrl: text("product_url"),              // optional link to product page
    catalogAttachmentUrl: text("catalog_attachment_url"), // optional brand catalog PDF/XLSX
    catalogAttachmentName: text("catalog_attachment_name"),
    notes: text("notes"),
    // Migration 0032 — inventory linkage. lightbase_ref is the human code
    // (e.g. "LB-000123"); inventoryItemId is the FK that survives renames.
    lightbaseRef: text("lightbase_ref"),
    inventoryItemId: integer("inventory_item_id"),
    // Catalogue linkage. When a buyer picks a product from the supplier
    // catalogue to pre-fill an RFQ line, we keep the link so the PO →
    // catalogue + inventory dispatch can find the product without
    // string-matching codes.
    supplierProductId: integer("supplier_product_id"),
    // "Used for" linkage — which Lightbase assembly (inventory_items
    // row, kind='assembly') is this line being procured for. Lets the
    // team see every part / consumable that's been ordered to build a
    // given finished product. Distinct from parent_assembly_id on the
    // inventory item itself: parent_assembly_id is a fixed BOM
    // hierarchy on the inventory side; for_inventory_item_id is the
    // per-order "what's this order for" tag.
    forInventoryItemId: integer("for_inventory_item_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    rfqIdx: index("rfq_items_rfq_idx").on(t.rfqId),
    lightbaseRefIdx: index("rfq_items_lightbase_ref_idx").on(t.lightbaseRef),
    inventoryItemIdx: index("rfq_items_inventory_item_idx").on(t.inventoryItemId),
    supplierProductIdx: index("rfq_items_supplier_product_idx").on(t.supplierProductId),
    forInventoryItemIdx: index("rfq_items_for_inventory_item_idx").on(t.forInventoryItemId),
  }),
);

export type RfqItem = typeof rfqItems.$inferSelect;

// Multiple photos + documents per RFQ line item. Replaces the single
// catalog_attachment_url/name columns on rfq_items (those stay for back-
// compat but new uploads land here). Migration 0030.
export const rfqItemAttachments = pgTable(
  "rfq_item_attachments",
  {
    id: serial("id").primaryKey(),
    rfqItemId: integer("rfq_item_id")
      .notNull()
      .references(() => rfqItems.id, { onDelete: "cascade" }),
    // "photo" renders inline; "doc" renders as a downloadable chip.
    kind: text("kind").notNull().default("doc"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    contentType: text("content_type"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    itemIdx: index("rfq_item_attachments_item_idx").on(t.rfqItemId),
    kindIdx: index("rfq_item_attachments_kind_idx").on(t.kind),
  }),
);
export type RfqItemAttachment = typeof rfqItemAttachments.$inferSelect;

export const rfqRecipients = pgTable(
  "rfq_recipients",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    // Either points at an existing supplier OR captures a new-supplier
    // invite by email (supplier row auto-created when they sign in).
    supplierId: integer("supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    inviteEmail: text("invite_email").notNull(),
    inviteName: text("invite_name"),             // free-form contact / company name
    accessToken: text("access_token").notNull(), // 32-char magic-link token
    tokenExpiresAt: timestamp("token_expires_at").notNull(),
    status: quoteStatus("status").notNull().default("invited"),
    invitedAt: timestamp("invited_at").defaultNow().notNull(),
    viewedAt: timestamp("viewed_at"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    rfqIdx: index("rfq_recipients_rfq_idx").on(t.rfqId),
    tokenIdx: uniqueIndex("rfq_recipients_token_idx").on(t.accessToken),
    emailIdx: index("rfq_recipients_email_idx").on(t.inviteEmail),
  }),
);

export type RfqRecipient = typeof rfqRecipients.$inferSelect;

// Drafted / sent outbound RFQ emails. Tracks the entire lifecycle:
//   draft → pending_procurement_review → approved → sent
//                                     → rejected
// Direct sends skip 'pending_procurement_review' and go straight to 'sent'.
// Procurement-routed drafts wait in the queue for Imen's review.
export const rfqEmailDraftStatus = pgEnum("rfq_email_draft_status", [
  "draft",
  "pending_procurement_review",
  "approved",
  "rejected",
  "sent",
]);
export const rfqEmailDraftRoute = pgEnum("rfq_email_draft_route", [
  // Bypass procurement; goes straight to the supplier on send.
  "direct_to_supplier",
  // Routed through procurement (currently imendo@lightbase.ca) for
  // review before any external message is sent.
  "via_procurement",
]);

export const rfqEmailDrafts = pgTable(
  "rfq_email_drafts",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    // The RFQ recipient row this email is tied to. When the supplier is
    // already registered we have a recipient (with magic-link token);
    // when not, the recipient is still created so the supplier portal
    // works once they click through.
    recipientId: integer("recipient_id").references(() => rfqRecipients.id, {
      onDelete: "set null",
    }),
    supplierId: integer("supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    // Final destination. We carry it separately from recipient so
    // procurement re-routing can override (e.g. send to a different
    // supplier email after review).
    toEmail: text("to_email").notNull(),
    toName: text("to_name"),
    // Reply-to is the requesting user's real email so supplier replies
    // land in their inbox (regardless of which sender address Resend uses).
    replyToEmail: text("reply_to_email"),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    // Optional AI-generated summary used when the supplier isn't
    // registered on the platform — gives them full context in plain
    // language without a dashboard.
    aiSummary: text("ai_summary"),
    // Whether this email also includes the magic-link URL for the
    // recipient (registered suppliers click into the vendor portal).
    includeMagicLink: boolean("include_magic_link").notNull().default(true),
    route: rfqEmailDraftRoute("route").notNull(),
    // Delivery flags. These four toggles are mutually exclusive in pairs:
    // the user picks EITHER deliver-to-supplier-* (send now) OR
    // procurement-* (route through procurement first); never both. Within
    // each pair both can be true → e.g. notify procurement on the platform
    // AND email her at the same time.
    deliverToSupplierEmail: boolean("deliver_to_supplier_email")
      .notNull()
      .default(false),
    deliverToSupplierPlatform: boolean("deliver_to_supplier_platform")
      .notNull()
      .default(false),
    procurementViaEmail: boolean("procurement_via_email")
      .notNull()
      .default(false),
    procurementViaPlatform: boolean("procurement_via_platform")
      .notNull()
      .default(false),
    status: rfqEmailDraftStatus("status").notNull().default("draft"),
    // Audit trail: who composed, who reviewed, who sent.
    composedByClerkId: text("composed_by_clerk_id"),
    composedAt: timestamp("composed_at").defaultNow().notNull(),
    reviewedByClerkId: text("reviewed_by_clerk_id"),
    reviewedAt: timestamp("reviewed_at"),
    // Procurement's comment when rejecting (or appended to the email
    // when approving with edits).
    reviewerNotes: text("reviewer_notes"),
    sentAt: timestamp("sent_at"),
    // Resend message id once delivered (or "dev-<uuid>" in dev mode).
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    rfqIdx: index("rfq_email_drafts_rfq_idx").on(t.rfqId),
    statusIdx: index("rfq_email_drafts_status_idx").on(t.status),
  }),
);
export type RfqEmailDraft = typeof rfqEmailDrafts.$inferSelect;

export const supplierQuotes = pgTable(
  "supplier_quotes",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => rfqRecipients.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    // Supplier-entered fields (snapshot at submission time so future supplier-
    // record edits don't change the historical quote).
    companyName: text("company_name").notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    address: text("address"),
    countryOfOrigin: text("country_of_origin"),
    manufacturerName: text("manufacturer_name"),
    manufacturerPartNumber: text("manufacturer_part_number"),
    currency: text("currency").notNull().default("USD"),
    incoterms: text("incoterms"),
    transportMode: rfqTransportMode("transport_mode")
      .notNull()
      .default("any"),
    shippingCost: numeric("shipping_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    leadTimeDays: integer("lead_time_days").notNull().default(0),
    validityUntil: date("validity_until"),
    notes: text("notes"),
    // Original quote PDF the supplier uploaded (if any) — kept alongside the
    // structured fields so the buyer can verify.
    sourcePdfUrl: text("source_pdf_url"),
    sourcePdfName: text("source_pdf_name"),
    status: quoteStatus("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    rfqIdx: index("supplier_quotes_rfq_idx").on(t.rfqId),
    supplierIdx: index("supplier_quotes_supplier_idx").on(t.supplierId),
    statusIdx: index("supplier_quotes_status_idx").on(t.status),
  }),
);

export type SupplierQuote = typeof supplierQuotes.$inferSelect;

export const supplierQuoteLines = pgTable(
  "supplier_quote_lines",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: "cascade" }),
    rfqItemId: integer("rfq_item_id").references(() => rfqItems.id, {
      onDelete: "set null",
    }),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    moq: integer("moq").notNull().default(1),
    // Volume discounts — array of { qty, unitPrice } for tiered pricing.
    volumeDiscounts: jsonb("volume_discounts")
      .$type<Array<{ qty: number; unitPrice: number }>>()
      .notNull()
      .default([]),
    availableStock: integer("available_stock"),
    leadTimeDays: integer("lead_time_days"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    quoteIdx: index("supplier_quote_lines_quote_idx").on(t.quoteId),
    itemIdx: index("supplier_quote_lines_item_idx").on(t.rfqItemId),
  }),
);

export type SupplierQuoteLine = typeof supplierQuoteLines.$inferSelect;

export const supplierQuoteAttachments = pgTable(
  "supplier_quote_attachments",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: "cascade" }),
    // "datasheet" | "certification" | "brochure" | "image" | "other"
    kind: text("kind").notNull().default("other"),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    url: text("url").notNull(),
    blobPathname: text("blob_pathname"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    quoteIdx: index("supplier_quote_attachments_quote_idx").on(t.quoteId),
  }),
);

export type SupplierQuoteAttachment =
  typeof supplierQuoteAttachments.$inferSelect;

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    poNumber: text("po_number").notNull(),     // e.g. PO20260506
    rfqId: integer("rfq_id").references(() => rfqs.id, {
      onDelete: "set null",
    }),
    quoteId: integer("quote_id").references(() => supplierQuotes.id, {
      onDelete: "set null",
    }),
    supplierId: integer("supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    supplierName: text("supplier_name").notNull(),
    projectNum: text("project_num").notNull(),
    projectName: text("project_name"),
    propositionReference: text("proposition_reference"),
    currency: text("currency").notNull().default("USD"),
    incoterms: text("incoterms"),
    transportMode: rfqTransportMode("transport_mode")
      .notNull()
      .default("any"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    discountAmount: numeric("discount_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    taxAmount: numeric("tax_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    billingAddress: text("billing_address"),
    shippingAddress: text("shipping_address"),
    notes: text("notes"),
    // Optional buyer-uploaded PDF (e.g. external PO format / countersigned
    // copy). When present, the supplier sees this PDF; when absent, the
    // supplier sees the platform-generated print view. Migration 0027.
    sourcePdfUrl: text("source_pdf_url"),
    sourcePdfName: text("source_pdf_name"),
    sourcePdfPathname: text("source_pdf_pathname"),
    status: poStatus("status").notNull().default("draft"),
    sentAt: timestamp("sent_at"),
    acknowledgedAt: timestamp("acknowledged_at"),
    shippedAt: timestamp("shipped_at"),
    receivedAt: timestamp("received_at"),
    createdByClerkId: text("created_by_clerk_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    numberIdx: uniqueIndex("purchase_orders_number_idx").on(t.poNumber),
    projectIdx: index("purchase_orders_project_idx").on(t.projectNum),
    supplierIdx: index("purchase_orders_supplier_idx").on(t.supplierId),
    statusIdx: index("purchase_orders_status_idx").on(t.status),
  }),
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    ref: text("ref"),                          // L18SM
    description: text("description").notNull(),
    qty: integer("qty").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    totalPrice: numeric("total_price", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    // Migration 0032 — inherited from rfq_items at PO generation time so
    // the inventory link survives RFQ → quote → PO.
    lightbaseRef: text("lightbase_ref"),
    inventoryItemId: integer("inventory_item_id"),
    // Inherited from rfq_items.supplier_product_id when the RFQ line was
    // picked from the catalogue. Drives the PO-send-time catalogue +
    // inventory dispatch (feature B).
    supplierProductId: integer("supplier_product_id"),
    // Inherited from rfq_items.for_inventory_item_id — the assembly /
    // product this order is being placed FOR.
    forInventoryItemId: integer("for_inventory_item_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    poIdx: index("purchase_order_lines_po_idx").on(t.poId),
    lightbaseRefIdx: index("purchase_order_lines_lightbase_ref_idx").on(t.lightbaseRef),
    inventoryItemIdx: index("purchase_order_lines_inventory_item_idx").on(t.inventoryItemId),
    supplierProductIdx: index("purchase_order_lines_supplier_product_idx").on(t.supplierProductId),
    forInventoryItemIdx: index("purchase_order_lines_for_inventory_item_idx").on(t.forInventoryItemId),
  }),
);

export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;

export const erpNotifications = pgTable(
  "erp_notifications",
  {
    id: serial("id").primaryKey(),
    // null targetClerkId = team-wide (everyone sees it)
    targetClerkId: text("target_clerk_id"),
    kind: notificationKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Deep link to open when the notification is clicked.
    linkUrl: text("link_url"),
    // Optional FKs so the UI can render quick chips.
    rfqId: integer("rfq_id").references(() => rfqs.id, {
      onDelete: "set null",
    }),
    quoteId: integer("quote_id").references(() => supplierQuotes.id, {
      onDelete: "set null",
    }),
    poId: integer("po_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    targetIdx: index("erp_notifications_target_idx").on(t.targetClerkId),
    kindIdx: index("erp_notifications_kind_idx").on(t.kind),
    createdIdx: index("erp_notifications_created_idx").on(t.createdAt),
  }),
);

export type ErpNotification = typeof erpNotifications.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// PO PAYMENT + DELIVERY TRACKING (migration 0029) — gives suppliers and
// buyers a shared, structured view of "where is my money / my goods?"
// without having to phone or email each other for status updates.
// ─────────────────────────────────────────────────────────────────────────────

export const poPaymentMethods = pgTable(
  "po_payment_methods",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    bankName: text("bank_name"),
    accountHolder: text("account_holder"),
    iban: text("iban"),
    swiftBic: text("swift_bic"),
    accountNumber: text("account_number"),
    routingNumber: text("routing_number"),
    additionalMethods: jsonb("additional_methods")
      .$type<Array<{ kind: string; value: string }>>()
      .notNull()
      .default([]),
    acceptedCurrencies: text("accepted_currencies"),
    paymentTerms: text("payment_terms"),
    additionalNotes: text("additional_notes"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentPathname: text("attachment_pathname"),
    postedByClerkId: text("posted_by_clerk_id"),
    postedAt: timestamp("posted_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    poIdx: index("po_payment_methods_po_idx").on(t.poId),
  }),
);
export type PoPaymentMethod = typeof poPaymentMethods.$inferSelect;

export const poInvoices = pgTable(
  "po_invoices",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    issueDate: date("issue_date"),
    dueDate: date("due_date"),
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    filePathname: text("file_pathname"),
    status: poInvoiceStatus("status").notNull().default("issued"),
    receivedAt: timestamp("received_at"),
    approvedAt: timestamp("approved_at"),
    scheduledPaymentDate: date("scheduled_payment_date"),
    scheduledAt: timestamp("scheduled_at"),
    paidAt: timestamp("paid_at"),
    disputeReason: text("dispute_reason"),
    notes: text("notes"),
    postedByClerkId: text("posted_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    poIdx: index("po_invoices_po_idx").on(t.poId),
    statusIdx: index("po_invoices_status_idx").on(t.status),
  }),
);
export type PoInvoice = typeof poInvoices.$inferSelect;

export const poPayments = pgTable(
  "po_payments",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    invoiceId: integer("invoice_id").references(() => poInvoices.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    paidOn: date("paid_on").notNull(),
    method: text("method"),
    reference: text("reference"),
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    filePathname: text("file_pathname"),
    notes: text("notes"),
    postedByClerkId: text("posted_by_clerk_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    poIdx: index("po_payments_po_idx").on(t.poId),
    invoiceIdx: index("po_payments_invoice_idx").on(t.invoiceId),
  }),
);
export type PoPayment = typeof poPayments.$inferSelect;

export const poTimeline = pgTable(
  "po_timeline",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    // phase mirrors purchase_order_status but is stored as plain text so
    // free-form comments without a phase change are also possible.
    phase: text("phase"),
    title: text("title").notNull(),
    note: text("note"),
    trackingNumber: text("tracking_number"),
    carrier: text("carrier"),
    eta: date("eta"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentPathname: text("attachment_pathname"),
    postedByRole: text("posted_by_role").notNull().default("supplier"),
    postedByClerkId: text("posted_by_clerk_id"),
    postedAt: timestamp("posted_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    poIdx: index("po_timeline_po_idx").on(t.poId),
    postedIdx: index("po_timeline_posted_idx").on(t.postedAt),
  }),
);
export type PoTimelineEntry = typeof poTimeline.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER ↔ BUYER LIVE CHAT (migration 0031)
//
// Each supplier has one default "General" channel auto-created on first
// access, plus any custom channels the buyer adds (e.g. "Engineering",
// "Logistics"). Buyers (supplier-editors) and the supplier's portal users
// (Clerk-authed with is_supplier=true and email matching the supplier)
// can read + post in every channel for that supplier. Per-user read state
// powers the unread badge.
// ─────────────────────────────────────────────────────────────────────────────

export const chatChannels = pgTable(
  "chat_channels",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 'default' = auto-created General channel (cannot be archived).
    // 'custom'  = buyer-added.
    kind: text("kind").notNull().default("custom"),
    archived: boolean("archived").notNull().default(false),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("chat_channels_supplier_idx").on(t.supplierId),
    archivedIdx: index("chat_channels_archived_idx").on(t.archived),
  }),
);
export type ChatChannel = typeof chatChannels.$inferSelect;

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => chatChannels.id, { onDelete: "cascade" }),
    authorClerkId: text("author_clerk_id").notNull(),
    authorRole: text("author_role").notNull().default("buyer"),
    authorName: text("author_name"),
    body: text("body").notNull(),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentPathname: text("attachment_pathname"),
    editedAt: timestamp("edited_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    channelIdx: index("chat_messages_channel_idx").on(t.channelId),
    createdIdx: index("chat_messages_created_idx").on(t.createdAt),
  }),
);
export type ChatMessage = typeof chatMessages.$inferSelect;

export const chatReads = pgTable(
  "chat_reads",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => chatChannels.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
  },
  (t) => ({
    channelUserIdx: uniqueIndex("chat_reads_channel_user_idx").on(t.channelId, t.clerkUserId),
  }),
);
export type ChatRead = typeof chatReads.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY (migration 0032)
//
// Every RFQ / quote / PO line item links to an inventory_items row via
// `lightbase_ref` (the human-readable code, e.g. "LB-000123") + the FK
// `inventory_item_id`. One part can have many RFQs across multiple
// suppliers — the per-part detail page aggregates that history.
// ─────────────────────────────────────────────────────────────────────────────

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name"),
    description: text("description"),
    category: text("category"),
    unit: text("unit").notNull().default("ea"),
    defaultSupplierId: integer("default_supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    archived: boolean("archived").notNull().default(false),
    // Migration 0033 — IFC import + assembly hierarchy
    // 'part' (default) or 'assembly'. An assembly groups parts via the
    // parent_assembly_id FK on each child part.
    kind: text("kind").notNull().default("part"),
    parentAssemblyId: integer("parent_assembly_id"),
    // Physical properties pulled from the IFC file.
    weightG: numeric("weight_g", { precision: 14, scale: 4 }),
    surfaceAreaMm2: numeric("surface_area_mm2", { precision: 16, scale: 4 }),
    volumeMm3: numeric("volume_mm3", { precision: 16, scale: 4 }),
    material: text("material"),
    densityGCm3: numeric("density_g_cm3", { precision: 10, scale: 4 }),
    // Isometric render captured by the client-side IFC renderer.
    thumbnailUrl: text("thumbnail_url"),
    thumbnailPathname: text("thumbnail_pathname"),
    // Optional: keep the source IFC blob around for re-rendering / audit.
    ifcSourceUrl: text("ifc_source_url"),
    ifcSourceName: text("ifc_source_name"),
    // Lifecycle counters. Bumped by the RFQ / PO actions so the
    // inventory view shows "X on standby · Y confirmed" without an
    // expensive join on every list.
    pendingQty: integer("pending_qty").notNull().default(0),
    confirmedQty: integer("confirmed_qty").notNull().default(0),
    // Free-form product / line name (e.g. "Lightline-X") for grouping
    // in the inventory tab. Mirrored from nomenclature_parts.product
    // on save so the inventory listing can filter without joining.
    product: text("product"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    codeIdx: uniqueIndex("inventory_items_code_idx").on(t.code),
    categoryIdx: index("inventory_items_category_idx").on(t.category),
    archivedIdx: index("inventory_items_archived_idx").on(t.archived),
    kindIdx: index("inventory_items_kind_idx").on(t.kind),
    parentIdx: index("inventory_items_parent_idx").on(t.parentAssemblyId),
  }),
);
export type InventoryItem = typeof inventoryItems.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// NOMENCLATURE GENERATOR  (Design & Engineering → Nomenclature)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two generators live on the same page:
//
//   1. Hardware Generator. The user picks a hardware family (screw, nut,
//      washer, rivet, anchor, spacer, cable-gland, …) and either fills in
//      the template fields manually or pastes a product URL for the AI
//      to populate. The full code follows the family's nomenclature
//      standard (originally sourced from the OneDrive HARDWARES folder).
//      Format:  <classCode>-<uniqueId>-<nomenclature>
//
//   2. Part / Assembly ID Generator. A unique alphanumeric is allocated
//      and the user picks the kind (part, configuration, assembly).
//      Format:  <classCode>-<uniqueId>-WXXXX-HXXXX-LXXXX-<description>
//
// Every generated entry writes a row to nomenclature_parts AND an
// inventory_items row using the full code as the inventory code, so the
// rest of the ERP (RFQs, POs, BOMs) can reference them immediately.
// Deleting a nomenclature_part frees its unique_id for reuse + soft-
// archives the linked inventory item.

// One row per hardware family. Mirrors a NOMENCLATURE_*.txt file in the
// OneDrive HARDWARES folder; loaded on demand by the self-heal scanner.
// Users can also create new families (e.g. cable-gland) directly from
// the UI — the scanner writes a fresh .txt back to the folder so the
// CAD team's source of truth stays consistent with the app.
export const nomenclatureStandards = pgTable(
  "nomenclature_standards",
  {
    id: serial("id").primaryKey(),
    // URL-friendly identifier ("screw", "cable-gland"). Stable across
    // renames so URLs and FKs survive.
    slug: text("slug").notNull(),
    // Display name shown in the picker ("Screws", "Cable glands").
    name: text("name").notNull(),
    // Short uppercase prefix used in generated codes ("SCR", "CG").
    classCode: text("class_code").notNull(),
    // The template string from the .txt file (e.g.
    //   "TYPE_TETE-CONDUITE-DIA-PITCH-LONGUEUR-…").
    template: text("template").notNull(),
    // Full free-form spec text — type enumerations, materials, anchors,
    // examples. We don't try to parse the whole thing; we display it
    // raw to the user and feed it to the AI extractor.
    specText: text("spec_text").notNull(),
    // Where the .txt lives on disk (only used by the OneDrive scanner).
    sourcePath: text("source_path"),
    // True when the user created it from inside the app instead of
    // importing from the OneDrive folder.
    userCreated: boolean("user_created").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    slugIdx: uniqueIndex("nomenclature_standards_slug_idx").on(t.slug),
    classCodeIdx: index("nomenclature_standards_class_code_idx").on(
      t.classCode,
    ),
  }),
);
export type NomenclatureStandard =
  typeof nomenclatureStandards.$inferSelect;

// One row per generated ID. uniqueId is the alphanumeric chunk that
// shows up in every code (4 chars, A-Z + 0-9 — 1.6M unique values).
// kind === 'hardware' → standardId points at the family, fullCode is
// the assembled hardware nomenclature. kind === 'part' →
// width/height/length + description fill the WXXXX-HXXXX-LXXXX-desc
// pattern. Configurations is an array of free-form chip strings.
export const nomenclatureParts = pgTable(
  "nomenclature_parts",
  {
    id: serial("id").primaryKey(),
    uniqueId: text("unique_id").notNull(),
    kind: text("kind").notNull(), // 'hardware' | 'part'
    classCode: text("class_code").notNull(),
    fullCode: text("full_code").notNull(),
    standardId: integer("standard_id").references(
      () => nomenclatureStandards.id,
      { onDelete: "set null" },
    ),
    name: text("name"),
    description: text("description"),
    // For 'part' kind only. Stored as integers in millimetres so they
    // sort + filter cleanly. Optional — leave NULL to drop WXXXX etc.
    widthMm: integer("width_mm"),
    heightMm: integer("height_mm"),
    lengthMm: integer("length_mm"),
    // Set when the part is circular — replaces WXXXX-HXXXX in the code
    // with a single DXXXX segment (D = diameter).
    diameterMm: integer("diameter_mm"),
    // Free-form product / line name (e.g. "Lightline-X"). Used by the
    // Database tab's product-view filter so the team can see every
    // code that belongs to a given product. Optional.
    product: text("product"),
    // 'P' for part, 'A' for assembly. Only populated for kind='hardware'
    // — the part/assembly generator uses inventory_items.kind for the
    // same distinction and doesn't embed P/A in the code itself.
    partOrAssembly: text("part_or_assembly"),
    // Configurations are name+description pairs ({ name: "ENC",
    // description: "Enclosed variant" }). Stored JSONB so the catalogue
    // can extend later. Pre-V78 rows that stored bare strings are
    // normalised on read by the actions layer.
    configurations: jsonb("configurations")
      .$type<Array<{ name: string; description: string | null }>>()
      .default([]),
    // Link to the resolved inventory row. Null until the inventory
    // upsert runs; populated by the same server action that inserts
    // the nomenclature_parts row.
    inventoryItemId: integer("inventory_item_id").references(
      () => inventoryItems.id,
      { onDelete: "set null" },
    ),
    // Linkage to a parent assembly within nomenclature_parts itself, so
    // a configuration row can point at the assembly it belongs to.
    parentPartId: integer("parent_part_id"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueIdIdx: uniqueIndex("nomenclature_parts_unique_id_idx").on(
      t.uniqueId,
    ),
    fullCodeIdx: uniqueIndex("nomenclature_parts_full_code_idx").on(
      t.fullCode,
    ),
    kindIdx: index("nomenclature_parts_kind_idx").on(t.kind),
    standardIdx: index("nomenclature_parts_standard_idx").on(t.standardId),
    inventoryIdx: index("nomenclature_parts_inventory_idx").on(
      t.inventoryItemId,
    ),
    parentIdx: index("nomenclature_parts_parent_idx").on(t.parentPartId),
  }),
);
export type NomenclaturePart = typeof nomenclatureParts.$inferSelect;

// Assembly BOM — many-to-many edge table linking an assembly to its
// children. Both parent and child are inventory_items rows. A part can
// be a leaf (no row in this table as parent); an assembly that's itself
// nested under another assembly shows up twice (once as a parent_id,
// once as a child_id). Quantity is the count of this child required to
// build one of the parent.
export const assemblyBom = pgTable(
  "assembly_bom",
  {
    id: serial("id").primaryKey(),
    // Parent — must have inventory_items.kind = 'assembly'. Enforced at
    // the action layer, not in SQL.
    parentAssemblyId: integer("parent_assembly_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    // Child — can be a part OR a sub-assembly.
    childItemId: integer("child_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    // Free-form ordering hint for the tree view (smaller = higher).
    position: integer("position").notNull().default(0),
    // Optional free-text — e.g. "M5 socket head, north wall".
    notes: text("notes"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    parentIdx: index("assembly_bom_parent_idx").on(t.parentAssemblyId),
    childIdx: index("assembly_bom_child_idx").on(t.childItemId),
    // One row per (parent, child) — adding the same child twice updates
    // the quantity rather than duplicating the edge.
    uniqEdgeIdx: uniqueIndex("assembly_bom_unique_edge_idx").on(
      t.parentAssemblyId,
      t.childItemId,
    ),
  }),
);
export type AssemblyBomRow = typeof assemblyBom.$inferSelect;

// Attachments on inventory_items — STEP files, drawings (PDF / DWG /
// DXF), images, datasheets, or external links. Mirrors the
// supplier_product_attachments pattern (label, URL, blob pathname,
// content type, size) so the InventoryDrawer in /design-engineering
// can render the same widget shape as the supplier catalogue.
export const inventoryAttachments = pgTable(
  "inventory_attachments",
  {
    id: serial("id").primaryKey(),
    inventoryItemId: integer("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    // 'cad' (STEP / IGES / Parasolid / native CAD), 'drawing' (PDF
    // technical drawing / DWG / DXF), 'image' (photo / render), 'doc'
    // (datasheet / cert / receipt), 'link' (no blob, just a URL).
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    // URL — for blob uploads this is the public blob URL; for kind='link'
    // it's the external URL the user pasted.
    url: text("url").notNull(),
    // Blob pathname (e.g. design-engineering/inventory/123/file.step).
    // NULL for kind='link'.
    pathname: text("pathname"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    notes: text("notes"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    inventoryIdx: index("inventory_attachments_inventory_idx").on(
      t.inventoryItemId,
    ),
    kindIdx: index("inventory_attachments_kind_idx").on(t.kind),
  }),
);
export type InventoryAttachmentRow =
  typeof inventoryAttachments.$inferSelect;
