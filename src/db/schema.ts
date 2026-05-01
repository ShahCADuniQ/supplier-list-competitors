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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: index("suppliers_name_idx").on(t.name),
    categoryIdx: index("suppliers_category_idx").on(t.category),
    originIdx: index("suppliers_origin_idx").on(t.origin),
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
  }),
);

export const competitorsRelations = relations(competitors, ({ one, many }) => ({
  collection: one(competitorCollections, {
    fields: [competitors.collectionId],
    references: [competitorCollections.id],
  }),
  attachments: many(competitorAttachments),
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
