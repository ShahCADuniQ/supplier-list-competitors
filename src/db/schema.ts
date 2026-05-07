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
