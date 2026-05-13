"use server";

// CRM server actions — CRUD for all five tables + cross-account analytics.
// Auth model: a record is owned by the Clerk user who created it (via the
// crm_accounts.ownerUserId column, which child rows inherit transitively
// through their FK to accounts). Admins see everything; everyone else
// sees only their own.
//
// Migration safety: ensureCrmSchema() self-heals migration 0020 on first
// call. Same pattern as ensureCompetitorProductsSchema / ensureDesignProjectsSchema —
// see feedback_migration_forward_compat.md memory.

import { revalidatePath } from "next/cache";
import { and, count, desc, eq, ilike, sql, sum, gte, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  crmAccounts,
  crmActivities,
  crmContacts,
  crmOpportunities,
  crmTickets,
  municipalityContacts,
  municipalityListEntries,
  type CrmAccount,
  type CrmActivity,
  type CrmContact,
  type CrmOpportunity,
  type CrmTicket,
} from "@/db/schema";
import { getOrCreateProfile, isAdmin } from "@/lib/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEALING SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

let _schemaEnsured: Promise<boolean> | null = null;

export async function ensureCrmSchema(): Promise<boolean> {
  if (_schemaEnsured) return _schemaEnsured;
  _schemaEnsured = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS __applied_migrations (
          filename text PRIMARY KEY,
          applied_at timestamp DEFAULT now() NOT NULL
        )
      `);
      // Enums first.
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "crm_account_tier" AS ENUM ('lead','prospect','customer','partner','churned');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "crm_opportunity_stage" AS ENUM ('lead','qualified','demo','proposal','negotiation','won','lost','on-hold');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "crm_activity_type" AS ENUM ('call','email','meeting','note','task');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "crm_ticket_status" AS ENUM ('open','in-progress','resolved','closed');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "crm_ticket_priority" AS ENUM ('low','medium','high','urgent');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);

      // Tables.
      await db.execute(sql`
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
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_accounts_owner_idx" ON "crm_accounts" ("owner_user_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_accounts_tier_idx" ON "crm_accounts" ("tier")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_accounts_name_idx" ON "crm_accounts" ("name")`,
      );

      await db.execute(sql`
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
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_contacts_account_idx" ON "crm_contacts" ("account_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_contacts_email_idx" ON "crm_contacts" ("email")`,
      );

      await db.execute(sql`
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
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_opportunities_account_idx" ON "crm_opportunities" ("account_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_opportunities_stage_idx" ON "crm_opportunities" ("stage")`,
      );

      await db.execute(sql`
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
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_activities_account_idx" ON "crm_activities" ("account_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_activities_occurred_idx" ON "crm_activities" ("occurred_at")`,
      );

      await db.execute(sql`
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
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_tickets_account_idx" ON "crm_tickets" ("account_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "crm_tickets_status_idx" ON "crm_tickets" ("status")`,
      );

      await db.execute(sql`
        INSERT INTO __applied_migrations (filename)
        VALUES ('0020_crm.sql')
        ON CONFLICT DO NOTHING
      `);
      return true;
    } catch (e) {
      console.warn(
        "[crm] auto-ensure schema failed — run `npm run db:apply` to apply migration 0020.",
        e,
      );
      return false;
    }
  })();
  return _schemaEnsured;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function requireUser() {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  await ensureCrmSchema();
  return { profile, isAdminUser: isAdmin(profile) };
}

