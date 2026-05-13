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

export const userProfiles = pgTable(
  "user_profiles",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("pending"),
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

export const supplierStatus = pgEnum("supplier_status", ["Active", "Historical"]);

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: index("suppliers_name_idx").on(t.name),
    categoryIdx: index("suppliers_category_idx").on(t.category),
    originIdx: index("suppliers_origin_idx").on(t.origin),
    competitorIdx: uniqueIndex("suppliers_competitor_idx").on(t.competitorId),
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
}));

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
