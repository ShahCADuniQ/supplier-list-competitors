import { auth, currentUser } from "@clerk/nextjs/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { userProfiles, type UserProfile } from "@/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEALING SCHEMA — migration 0022 added three module gates
// (can_view_design_engineering / can_view_crm / can_view_oee). Production
// deployments may not have run `npm run db:apply` yet, so every code path
// that reads these columns triggers ensureUserProfileColumns() first. The
// pattern matches feedback_migration_forward_compat.md from memory.
// ─────────────────────────────────────────────────────────────────────────────

let _profileSchemaEnsured: Promise<void> | null = null;

export function ensureUserProfileColumns(): Promise<void> {
  if (_profileSchemaEnsured) return _profileSchemaEnsured;
  _profileSchemaEnsured = (async () => {
    try {
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "can_view_design_engineering" boolean NOT NULL DEFAULT false`,
      );
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "can_view_crm" boolean NOT NULL DEFAULT false`,
      );
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "can_view_oee" boolean NOT NULL DEFAULT false`,
      );
      // Migration 0026 — supplier-user flag. Lets us distinguish vendors
      // (signed in at the same /sign-in URL but emailed via supplier
      // outreach) from internal staff so the app shell shows them the
      // vendor portal only.
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "is_supplier" boolean NOT NULL DEFAULT false`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "user_profiles_is_supplier_idx" ON "user_profiles" ("is_supplier")`,
      );
      // Migration 0027 — multi-tenant + job role + PO source PDF
      await db.execute(sql`CREATE TABLE IF NOT EXISTS "clients" (
        "id" serial PRIMARY KEY,
        "name" text NOT NULL,
        "industry" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "notes" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "clients_name_idx" ON "clients" ("name")`,
      );
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "job_role" text`,
      );
      await db.execute(
        sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "client_id" integer REFERENCES "clients"("id") ON DELETE SET NULL`,
      );
      await db.execute(
        sql`ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "client_id" integer REFERENCES "clients"("id") ON DELETE SET NULL`,
      );
      await db.execute(
        sql`ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "source_pdf_url" text`,
      );
      await db.execute(
        sql`ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "source_pdf_name" text`,
      );
      await db.execute(
        sql`ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "source_pdf_pathname" text`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "user_profiles_client_idx" ON "user_profiles" ("client_id")`,
      );
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "suppliers_client_idx" ON "suppliers" ("client_id")`,
      );
      // Bootstrap the default client row from CLIENT_CONFIG (env var) and
      // back-fill every existing supplier/user-profile row that doesn't
      // already have a client. Non-CADuniQ employees + suppliers get
      // attached to the deployment's primary client.
      const defaultName = process.env.NEXT_PUBLIC_CLIENT_NAME ?? "Lightbase";
      const defaultIndustry = (process.env.NEXT_PUBLIC_CLIENT_INDUSTRY ?? "manufacturing").toLowerCase();
      await db.execute(sql`
        INSERT INTO "clients" ("name", "industry")
          VALUES (${defaultName}, ${defaultIndustry})
        ON CONFLICT DO NOTHING
      `);
      await db.execute(sql`
        UPDATE "suppliers"
          SET "client_id" = (SELECT id FROM "clients" WHERE name = ${defaultName} LIMIT 1)
          WHERE "client_id" IS NULL
      `);
      await db.execute(sql`
        UPDATE "user_profiles"
          SET "client_id" = (SELECT id FROM "clients" WHERE name = ${defaultName} LIMIT 1)
          WHERE "client_id" IS NULL
            AND LOWER(email) NOT LIKE '%@caduniq.com'
      `);
      // Backfill admins so the new gates inherit role-level access.
      await db.execute(sql`
        UPDATE "user_profiles"
          SET "can_view_design_engineering" = true,
              "can_view_crm" = true,
              "can_view_oee" = true
          WHERE "role" = 'admin'
            AND ("can_view_design_engineering" = false
              OR "can_view_crm" = false
              OR "can_view_oee" = false)
      `);
      // Backfill: any user_profiles row whose email matches a suppliers row
      // gets flagged as a supplier user (covers people who signed in before
      // migration 0026 ran).
      await db.execute(sql`
        UPDATE "user_profiles" up
          SET "is_supplier" = true
          WHERE "is_supplier" = false
            AND EXISTS (
              SELECT 1 FROM "suppliers" s
              WHERE LOWER(s.email) = LOWER(up.email)
            )
      `);
    } catch (e) {
      console.warn(
        "[permissions] ensureUserProfileColumns failed — run `npm run db:apply` to apply migrations 0022 + 0026.",
        e,
      );
    }
  })();
  return _profileSchemaEnsured;
}

// Returns true if the email is registered as a supplier contact. Used by
// getOrCreateProfile to flip the supplier flag on first sign-in so they
// land on the vendor portal instead of the buyer dashboard.
async function isSupplierEmail(email: string): Promise<boolean> {
  if (!email) return false;
  try {
    const rows = (await db.execute(
      sql`SELECT 1 FROM "suppliers" WHERE LOWER(email) = LOWER(${email}) LIMIT 1`,
    )) as unknown as { rows?: Array<unknown> } | Array<unknown>;
    // The Neon HTTP driver returns either { rows: [...] } or [...]; cover both.
    const list = Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : [];
    return list.length > 0;
  } catch {
    return false;
  }
}

// CADuniQ is the operator/vendor — every @caduniq.com mailbox is automatically
// a full admin across every client dashboard hosted on this codebase. The
// named list below covers explicit non-domain admins (e.g. legacy Lightbase
// owner) plus the canonical contact emails surfaced in the UI.
export const ADMIN_EMAIL_DOMAINS = ["caduniq.com"] as const;

export const ADMIN_EMAILS = [
  "hshah@caduniq.com",
  "hshah@lightbase.ca",
] as const;

export const ADMIN_EMAIL = ADMIN_EMAILS[0];

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Returns true if the email should be auto-promoted to admin on sign-in and
 * protected from being demoted via the UI. Matches either:
 *   - any address on a CADuniQ-staff domain (ADMIN_EMAIL_DOMAINS), or
 *   - one of the explicit named admin accounts (ADMIN_EMAILS).
 */
export function isSeededAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (ADMIN_EMAILS.some((a) => a.toLowerCase() === normalized)) return true;
  const domain = emailDomain(normalized);
  return ADMIN_EMAIL_DOMAINS.some((d) => d.toLowerCase() === domain);
}

/**
 * Resolve the current Clerk user's profile. If they don't have one yet, create
 * it. Seeded admin emails get full access automatically; everyone else starts
 * as `pending` and has to be approved by an admin.
 */
export async function getOrCreateProfile(): Promise<UserProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;

  await ensureUserProfileColumns();

  const existing = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, userId))
    .limit(1);

  if (existing.length) return existing[0];

  // First request after this Clerk user signed in — pull the email from Clerk.
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? "";
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null;

  const isAdmin = isSeededAdminEmail(email);
  // Suppliers are external — never auto-admin. A supplier email being on
  // the admin allowlist would be a configuration mistake, so admin wins.
  const isSupplier = !isAdmin && (await isSupplierEmail(email));

  // A row may already exist for this email under a *different* clerk_user_id
  // (e.g. a previous Clerk user for the same address, or a pre-seeded row).
  // The table has a UNIQUE index on email, so a naked INSERT would fail. Adopt
  // the existing row by repointing it at the current Clerk user.
  if (email) {
    const [existingByEmail] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.email, email))
      .limit(1);

    if (existingByEmail) {
      const updates: Partial<typeof userProfiles.$inferInsert> = {
        clerkUserId: userId,
        updatedAt: new Date(),
      };
      if (displayName && !existingByEmail.displayName) {
        updates.displayName = displayName;
      }
      // If this email is a seeded admin but the row was created in a less-
      // privileged state (pending/member from an earlier life), bring it up
      // to full admin so the bootstrap promise still holds.
      if (isAdmin && existingByEmail.role !== "admin") {
        updates.role = "admin";
        updates.canViewSuppliers = true;
        updates.canViewCompetitors = true;
        updates.canViewHandbook = true;
        updates.canViewEngineering = true;
        updates.canViewDesignEngineering = true;
        updates.canViewCrm = true;
        updates.canViewOee = true;
        updates.canEdit = true;
        if (!existingByEmail.approvedAt) updates.approvedAt = new Date();
        if (!existingByEmail.approvedBy) updates.approvedBy = "system:bootstrap";
      }
      // Supplier flag is sticky — once flipped on, stays on (cheap to
      // double-check, lets you re-classify a hijacked email by hand).
      if (isSupplier && !existingByEmail.isSupplier) {
        updates.isSupplier = true;
        if (existingByEmail.role === "pending") {
          // Suppliers don't need admin approval to use the vendor portal.
          updates.role = "member";
          if (!existingByEmail.approvedAt) updates.approvedAt = new Date();
          if (!existingByEmail.approvedBy)
            updates.approvedBy = "system:supplier-auto";
        }
      }

      const [adopted] = await db
        .update(userProfiles)
        .set(updates)
        .where(eq(userProfiles.email, email))
        .returning();
      return adopted ?? existingByEmail;
    }
  }

  const [created] = await db
    .insert(userProfiles)
    .values({
      clerkUserId: userId,
      email,
      displayName,
      // Suppliers go straight to member status so the vendor portal works
      // without an admin approval step — they're already in the suppliers
      // table, so they're known.
      role: isAdmin ? "admin" : isSupplier ? "member" : "pending",
      isSupplier,
      canViewSuppliers: isAdmin,
      canViewCompetitors: isAdmin,
      canViewHandbook: isAdmin,
      canViewEngineering: isAdmin,
      canViewDesignEngineering: isAdmin,
      canViewCrm: isAdmin,
      canViewOee: isAdmin,
      canEdit: isAdmin,
      approvedAt: isAdmin || isSupplier ? new Date() : null,
      approvedBy: isAdmin
        ? "system:bootstrap"
        : isSupplier
          ? "system:supplier-auto"
          : null,
    })
    .onConflictDoNothing({ target: userProfiles.clerkUserId })
    .returning();

  if (created) return created;

  // Race-condition fallback: another request created it first.
  const refetched = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.clerkUserId, userId))
    .limit(1);
  return refetched[0] ?? null;
}

// True if this user_profiles row is for an external supplier (vendor-portal
// account). Set on first sign-in when the email matches a row in `suppliers`.
// Admins win over suppliers — if an email is on both lists, admin sticks.
export function isSupplierUser(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return false;
  return Boolean(profile.isSupplier);
}

// CADuniQ staff = anyone on the CADuniQ admin allowlist (the @caduniq.com
// domain + the named seeded admins). CADuniQ users are cross-tenant —
// they can browse every client's admin page. Client-side admins (e.g.
// `hshah@lightbase.ca`) are admins of just their own client tenant.
export function isCaduniqUser(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return isSeededAdminEmail(profile.email);
}

export function isAdmin(profile: UserProfile | null | undefined): boolean {
  return profile?.role === "admin";
}

export function canViewSuppliers(profile: UserProfile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewSuppliers;
}

export function canViewCompetitors(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewCompetitors;
}

export function canViewHandbook(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewHandbook;
}

export function canViewEngineering(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewEngineering;
}

export function canViewDesignEngineering(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewDesignEngineering;
}

export function canViewCrm(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewCrm;
}

export function canViewOee(
  profile: UserProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canViewOee;
}

export function canEdit(profile: UserProfile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === "admin" || profile.canEdit;
}

/**
 * Throw if the current user is not an admin. Use inside server actions that
 * mutate users / approval state.
 */
export async function requireAdmin(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !isAdmin(profile)) {
    throw new Error("Unauthorized: admin access required");
  }
  return profile;
}

/** Throw if the current user can't view + edit suppliers. */
export async function requireSupplierEditor(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot edit suppliers");
  }
  return profile;
}

/** Throw if the current user can't view + edit competitors. */
export async function requireCompetitorEditor(): Promise<UserProfile> {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewCompetitors(profile) || !canEdit(profile)) {
    throw new Error("Unauthorized: cannot edit competitors");
  }
  return profile;
}