async function requireAccount(accountId: number): Promise<{
  account: CrmAccount;
  ownerUserId: string;
}> {
  const { profile, isAdminUser } = await requireUser();
  const [account] = await db
    .select()
    .from(crmAccounts)
    .where(eq(crmAccounts.id, accountId))
    .limit(1);
  if (!account) throw new Error("Account not found");
  if (account.ownerUserId !== profile.clerkUserId && !isAdminUser) {
    throw new Error("Forbidden: not your account");
  }
  return { account, ownerUserId: profile.clerkUserId };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────

export async function listMyAccounts(): Promise<CrmAccount[]> {
  const { profile, isAdminUser } = await requireUser();
  const rows = await db
    .select()
    .from(crmAccounts)
    .where(isAdminUser ? sql`true` : eq(crmAccounts.ownerUserId, profile.clerkUserId))
    .orderBy(desc(crmAccounts.updatedAt));
  return rows;
}

export async function getAccountFull(accountId: number): Promise<{
  account: CrmAccount;
  contacts: CrmContact[];
  opportunities: CrmOpportunity[];
  activities: CrmActivity[];
  tickets: CrmTicket[];
} | null> {
  try {
    const { account } = await requireAccount(accountId);
    const [contacts, opportunities, activities, tickets] = await Promise.all([
      db
        .select()
        .from(crmContacts)
        .where(eq(crmContacts.accountId, accountId))
        .orderBy(desc(crmContacts.isPrimary), desc(crmContacts.createdAt)),
      db
        .select()
        .from(crmOpportunities)
        .where(eq(crmOpportunities.accountId, accountId))
        .orderBy(desc(crmOpportunities.updatedAt)),
      db
        .select()
        .from(crmActivities)
        .where(eq(crmActivities.accountId, accountId))
        .orderBy(desc(crmActivities.occurredAt))
        .limit(50),
      db
        .select()
        .from(crmTickets)
        .where(eq(crmTickets.accountId, accountId))
        .orderBy(desc(crmTickets.updatedAt)),
    ]);
    return { account, contacts, opportunities, activities, tickets };
  } catch {
    return null;
  }
}

export async function createAccount(input: {
  name: string;
  website?: string;
  industry?: string;
  tier?: CrmAccount["tier"];
  country?: string;
  notes?: string;
}): Promise<{ id: number }> {
  const { profile } = await requireUser();
  const name = input.name.trim();
  if (!name) throw new Error("Account name is required");
  const [row] = await db
    .insert(crmAccounts)
    .values({
      ownerUserId: profile.clerkUserId,
      name,
      website: input.website?.trim() || null,
      industry: input.industry?.trim() || null,
      tier: input.tier ?? "lead",
      country: input.country?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .returning();
  revalidatePath("/crm");
  revalidatePath("/crm/accounts");
  return { id: row.id };
}

export async function updateAccount(
  id: number,
  patch: Partial<{
    name: string;
    website: string;
    industry: string;
    tier: CrmAccount["tier"];
    country: string;
    employeeCount: number | null;
    annualRevenueUsd: string | null;
    notes: string;
    healthScore: number;
  }>,
): Promise<void> {
  await requireAccount(id);
  const set: Partial<typeof crmAccounts.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.website !== undefined) set.website = patch.website.trim() || null;
  if (patch.industry !== undefined) set.industry = patch.industry.trim() || null;
  if (patch.tier !== undefined) set.tier = patch.tier;
  if (patch.country !== undefined) set.country = patch.country.trim() || null;
  if (patch.employeeCount !== undefined) set.employeeCount = patch.employeeCount;
  if (patch.annualRevenueUsd !== undefined)
    set.annualRevenueUsd = patch.annualRevenueUsd;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.healthScore !== undefined) {
    set.healthScore = Math.max(0, Math.min(100, patch.healthScore));
  }
  await db.update(crmAccounts).set(set).where(eq(crmAccounts.id, id));
  revalidatePath(`/crm/accounts/${id}`);
  revalidatePath("/crm/accounts");
}

export async function deleteAccount(id: number): Promise<void> {
  await requireAccount(id);
  await db.delete(crmAccounts).where(eq(crmAccounts.id, id));
  revalidatePath("/crm");
  revalidatePath("/crm/accounts");
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────────────────────

export async function createContact(input: {
  accountId: number;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  role?: string;
  isPrimary?: boolean;
}): Promise<{ id: number }> {
  await requireAccount(input.accountId);
  if (!input.firstName.trim()) throw new Error("First name is required");
  const [row] = await db
    .insert(crmContacts)
    .values({
      accountId: input.accountId,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() ?? "",
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      role: input.role?.trim() || null,
      isPrimary: input.isPrimary ?? false,
    })
    .returning();
  revalidatePath(`/crm/accounts/${input.accountId}`);
  return { id: row.id };
}

export async function updateContact(
  id: number,
  patch: Partial<{
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    role: string;
    isPrimary: boolean;
    notes: string;
  }>,
): Promise<void> {
  const [c] = await db
    .select()
    .from(crmContacts)
    .where(eq(crmContacts.id, id))
    .limit(1);
  if (!c) throw new Error("Contact not found");
  await requireAccount(c.accountId);
  const set: Partial<typeof crmContacts.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.firstName !== undefined) set.firstName = patch.firstName.trim();
  if (patch.lastName !== undefined) set.lastName = patch.lastName.trim();
  if (patch.email !== undefined) set.email = patch.email.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone.trim() || null;
  if (patch.role !== undefined) set.role = patch.role.trim() || null;
  if (patch.isPrimary !== undefined) set.isPrimary = patch.isPrimary;
  if (patch.notes !== undefined) set.notes = patch.notes;
  await db.update(crmContacts).set(set).where(eq(crmContacts.id, id));
  revalidatePath(`/crm/accounts/${c.accountId}`);
}

export async function deleteContact(id: number): Promise<void> {
  const [c] = await db
    .select()
    .from(crmContacts)
    .where(eq(crmContacts.id, id))
    .limit(1);
  if (!c) return;
  await requireAccount(c.accountId);
  await db.delete(crmContacts).where(eq(crmContacts.id, id));
  revalidatePath(`/crm/accounts/${c.accountId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OPPORTUNITIES (PIPELINE)
// ─────────────────────────────────────────────────────────────────────────────

export async function createOpportunity(input: {
  accountId: number;
  title: string;
  stage?: CrmOpportunity["stage"];
  amountUsd?: number;
  probability?: number;
  expectedCloseDate?: string | null;
  nextStep?: string;
}): Promise<{ id: number }> {
  await requireAccount(input.accountId);
  if (!input.title.trim()) throw new Error("Opportunity title is required");
  const [row] = await db
    .insert(crmOpportunities)
    .values({
      accountId: input.accountId,
      title: input.title.trim(),
      stage: input.stage ?? "lead",
      amountUsd: String(input.amountUsd ?? 0),
      probability: Math.max(0, Math.min(100, input.probability ?? 20)),
      expectedCloseDate: input.expectedCloseDate ?? null,
      nextStep: input.nextStep?.trim() || null,
    })
    .returning();
  revalidatePath(`/crm/accounts/${input.accountId}`);
  revalidatePath("/crm/pipeline");
  return { id: row.id };
}

export async function updateOpportunity(
  id: number,
  patch: Partial<{
    title: string;
    stage: CrmOpportunity["stage"];
    amountUsd: number | string;
    probability: number;
    expectedCloseDate: string | null;
    nextStep: string;
    notes: string;
    closedReason: string;
  }>,
): Promise<void> {
  const [o] = await db
    .select()
    .from(crmOpportunities)
    .where(eq(crmOpportunities.id, id))
    .limit(1);
  if (!o) throw new Error("Opportunity not found");
  await requireAccount(o.accountId);
  const set: Partial<typeof crmOpportunities.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.stage !== undefined) {
    set.stage = patch.stage;
    // Stamp closed_at when transitioning into terminal stages.
    if (
      (patch.stage === "won" || patch.stage === "lost") &&
      o.stage !== patch.stage
    ) {
      set.closedAt = new Date();
      if (patch.stage === "won") set.probability = 100;
      if (patch.stage === "lost") set.probability = 0;
    }
    if (
      o.closedAt &&
      patch.stage !== "won" &&
      patch.stage !== "lost"
    ) {
      set.closedAt = null;
    }
  }
  if (patch.amountUsd !== undefined) set.amountUsd = String(patch.amountUsd);
  if (patch.probability !== undefined) {
    set.probability = Math.max(0, Math.min(100, patch.probability));
  }
  if (patch.expectedCloseDate !== undefined)
    set.expectedCloseDate = patch.expectedCloseDate;
  if (patch.nextStep !== undefined) set.nextStep = patch.nextStep;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.closedReason !== undefined) set.closedReason = patch.closedReason;
  await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, id));
  revalidatePath(`/crm/accounts/${o.accountId}`);
  revalidatePath("/crm/pipeline");
  revalidatePath("/crm/analytics");
}

export async function deleteOpportunity(id: number): Promise<void> {
  const [o] = await db
    .select()
    .from(crmOpportunities)
    .where(eq(crmOpportunities.id, id))
    .limit(1);
  if (!o) return;
  await requireAccount(o.accountId);
  await db.delete(crmOpportunities).where(eq(crmOpportunities.id, id));
  revalidatePath(`/crm/accounts/${o.accountId}`);
  revalidatePath("/crm/pipeline");
}

export async function listPipelineOpportunities(): Promise<
  Array<CrmOpportunity & { accountName: string }>
> {
  const { profile, isAdminUser } = await requireUser();
  const rows = await db
    .select({
      opp: crmOpportunities,
      accountName: crmAccounts.name,
    })
    .from(crmOpportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmOpportunities.accountId))
    .where(
      isAdminUser
        ? sql`true`
        : eq(crmAccounts.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(crmOpportunities.updatedAt));
  return rows.map((r) => ({ ...r.opp, accountName: r.accountName }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITIES
// ─────────────────────────────────────────────────────────────────────────────

export async function logActivity(input: {
  accountId: number;
  contactId?: number | null;
  opportunityId?: number | null;
  type: CrmActivity["type"];
  subject: string;
  body?: string;
  occurredAt?: Date | string;
}): Promise<{ id: number }> {
  await requireAccount(input.accountId);
  if (!input.subject.trim()) throw new Error("Activity subject is required");
  const [row] = await db
    .insert(crmActivities)
    .values({
      accountId: input.accountId,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      type: input.type,
      subject: input.subject.trim(),
      body: input.body?.trim() || null,
      occurredAt:
        input.occurredAt instanceof Date
          ? input.occurredAt
          : input.occurredAt
            ? new Date(input.occurredAt)
            : new Date(),
    })
    .returning();
  revalidatePath(`/crm/accounts/${input.accountId}`);
  revalidatePath("/crm");
  return { id: row.id };
}

export async function deleteActivity(id: number): Promise<void> {
  const [a] = await db
    .select()
    .from(crmActivities)
    .where(eq(crmActivities.id, id))
    .limit(1);
  if (!a) return;
  await requireAccount(a.accountId);
  await db.delete(crmActivities).where(eq(crmActivities.id, id));
  revalidatePath(`/crm/accounts/${a.accountId}`);
}

export async function listRecentActivities(limit = 25): Promise<
  Array<CrmActivity & { accountName: string }>
> {
  const { profile, isAdminUser } = await requireUser();
  const rows = await db
    .select({ act: crmActivities, accountName: crmAccounts.name })
    .from(crmActivities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmActivities.accountId))
    .where(
      isAdminUser ? sql`true` : eq(crmAccounts.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(crmActivities.occurredAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.act, accountName: r.accountName }));
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKETS
// ─────────────────────────────────────────────────────────────────────────────

export async function createTicket(input: {
  accountId: number;
  contactId?: number | null;
  subject: string;
  body?: string;
  priority?: CrmTicket["priority"];
}): Promise<{ id: number }> {
  await requireAccount(input.accountId);
  if (!input.subject.trim()) throw new Error("Ticket subject is required");
  const [row] = await db
    .insert(crmTickets)
    .values({
      accountId: input.accountId,
      contactId: input.contactId ?? null,
      subject: input.subject.trim(),
      body: input.body?.trim() ?? "",
      priority: input.priority ?? "medium",
    })
    .returning();
  revalidatePath(`/crm/accounts/${input.accountId}`);
  revalidatePath("/crm/tickets");
  return { id: row.id };
}

export async function updateTicket(
  id: number,
  patch: Partial<{
    subject: string;
    body: string;
    status: CrmTicket["status"];
    priority: CrmTicket["priority"];
  }>,
): Promise<void> {
  const [t] = await db
    .select()
    .from(crmTickets)
    .where(eq(crmTickets.id, id))
    .limit(1);
  if (!t) throw new Error("Ticket not found");
  await requireAccount(t.accountId);
  const set: Partial<typeof crmTickets.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.subject !== undefined) set.subject = patch.subject.trim();
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.status !== undefined) {
    set.status = patch.status;
    if (
      (patch.status === "resolved" || patch.status === "closed") &&
      !t.resolvedAt
    ) {
      set.resolvedAt = new Date();
    }
    if (
      patch.status === "open" ||
      patch.status === "in-progress"
    ) {
      set.resolvedAt = null;
    }
  }
  await db.update(crmTickets).set(set).where(eq(crmTickets.id, id));
  revalidatePath(`/crm/accounts/${t.accountId}`);
  revalidatePath("/crm/tickets");
}

export async function deleteTicket(id: number): Promise<void> {
  const [t] = await db
    .select()
    .from(crmTickets)
    .where(eq(crmTickets.id, id))
    .limit(1);
  if (!t) return;
  await requireAccount(t.accountId);
  await db.delete(crmTickets).where(eq(crmTickets.id, id));
  revalidatePath(`/crm/accounts/${t.accountId}`);
  revalidatePath("/crm/tickets");
}

export async function listAllTickets(): Promise<
  Array<CrmTicket & { accountName: string }>
> {
  const { profile, isAdminUser } = await requireUser();
  const rows = await db
    .select({ t: crmTickets, accountName: crmAccounts.name })
    .from(crmTickets)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmTickets.accountId))
    .where(
      isAdminUser ? sql`true` : eq(crmAccounts.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(crmTickets.updatedAt));
  return rows.map((r) => ({ ...r.t, accountName: r.accountName }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-ACCOUNT ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

export type CrmDashboard = {
  totalAccounts: number;
  totalContacts: number;
  openOpportunities: number;
  totalPipelineValueUsd: number;
  weightedPipelineUsd: number;
  closedWonUsd: number;
  closedLostUsd: number;
  openTickets: number;
  urgentTickets: number;
  byStage: Array<{
    stage: CrmOpportunity["stage"];
    count: number;
    totalUsd: number;
  }>;
  byTier: Array<{ tier: CrmAccount["tier"]; count: number }>;
};

export async function getCrmDashboard(): Promise<CrmDashboard> {
  const { profile, isAdminUser } = await requireUser();
  const ownerScope = isAdminUser
    ? sql`true`
    : eq(crmAccounts.ownerUserId, profile.clerkUserId);

  // Account totals
  const [accountTotals] = await db
    .select({
      total: count(crmAccounts.id),
    })
    .from(crmAccounts)
    .where(ownerScope);

  // Contact totals (join through accounts for scope)
  const [contactTotals] = await db
    .select({ total: count(crmContacts.id) })
    .from(crmContacts)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmContacts.accountId))
    .where(ownerScope);

  // Opportunities + sums per stage
  const oppRows = await db
    .select({
      stage: crmOpportunities.stage,
      count: count(crmOpportunities.id),
      totalUsd: sum(crmOpportunities.amountUsd),
    })
    .from(crmOpportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmOpportunities.accountId))
    .where(ownerScope)
    .groupBy(crmOpportunities.stage);

  // Weighted pipeline (only open opps): sum(amount * probability/100)
  const weightedRows = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${crmOpportunities.amountUsd}::numeric * ${crmOpportunities.probability} / 100.0), 0)`,
    })
    .from(crmOpportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmOpportunities.accountId))
    .where(
      and(
        ownerScope,
        ne(crmOpportunities.stage, "won"),
        ne(crmOpportunities.stage, "lost"),
      ),
    );

  // Tier breakdown
  const tierRows = await db
    .select({ tier: crmAccounts.tier, count: count(crmAccounts.id) })
    .from(crmAccounts)
    .where(ownerScope)
    .groupBy(crmAccounts.tier);

  // Tickets
  const ticketRows = await db
    .select({ status: crmTickets.status, count: count(crmTickets.id) })
    .from(crmTickets)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmTickets.accountId))
    .where(ownerScope)
    .groupBy(crmTickets.status);

  const [urgentTicketsRow] = await db
    .select({ count: count(crmTickets.id) })
    .from(crmTickets)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmTickets.accountId))
    .where(
      and(
        ownerScope,
        eq(crmTickets.priority, "urgent"),
        ne(crmTickets.status, "closed"),
        ne(crmTickets.status, "resolved"),
      ),
    );

  const byStage = oppRows.map((r) => ({
    stage: r.stage,
    count: Number(r.count),
    totalUsd: Number(r.totalUsd ?? 0),
  }));

  const stageMap = new Map(byStage.map((s) => [s.stage, s]));
  const openStages: CrmOpportunity["stage"][] = [
    "lead",
    "qualified",
    "demo",
    "proposal",
    "negotiation",
    "on-hold",
  ];
  const openOpportunities = openStages.reduce(
    (s, k) => s + (stageMap.get(k)?.count ?? 0),
    0,
  );
  const totalPipelineValueUsd = openStages.reduce(
    (s, k) => s + (stageMap.get(k)?.totalUsd ?? 0),
    0,
  );

  const closedWonUsd = stageMap.get("won")?.totalUsd ?? 0;
  const closedLostUsd = stageMap.get("lost")?.totalUsd ?? 0;

  const statusMap = new Map(
    ticketRows.map((r) => [r.status, Number(r.count)]),
  );
  const openTickets =
    (statusMap.get("open") ?? 0) + (statusMap.get("in-progress") ?? 0);

  return {
    totalAccounts: Number(accountTotals?.total ?? 0),
    totalContacts: Number(contactTotals?.total ?? 0),
    openOpportunities,
    totalPipelineValueUsd,
    weightedPipelineUsd: Number(weightedRows[0]?.sum ?? 0),
    closedWonUsd,
    closedLostUsd,
    openTickets,
    urgentTickets: Number(urgentTicketsRow?.count ?? 0),
    byStage,
    byTier: tierRows.map((r) => ({ tier: r.tier, count: Number(r.count) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS / FORECASTING
// ─────────────────────────────────────────────────────────────────────────────

export type CrmAnalytics = {
  // Funnel: count + total $ at each stage (used to render the stage funnel)
  funnel: Array<{
    stage: CrmOpportunity["stage"];
    count: number;
    totalUsd: number;
    weightedUsd: number;
  }>;
  // Win rate (won / (won + lost)) by count and by $ value
  winRateByCount: number; // 0..1
  winRateByValue: number; // 0..1
  // Forecast buckets — open opps grouped by expected close date window
  forecast: {
    next30: { count: number; totalUsd: number; weightedUsd: number };
    next60: { count: number; totalUsd: number; weightedUsd: number };
    next90: { count: number; totalUsd: number; weightedUsd: number };
    later: { count: number; totalUsd: number; weightedUsd: number };
    noDate: { count: number; totalUsd: number; weightedUsd: number };
  };
  // Top open opportunities sorted by weighted dollar value
  topOpen: Array<{
    id: number;
    title: string;
    accountId: number;
    accountName: string;
    stage: CrmOpportunity["stage"];
    amountUsd: number;
    probability: number;
    weightedUsd: number;
    expectedCloseDate: string | null;
  }>;
  // Account health distribution (0-100 bucketed)
  healthBuckets: {
    healthy: number; // 70+
    watch: number; // 40-69
    atRisk: number; // <40
  };
  // Activity volume by type over the last 30 days
  activityVolume: Array<{
    type: CrmActivity["type"];
    count: number;
  }>;
  totalActivities30d: number;
};

export async function getCrmAnalytics(): Promise<CrmAnalytics> {
  const { profile, isAdminUser } = await requireUser();
  const ownerScope = isAdminUser
    ? sql`true`
    : eq(crmAccounts.ownerUserId, profile.clerkUserId);

  // Funnel — count, $, and weighted $ per stage
  const stageRows = await db
    .select({
      stage: crmOpportunities.stage,
      count: count(crmOpportunities.id),
      totalUsd: sum(crmOpportunities.amountUsd),
      weightedUsd: sql<string>`COALESCE(SUM(${crmOpportunities.amountUsd}::numeric * ${crmOpportunities.probability} / 100.0), 0)`,
    })
    .from(crmOpportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmOpportunities.accountId))
    .where(ownerScope)
    .groupBy(crmOpportunities.stage);

  const funnel: CrmAnalytics["funnel"] = stageRows.map((r) => ({
    stage: r.stage,
    count: Number(r.count),
    totalUsd: Number(r.totalUsd ?? 0),
    weightedUsd: Number(r.weightedUsd ?? 0),
  }));

  const wonRow = funnel.find((f) => f.stage === "won");
  const lostRow = funnel.find((f) => f.stage === "lost");
  const wonCount = wonRow?.count ?? 0;
  const lostCount = lostRow?.count ?? 0;
  const wonUsd = wonRow?.totalUsd ?? 0;
  const lostUsd = lostRow?.totalUsd ?? 0;
  const winRateByCount =
    wonCount + lostCount === 0 ? 0 : wonCount / (wonCount + lostCount);
  const winRateByValue =
    wonUsd + lostUsd === 0 ? 0 : wonUsd / (wonUsd + lostUsd);

  // Forecast — pull every open opportunity once and bucket in JS.
  const openOpps = await db
    .select({
      id: crmOpportunities.id,
      title: crmOpportunities.title,
      accountId: crmOpportunities.accountId,
      accountName: crmAccounts.name,
      stage: crmOpportunities.stage,
      amountUsd: crmOpportunities.amountUsd,
      probability: crmOpportunities.probability,
      expectedCloseDate: crmOpportunities.expectedCloseDate,
    })
    .from(crmOpportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmOpportunities.accountId))
    .where(
      and(
        ownerScope,
        ne(crmOpportunities.stage, "won"),
        ne(crmOpportunities.stage, "lost"),
      ),
    );

  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const bucketShape = () => ({ count: 0, totalUsd: 0, weightedUsd: 0 });
  const forecast = {
    next30: bucketShape(),
    next60: bucketShape(),
    next90: bucketShape(),
    later: bucketShape(),
    noDate: bucketShape(),
  };

  const topOpen: CrmAnalytics["topOpen"] = openOpps
    .map((o) => {
      const amount = Number(o.amountUsd ?? 0);
      const weighted = (amount * o.probability) / 100;
      const bucket = (() => {
        if (!o.expectedCloseDate) return "noDate" as const;
        const d = new Date(o.expectedCloseDate);
        const diff = (d.getTime() - now.getTime()) / day;
        if (diff <= 30) return "next30" as const;
        if (diff <= 60) return "next60" as const;
        if (diff <= 90) return "next90" as const;
        return "later" as const;
      })();
      forecast[bucket].count += 1;
      forecast[bucket].totalUsd += amount;
      forecast[bucket].weightedUsd += weighted;
      return {
        id: o.id,
        title: o.title,
        accountId: o.accountId,
        accountName: o.accountName,
        stage: o.stage,
        amountUsd: amount,
        probability: o.probability,
        weightedUsd: weighted,
        expectedCloseDate: o.expectedCloseDate ?? null,
      };
    })
    .sort((a, b) => b.weightedUsd - a.weightedUsd)
    .slice(0, 8);

  // Account health distribution
  const healthRows = await db
    .select({
      healthy: sql<number>`COUNT(*) FILTER (WHERE ${crmAccounts.healthScore} >= 70)`,
      watch: sql<number>`COUNT(*) FILTER (WHERE ${crmAccounts.healthScore} >= 40 AND ${crmAccounts.healthScore} < 70)`,
      atRisk: sql<number>`COUNT(*) FILTER (WHERE ${crmAccounts.healthScore} < 40)`,
    })
    .from(crmAccounts)
    .where(ownerScope);
  const healthBuckets = {
    healthy: Number(healthRows[0]?.healthy ?? 0),
    watch: Number(healthRows[0]?.watch ?? 0),
    atRisk: Number(healthRows[0]?.atRisk ?? 0),
  };

  // Activity volume by type — last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * day);
  const activityRows = await db
    .select({
      type: crmActivities.type,
      count: count(crmActivities.id),
    })
    .from(crmActivities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, crmActivities.accountId))
    .where(and(ownerScope, gte(crmActivities.occurredAt, thirtyDaysAgo)))
    .groupBy(crmActivities.type);
  const activityVolume = activityRows.map((r) => ({
    type: r.type,
    count: Number(r.count),
  }));
  const totalActivities30d = activityVolume.reduce(
    (s, r) => s + r.count,
    0,
  );

  return {
    funnel,
    winRateByCount,
    winRateByValue,
    forecast,
    topOpen,
    healthBuckets,
    activityVolume,
    totalActivities30d,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MUNICIPAL CONTACT → CRM INTEGRATION
//
// Municipal Contacts (lead generator + curated list) live under /crm because
// they are lead-generation sources. The actions below turn a municipal row
// into a real CRM record: the municipality becomes a `crm_accounts` row (one
// per municipality, deduped by case-insensitive name + country), and any
// person fields on the source row become `crm_contacts` children.
// ─────────────────────────────────────────────────────────────────────────────

async function findOrCreateMunicipalAccount(input: {
  ownerUserId: string;
  name: string;
  website?: string | null;
  country?: string | null;
  notes?: string | null;
}): Promise<{ accountId: number; created: boolean }> {
  const cleanName = input.name.trim();
  if (!cleanName) throw new Error("Municipality name is required");
  // Match scoped to the owner so two users importing the same municipality
  // each get their own account record. Admins still only auto-merge into
  // their own books — they can re-assign by editing afterwards.
  const existing = await db
    .select({ id: crmAccounts.id })
    .from(crmAccounts)
    .where(
      and(
        eq(crmAccounts.ownerUserId, input.ownerUserId),
        ilike(crmAccounts.name, cleanName),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { accountId: existing[0].id, created: false };
  }
  const [row] = await db
    .insert(crmAccounts)
    .values({
      ownerUserId: input.ownerUserId,
      name: cleanName,
      website: input.website?.trim() || null,
      country: input.country?.trim() || "Canada",
      industry: "Municipal",
      tier: "lead",
      notes: input.notes ?? null,
    })
    .returning();
  return { accountId: row.id, created: true };
}

async function upsertContactByEmailOrName(input: {
  accountId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
}): Promise<{ contactId: number; created: boolean }> {
  // Look for an existing contact in this account that matches on email (if
  // we have one) or on first+last name. This keeps the integration
  // idempotent — re-importing the same row updates instead of duplicating.
  const candidates = await db
    .select()
    .from(crmContacts)
    .where(eq(crmContacts.accountId, input.accountId));
  const match = candidates.find((c) => {
    if (input.email && c.email && c.email.toLowerCase() === input.email.toLowerCase()) {
      return true;
    }
    return (
      c.firstName.toLowerCase() === input.firstName.toLowerCase() &&
      c.lastName.toLowerCase() === input.lastName.toLowerCase()
    );
  });
  if (match) {
    await db
      .update(crmContacts)
      .set({
        email: input.email ?? match.email,
        phone: input.phone ?? match.phone,
        role: input.role ?? match.role,
        updatedAt: new Date(),
      })
      .where(eq(crmContacts.id, match.id));
    return { contactId: match.id, created: false };
  }
  const [row] = await db
    .insert(crmContacts)
    .values({
      accountId: input.accountId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      role: input.role,
      isPrimary: input.isPrimary,
    })
    .returning();
  return { contactId: row.id, created: true };
}

function splitName(full: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const s = (full ?? "").trim();
  if (!s) return { firstName: "Contact", lastName: "" };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

export async function importMunicipalContactToCrm(
  contactId: number,
): Promise<{
  accountId: number;
  contactCreated: boolean;
  accountCreated: boolean;
}> {
  const { profile } = await requireUser();
  const [src] = await db
    .select()
    .from(municipalityContacts)
    .where(eq(municipalityContacts.id, contactId))
    .limit(1);
  if (!src) throw new Error("Municipal contact not found");

  const { accountId, created: accountCreated } =
    await findOrCreateMunicipalAccount({
      ownerUserId: profile.clerkUserId,
      name: src.municipalityName,
      website: src.website,
      country: "Canada",
      notes: src.servicesSummary ?? null,
    });

  const { firstName, lastName } = splitName(src.name);
  const { created: contactCreated } = await upsertContactByEmailOrName({
    accountId,
    firstName,
    lastName,
    email: src.email,
    phone: src.phone,
    role: src.role ?? src.department ?? null,
    isPrimary: false,
  });

  // Stamp an activity so the timeline shows where the lead came from.
  await db.insert(crmActivities).values({
    accountId,
    type: "note",
    subject: "Imported from Municipal Lead Generator",
    body: [
      src.role && `Role: ${src.role}`,
      src.department && `Department: ${src.department}`,
      src.sourceUrl && `Source: ${src.sourceUrl}`,
      src.servicesSummary && `Services: ${src.servicesSummary}`,
    ]
      .filter(Boolean)
      .join("\n") || null,
  });

  revalidatePath("/crm");
  revalidatePath("/crm/accounts");
  revalidatePath(`/crm/accounts/${accountId}`);
  return { accountId, contactCreated, accountCreated };
}

export async function importMunicipalListEntryToCrm(entryId: number): Promise<{
  accountId: number;
  contactsCreated: number;
  accountCreated: boolean;
}> {
  const { profile } = await requireUser();
  const [src] = await db
    .select()
    .from(municipalityListEntries)
    .where(eq(municipalityListEntries.id, entryId))
    .limit(1);
  if (!src) throw new Error("Municipal list entry not found");

  const { accountId, created: accountCreated } =
    await findOrCreateMunicipalAccount({
      ownerUserId: profile.clerkUserId,
      name: src.name,
      website: src.website,
      country: "Canada",
      notes: [
        src.designation && `Designation: ${src.designation}`,
        src.region && `Region: ${src.region}`,
        src.mrc && `MRC: ${src.mrc}`,
        src.population && `Population: ${src.population.toLocaleString()}`,
      ]
        .filter(Boolean)
        .join("\n") || null,
    });

  // Update account meta with anything new on the list entry side.
  await db
    .update(crmAccounts)
    .set({
      website: src.website ?? sql`${crmAccounts.website}`,
      country: "Canada",
      industry: "Municipal",
      employeeCount: null,
      updatedAt: new Date(),
    })
    .where(eq(crmAccounts.id, accountId));

  // Each named admin role becomes a contact. The mayor is marked primary.
  const roleSlots: Array<{
    name: string | null;
    role: string;
    isPrimary: boolean;
  }> = [
    { name: src.mayor, role: "Mayor", isPrimary: true },
    { name: src.directorGeneral, role: "Director General", isPrimary: false },
    { name: src.deputyDg, role: "Deputy DG", isPrimary: false },
    { name: src.treasurer, role: "Treasurer", isPrimary: false },
    { name: src.clerk, role: "Clerk", isPrimary: false },
    { name: src.policeChief, role: "Police Chief", isPrimary: false },
    { name: src.fireChief, role: "Fire Chief", isPrimary: false },
    {
      name: src.publicWorksDirector,
      role: "Public Works Director",
      isPrimary: false,
    },
    {
      name: src.recreationDirector,
      role: "Recreation Director",
      isPrimary: false,
    },
    { name: src.urbanPlanner, role: "Urban Planner", isPrimary: false },
    { name: src.communications, role: "Communications", isPrimary: false },
    { name: src.permits, role: "Permits", isPrimary: false },
    {
      name: src.buildingInspector,
      role: "Building Inspector",
      isPrimary: false,
    },
    {
      name: src.emergencyMeasures,
      role: "Emergency Measures",
      isPrimary: false,
    },
  ];

  let contactsCreated = 0;
  for (const slot of roleSlots) {
    if (!slot.name?.trim()) continue;
    const { firstName, lastName } = splitName(slot.name);
    const res = await upsertContactByEmailOrName({
      accountId,
      firstName,
      lastName,
      email: null,
      phone: null,
      role: slot.role,
      isPrimary: slot.isPrimary,
    });
    if (res.created) contactsCreated += 1;
  }

  // If no named role and the entry has a generic email/phone, capture it as
  // a generic "Municipal Office" contact so the account is at least reachable.
  if (contactsCreated === 0 && (src.email || src.phone)) {
    const res = await upsertContactByEmailOrName({
      accountId,
      firstName: "Municipal",
      lastName: "Office",
      email: src.email,
      phone: src.phone,
      role: "General",
      isPrimary: true,
    });
    if (res.created) contactsCreated += 1;
  }

  await db.insert(crmActivities).values({
    accountId,
    type: "note",
    subject: "Imported from Municipal Contact List",
    body: [
      src.region && `Region: ${src.region}`,
      src.mrc && `MRC: ${src.mrc}`,
      src.population && `Population: ${src.population.toLocaleString()}`,
      src.website && `Website: ${src.website}`,
    ]
      .filter(Boolean)
      .join("\n") || null,
  });

  revalidatePath("/crm");
  revalidatePath("/crm/accounts");
  revalidatePath(`/crm/accounts/${accountId}`);
  return { accountId, contactsCreated, accountCreated };
}

