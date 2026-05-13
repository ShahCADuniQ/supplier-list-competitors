"use server";

// OEE server actions — CRUD for machines/runs/downtime/quality + alert
// lifecycle + OEE calculation engine + CRM ticket escalation.
//
// OEE math (computeOee*) — three legs:
//   Availability = run_time / planned_time
//   Performance  = (ideal_cycle * good_count) / run_time
//   Quality      = good_count / total_count
//   OEE          = A × P × Q
//
// Planned time = (end - start) of the window excluding planned downtime
// (changeovers, scheduled maintenance, setup). Run time = planned time
// minus unplanned downtime (breakdowns, material wait, etc.).
//
// Auth model: a machine is owned by the Clerk user who created it; admins
// see everything, everyone else sees only their own machines.

import { revalidatePath } from "next/cache";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  crmTickets,
  oeeAlerts,
  oeeDowntimeEvents,
  oeeMachines,
  oeeQualityEvents,
  oeeRuns,
  crmAccounts,
  type OeeAlert,
  type OeeDowntimeEvent,
  type OeeMachine,
  type OeeQualityEvent,
  type OeeRun,
} from "@/db/schema";
import { getOrCreateProfile, isAdmin } from "@/lib/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEALING SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

let _schemaEnsured: Promise<boolean> | null = null;

export async function ensureOeeSchema(): Promise<boolean> {
  if (_schemaEnsured) return _schemaEnsured;
  _schemaEnsured = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS __applied_migrations (
          filename text PRIMARY KEY,
          applied_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_machine_status" AS ENUM ('running','idle','down','maintenance','offline');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_downtime_reason" AS ENUM ('breakdown','setup','material','changeover','maintenance','no-operator','quality-hold','other');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_downtime_category" AS ENUM ('planned','unplanned');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_quality_type" AS ENUM ('scrap','rework','defect');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_alert_severity" AS ENUM ('info','warning','critical');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await db.execute(sql`DO $$ BEGIN
        CREATE TYPE "oee_alert_status" AS ENUM ('open','acknowledged','resolved','escalated');
      EXCEPTION WHEN duplicate_object THEN null; END $$`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "oee_machines" (
          "id" serial PRIMARY KEY,
          "owner_user_id" text NOT NULL,
          "name" text NOT NULL,
          "code" text,
          "line" text,
          "location" text,
          "ideal_cycle_seconds" numeric(8,3) NOT NULL DEFAULT 60,
          "status" "oee_machine_status" NOT NULL DEFAULT 'idle',
          "status_since" timestamp NOT NULL DEFAULT now(),
          "notes" text,
          "crm_account_id" integer REFERENCES "crm_accounts"("id") ON DELETE SET NULL,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_machines_owner_idx" ON "oee_machines" ("owner_user_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_machines_status_idx" ON "oee_machines" ("status")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_machines_line_idx" ON "oee_machines" ("line")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "oee_runs" (
          "id" serial PRIMARY KEY,
          "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
          "part_number" text NOT NULL,
          "part_name" text,
          "planned_start" timestamp NOT NULL,
          "planned_end" timestamp NOT NULL,
          "actual_start" timestamp,
          "actual_end" timestamp,
          "target_count" integer NOT NULL DEFAULT 0,
          "good_count" integer NOT NULL DEFAULT 0,
          "scrap_count" integer NOT NULL DEFAULT 0,
          "rework_count" integer NOT NULL DEFAULT 0,
          "notes" text,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_runs_machine_idx" ON "oee_runs" ("machine_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_runs_planned_start_idx" ON "oee_runs" ("planned_start")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "oee_downtime_events" (
          "id" serial PRIMARY KEY,
          "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
          "run_id" integer REFERENCES "oee_runs"("id") ON DELETE SET NULL,
          "reason" "oee_downtime_reason" NOT NULL,
          "category" "oee_downtime_category" NOT NULL,
          "start_at" timestamp NOT NULL,
          "end_at" timestamp,
          "notes" text,
          "created_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_downtime_machine_idx" ON "oee_downtime_events" ("machine_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_downtime_start_idx" ON "oee_downtime_events" ("start_at")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_downtime_reason_idx" ON "oee_downtime_events" ("reason")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "oee_quality_events" (
          "id" serial PRIMARY KEY,
          "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
          "run_id" integer REFERENCES "oee_runs"("id") ON DELETE SET NULL,
          "type" "oee_quality_type" NOT NULL,
          "quantity" integer NOT NULL DEFAULT 1,
          "defect_code" text,
          "notes" text,
          "occurred_at" timestamp NOT NULL DEFAULT now(),
          "created_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_quality_machine_idx" ON "oee_quality_events" ("machine_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_quality_occurred_idx" ON "oee_quality_events" ("occurred_at")`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "oee_alerts" (
          "id" serial PRIMARY KEY,
          "machine_id" integer NOT NULL REFERENCES "oee_machines"("id") ON DELETE CASCADE,
          "severity" "oee_alert_severity" NOT NULL DEFAULT 'warning',
          "status" "oee_alert_status" NOT NULL DEFAULT 'open',
          "code" text NOT NULL,
          "title" text NOT NULL,
          "body" text,
          "crm_ticket_id" integer REFERENCES "crm_tickets"("id") ON DELETE SET NULL,
          "raised_at" timestamp NOT NULL DEFAULT now(),
          "acknowledged_at" timestamp,
          "resolved_at" timestamp,
          "created_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_alerts_machine_idx" ON "oee_alerts" ("machine_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_alerts_status_idx" ON "oee_alerts" ("status")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "oee_alerts_raised_idx" ON "oee_alerts" ("raised_at")`);

      await db.execute(sql`
        INSERT INTO __applied_migrations (filename)
        VALUES ('0021_oee.sql')
        ON CONFLICT DO NOTHING
      `);
      return true;
    } catch (e) {
      console.warn(
        "[oee] auto-ensure schema failed — run `npm run db:apply` to apply migration 0021.",
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
  await ensureOeeSchema();
  return { profile, isAdminUser: isAdmin(profile) };
}

async function requireMachine(
  machineId: number,
): Promise<{ machine: OeeMachine }> {
  const { profile, isAdminUser } = await requireUser();
  const [machine] = await db
    .select()
    .from(oeeMachines)
    .where(eq(oeeMachines.id, machineId))
    .limit(1);
  if (!machine) throw new Error("Machine not found");
  if (machine.ownerUserId !== profile.clerkUserId && !isAdminUser) {
    throw new Error("Forbidden: not your machine");
  }
  return { machine };
}

// ─────────────────────────────────────────────────────────────────────────────
// MACHINES
// ─────────────────────────────────────────────────────────────────────────────

export async function listMyMachines(): Promise<OeeMachine[]> {
  const { profile, isAdminUser } = await requireUser();
  return db
    .select()
    .from(oeeMachines)
    .where(
      isAdminUser ? sql`true` : eq(oeeMachines.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(oeeMachines.updatedAt));
}

export async function createMachine(input: {
  name: string;
  code?: string;
  line?: string;
  location?: string;
  idealCycleSeconds?: number;
  notes?: string;
  crmAccountId?: number | null;
}): Promise<{ id: number }> {
  const { profile } = await requireUser();
  const name = input.name.trim();
  if (!name) throw new Error("Machine name is required");
  const [row] = await db
    .insert(oeeMachines)
    .values({
      ownerUserId: profile.clerkUserId,
      name,
      code: input.code?.trim() || null,
      line: input.line?.trim() || null,
      location: input.location?.trim() || null,
      idealCycleSeconds: String(
        Number.isFinite(input.idealCycleSeconds) && input.idealCycleSeconds! > 0
          ? input.idealCycleSeconds
          : 60,
      ),
      notes: input.notes?.trim() || null,
      crmAccountId: input.crmAccountId ?? null,
    })
    .returning();
  revalidatePath("/oee");
  revalidatePath("/oee/machines");
  return { id: row.id };
}

export async function updateMachine(
  id: number,
  patch: Partial<{
    name: string;
    code: string;
    line: string;
    location: string;
    idealCycleSeconds: number;
    status: OeeMachine["status"];
    notes: string;
    crmAccountId: number | null;
  }>,
): Promise<void> {
  await requireMachine(id);
  const set: Partial<typeof oeeMachines.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.code !== undefined) set.code = patch.code.trim() || null;
  if (patch.line !== undefined) set.line = patch.line.trim() || null;
  if (patch.location !== undefined)
    set.location = patch.location.trim() || null;
  if (patch.idealCycleSeconds !== undefined && patch.idealCycleSeconds > 0)
    set.idealCycleSeconds = String(patch.idealCycleSeconds);
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.crmAccountId !== undefined) set.crmAccountId = patch.crmAccountId;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.statusSince = new Date();
  }
  await db.update(oeeMachines).set(set).where(eq(oeeMachines.id, id));
  revalidatePath("/oee");
  revalidatePath("/oee/machines");
  revalidatePath(`/oee/machines/${id}`);
}

export async function deleteMachine(id: number): Promise<void> {
  await requireMachine(id);
  await db.delete(oeeMachines).where(eq(oeeMachines.id, id));
  revalidatePath("/oee");
  revalidatePath("/oee/machines");
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNS
// ─────────────────────────────────────────────────────────────────────────────

export async function createRun(input: {
  machineId: number;
  partNumber: string;
  partName?: string;
  plannedStart: Date;
  plannedEnd: Date;
  targetCount: number;
  notes?: string;
}): Promise<{ id: number }> {
  await requireMachine(input.machineId);
  if (!input.partNumber.trim()) throw new Error("Part number is required");
  const [row] = await db
    .insert(oeeRuns)
    .values({
      machineId: input.machineId,
      partNumber: input.partNumber.trim(),
      partName: input.partName?.trim() || null,
      plannedStart: input.plannedStart,
      plannedEnd: input.plannedEnd,
      targetCount: Math.max(0, input.targetCount | 0),
      notes: input.notes?.trim() || null,
    })
    .returning();
  revalidatePath(`/oee/machines/${input.machineId}`);
  revalidatePath("/oee");
  return { id: row.id };
}

export async function startRun(runId: number): Promise<void> {
  const [run] = await db
    .select()
    .from(oeeRuns)
    .where(eq(oeeRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Run not found");
  await requireMachine(run.machineId);
  const now = new Date();
  await db
    .update(oeeRuns)
    .set({ actualStart: run.actualStart ?? now, updatedAt: now })
    .where(eq(oeeRuns.id, runId));
  await db
    .update(oeeMachines)
    .set({ status: "running", statusSince: now, updatedAt: now })
    .where(eq(oeeMachines.id, run.machineId));
  revalidatePath(`/oee/machines/${run.machineId}`);
  revalidatePath("/oee");
}

export async function endRun(runId: number): Promise<void> {
  const [run] = await db
    .select()
    .from(oeeRuns)
    .where(eq(oeeRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Run not found");
  await requireMachine(run.machineId);
  const now = new Date();
  await db
    .update(oeeRuns)
    .set({ actualEnd: now, updatedAt: now })
    .where(eq(oeeRuns.id, runId));
  // Close any open downtime + drop the machine back to idle.
  await db
    .update(oeeDowntimeEvents)
    .set({ endAt: now })
    .where(
      and(
        eq(oeeDowntimeEvents.runId, runId),
        sql`${oeeDowntimeEvents.endAt} is null`,
      ),
    );
  await db
    .update(oeeMachines)
    .set({ status: "idle", statusSince: now, updatedAt: now })
    .where(eq(oeeMachines.id, run.machineId));
  revalidatePath(`/oee/machines/${run.machineId}`);
  revalidatePath("/oee");
}

export async function updateRunCounts(
  runId: number,
  patch: Partial<{
    goodCount: number;
    scrapCount: number;
    reworkCount: number;
    targetCount: number;
  }>,
): Promise<void> {
  const [run] = await db
    .select()
    .from(oeeRuns)
    .where(eq(oeeRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Run not found");
  await requireMachine(run.machineId);
  const set: Partial<typeof oeeRuns.$inferInsert> = { updatedAt: new Date() };
  if (patch.goodCount !== undefined) set.goodCount = Math.max(0, patch.goodCount | 0);
  if (patch.scrapCount !== undefined) set.scrapCount = Math.max(0, patch.scrapCount | 0);
  if (patch.reworkCount !== undefined)
    set.reworkCount = Math.max(0, patch.reworkCount | 0);
  if (patch.targetCount !== undefined)
    set.targetCount = Math.max(0, patch.targetCount | 0);
  await db.update(oeeRuns).set(set).where(eq(oeeRuns.id, runId));
  revalidatePath(`/oee/machines/${run.machineId}`);
}

export async function deleteRun(runId: number): Promise<void> {
  const [run] = await db
    .select()
    .from(oeeRuns)
    .where(eq(oeeRuns.id, runId))
    .limit(1);
  if (!run) return;
  await requireMachine(run.machineId);
  await db.delete(oeeRuns).where(eq(oeeRuns.id, runId));
  revalidatePath(`/oee/machines/${run.machineId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNTIME
// ─────────────────────────────────────────────────────────────────────────────

export async function recordDowntime(input: {
  machineId: number;
  runId?: number | null;
  reason: OeeDowntimeEvent["reason"];
  category: OeeDowntimeEvent["category"];
  startAt?: Date;
  endAt?: Date | null;
  notes?: string;
}): Promise<{ id: number }> {
  await requireMachine(input.machineId);
  const start = input.startAt ?? new Date();
  const [row] = await db
    .insert(oeeDowntimeEvents)
    .values({
      machineId: input.machineId,
      runId: input.runId ?? null,
      reason: input.reason,
      category: input.category,
      startAt: start,
      endAt: input.endAt ?? null,
      notes: input.notes?.trim() || null,
    })
    .returning();
  // If this is an unplanned breakdown, set the machine to "down" and raise
  // an alert. The user can later escalate to a CRM ticket.
  if (input.category === "unplanned" && !input.endAt) {
    await db
      .update(oeeMachines)
      .set({ status: "down", statusSince: start, updatedAt: new Date() })
      .where(eq(oeeMachines.id, input.machineId));
    await db.insert(oeeAlerts).values({
      machineId: input.machineId,
      severity: input.reason === "breakdown" ? "critical" : "warning",
      code: `downtime.${input.reason}`,
      title: `Machine down: ${input.reason.replace(/-/g, " ")}`,
      body: input.notes ?? null,
    });
  } else if (input.category === "planned" && !input.endAt) {
    await db
      .update(oeeMachines)
      .set({
        status: input.reason === "maintenance" ? "maintenance" : "idle",
        statusSince: start,
        updatedAt: new Date(),
      })
      .where(eq(oeeMachines.id, input.machineId));
  }
  revalidatePath(`/oee/machines/${input.machineId}`);
  revalidatePath("/oee");
  revalidatePath("/oee/alerts");
  return { id: row.id };
}

export async function closeDowntime(eventId: number): Promise<void> {
  const [evt] = await db
    .select()
    .from(oeeDowntimeEvents)
    .where(eq(oeeDowntimeEvents.id, eventId))
    .limit(1);
  if (!evt) return;
  await requireMachine(evt.machineId);
  const now = new Date();
  await db
    .update(oeeDowntimeEvents)
    .set({ endAt: now })
    .where(eq(oeeDowntimeEvents.id, eventId));
  // Drop the machine back to idle (operator can mark "running" if a run is
  // active). Auto-resolve any open alerts for this downtime.
  await db
    .update(oeeMachines)
    .set({ status: "idle", statusSince: now, updatedAt: now })
    .where(eq(oeeMachines.id, evt.machineId));
  await db
    .update(oeeAlerts)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        eq(oeeAlerts.machineId, evt.machineId),
        eq(oeeAlerts.code, `downtime.${evt.reason}`),
        eq(oeeAlerts.status, "open"),
      ),
    );
  revalidatePath(`/oee/machines/${evt.machineId}`);
  revalidatePath("/oee");
  revalidatePath("/oee/alerts");
}

export async function deleteDowntime(eventId: number): Promise<void> {
  const [evt] = await db
    .select()
    .from(oeeDowntimeEvents)
    .where(eq(oeeDowntimeEvents.id, eventId))
    .limit(1);
  if (!evt) return;
  await requireMachine(evt.machineId);
  await db.delete(oeeDowntimeEvents).where(eq(oeeDowntimeEvents.id, eventId));
  revalidatePath(`/oee/machines/${evt.machineId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY
// ─────────────────────────────────────────────────────────────────────────────

export async function recordQuality(input: {
  machineId: number;
  runId?: number | null;
  type: OeeQualityEvent["type"];
  quantity: number;
  defectCode?: string;
  notes?: string;
}): Promise<{ id: number }> {
  await requireMachine(input.machineId);
  const qty = Math.max(1, input.quantity | 0);
  const [row] = await db
    .insert(oeeQualityEvents)
    .values({
      machineId: input.machineId,
      runId: input.runId ?? null,
      type: input.type,
      quantity: qty,
      defectCode: input.defectCode?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .returning();
  // Also bump the run's scrap/rework counter so OEE quality leg is accurate.
  if (input.runId) {
    if (input.type === "scrap") {
      await db
        .update(oeeRuns)
        .set({
          scrapCount: sql`${oeeRuns.scrapCount} + ${qty}`,
          updatedAt: new Date(),
        })
        .where(eq(oeeRuns.id, input.runId));
    } else if (input.type === "rework") {
      await db
        .update(oeeRuns)
        .set({
          reworkCount: sql`${oeeRuns.reworkCount} + ${qty}`,
          updatedAt: new Date(),
        })
        .where(eq(oeeRuns.id, input.runId));
    }
  }
  revalidatePath(`/oee/machines/${input.machineId}`);
  return { id: row.id };
}

export async function deleteQuality(eventId: number): Promise<void> {
  const [evt] = await db
    .select()
    .from(oeeQualityEvents)
    .where(eq(oeeQualityEvents.id, eventId))
    .limit(1);
  if (!evt) return;
  await requireMachine(evt.machineId);
  await db.delete(oeeQualityEvents).where(eq(oeeQualityEvents.id, eventId));
  revalidatePath(`/oee/machines/${evt.machineId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────────

export async function listMyAlerts(): Promise<
  Array<OeeAlert & { machineName: string; machineId: number }>
> {
  const { profile, isAdminUser } = await requireUser();
  const rows = await db
    .select({ a: oeeAlerts, name: oeeMachines.name, mId: oeeMachines.id })
    .from(oeeAlerts)
    .innerJoin(oeeMachines, eq(oeeMachines.id, oeeAlerts.machineId))
    .where(
      isAdminUser ? sql`true` : eq(oeeMachines.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(oeeAlerts.raisedAt));
  return rows.map((r) => ({
    ...r.a,
    machineName: r.name,
    machineId: r.mId,
  }));
}

export async function acknowledgeAlert(alertId: number): Promise<void> {
  const [alert] = await db
    .select()
    .from(oeeAlerts)
    .where(eq(oeeAlerts.id, alertId))
    .limit(1);
  if (!alert) throw new Error("Alert not found");
  await requireMachine(alert.machineId);
  await db
    .update(oeeAlerts)
    .set({ status: "acknowledged", acknowledgedAt: new Date() })
    .where(eq(oeeAlerts.id, alertId));
  revalidatePath("/oee");
  revalidatePath("/oee/alerts");
}

export async function resolveAlert(alertId: number): Promise<void> {
  const [alert] = await db
    .select()
    .from(oeeAlerts)
    .where(eq(oeeAlerts.id, alertId))
    .limit(1);
  if (!alert) throw new Error("Alert not found");
  await requireMachine(alert.machineId);
  await db
    .update(oeeAlerts)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(oeeAlerts.id, alertId));
  revalidatePath("/oee");
  revalidatePath("/oee/alerts");
}

export async function deleteAlert(alertId: number): Promise<void> {
  const [alert] = await db
    .select()
    .from(oeeAlerts)
    .where(eq(oeeAlerts.id, alertId))
    .limit(1);
  if (!alert) return;
  await requireMachine(alert.machineId);
  await db.delete(oeeAlerts).where(eq(oeeAlerts.id, alertId));
  revalidatePath("/oee/alerts");
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM INTEGRATION — escalate alert to ticket
// ─────────────────────────────────────────────────────────────────────────────

export async function escalateAlertToCrm(
  alertId: number,
): Promise<{ ticketId: number; accountId: number }> {
  const { profile } = await requireUser();
  const [alert] = await db
    .select()
    .from(oeeAlerts)
    .where(eq(oeeAlerts.id, alertId))
    .limit(1);
  if (!alert) throw new Error("Alert not found");
  if (alert.crmTicketId) {
    // Already escalated — return the existing ticket so the caller can link.
    const [t] = await db
      .select()
      .from(crmTickets)
      .where(eq(crmTickets.id, alert.crmTicketId))
      .limit(1);
    if (t) return { ticketId: t.id, accountId: t.accountId };
  }
  const { machine } = await requireMachine(alert.machineId);

  // Resolve the account: prefer the machine's linked CRM account; if none,
  // find or create a single internal "Shop Floor" account on the owner.
  let accountId: number;
  if (machine.crmAccountId) {
    accountId = machine.crmAccountId;
  } else {
    const existing = await db
      .select({ id: crmAccounts.id })
      .from(crmAccounts)
      .where(
        and(
          eq(crmAccounts.ownerUserId, profile.clerkUserId),
          eq(crmAccounts.name, "Shop Floor (internal)"),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      accountId = existing[0].id;
    } else {
      const [created] = await db
        .insert(crmAccounts)
        .values({
          ownerUserId: profile.clerkUserId,
          name: "Shop Floor (internal)",
          industry: "Manufacturing",
          tier: "customer",
          notes:
            "Internal account holding OEE-escalated tickets that aren't tied to a customer account. Re-assign machines to real customers in /oee/machines.",
        })
        .returning();
      accountId = created.id;
    }
  }

  const [ticket] = await db
    .insert(crmTickets)
    .values({
      accountId,
      subject: `[OEE] ${alert.title} — ${machine.name}`,
      body: [
        `Machine: ${machine.name}${machine.code ? ` (${machine.code})` : ""}`,
        machine.line && `Line: ${machine.line}`,
        machine.location && `Location: ${machine.location}`,
        `Alert code: ${alert.code}`,
        `Severity: ${alert.severity}`,
        `Raised: ${alert.raisedAt.toISOString()}`,
        alert.body && `\n${alert.body}`,
      ]
        .filter(Boolean)
        .join("\n"),
      status: "open",
      priority:
        alert.severity === "critical"
          ? "urgent"
          : alert.severity === "warning"
            ? "high"
            : "medium",
    })
    .returning();

  await db
    .update(oeeAlerts)
    .set({ status: "escalated", crmTicketId: ticket.id })
    .where(eq(oeeAlerts.id, alertId));

  revalidatePath("/oee/alerts");
  revalidatePath("/crm/tickets");
  revalidatePath(`/crm/accounts/${accountId}`);
  return { ticketId: ticket.id, accountId };
}

// ─────────────────────────────────────────────────────────────────────────────
// OEE CALCULATION + DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

export type OeeBreakdown = {
  availability: number; // 0..1
  performance: number; // 0..1
  quality: number; // 0..1
  oee: number; // A × P × Q
  plannedTimeMs: number;
  runTimeMs: number;
  plannedDowntimeMs: number;
  unplannedDowntimeMs: number;
  goodCount: number;
  totalCount: number;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function overlapMs(
  a: Date,
  b: Date,
  windowStart: Date,
  windowEnd: Date,
): number {
  const s = Math.max(a.getTime(), windowStart.getTime());
  const e = Math.min(b.getTime(), windowEnd.getTime());
  return Math.max(0, e - s);
}

export async function computeOeeForWindow(
  machineId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<OeeBreakdown> {
  const { machine } = await requireMachine(machineId);
  const wsMs = windowStart.getTime();
  const weMs = Math.min(windowEnd.getTime(), Date.now());
  const totalWindowMs = Math.max(0, weMs - wsMs);

  const [runRows, downRows] = await Promise.all([
    db
      .select()
      .from(oeeRuns)
      .where(
        and(
          eq(oeeRuns.machineId, machineId),
          lte(oeeRuns.plannedStart, windowEnd),
          gte(oeeRuns.plannedEnd, windowStart),
        ),
      ),
    db
      .select()
      .from(oeeDowntimeEvents)
      .where(
        and(
          eq(oeeDowntimeEvents.machineId, machineId),
          lte(oeeDowntimeEvents.startAt, windowEnd),
        ),
      ),
  ]);

  let goodCount = 0;
  let totalCount = 0;
  for (const r of runRows) {
    goodCount += r.goodCount;
    totalCount += r.goodCount + r.scrapCount + r.reworkCount;
  }

  let plannedDowntimeMs = 0;
  let unplannedDowntimeMs = 0;
  for (const d of downRows) {
    const ms = overlapMs(d.startAt, d.endAt ?? new Date(), windowStart, windowEnd);
    if (d.category === "planned") plannedDowntimeMs += ms;
    else unplannedDowntimeMs += ms;
  }

  const plannedTimeMs = Math.max(0, totalWindowMs - plannedDowntimeMs);
  const runTimeMs = Math.max(0, plannedTimeMs - unplannedDowntimeMs);

  const availability = plannedTimeMs > 0 ? runTimeMs / plannedTimeMs : 0;
  const ideal = Number(machine.idealCycleSeconds) * 1000; // ms per unit
  const performance =
    runTimeMs > 0 && ideal > 0 ? (ideal * goodCount) / runTimeMs : 0;
  const quality = totalCount > 0 ? goodCount / totalCount : 0;
  const oee = availability * performance * quality;

  return {
    availability: clamp01(availability),
    performance: clamp01(performance),
    quality: clamp01(quality),
    oee: clamp01(oee),
    plannedTimeMs,
    runTimeMs,
    plannedDowntimeMs,
    unplannedDowntimeMs,
    goodCount,
    totalCount,
  };
}

export type OeeDashboard = {
  asOf: Date;
  windowHours: number;
  fleet: OeeBreakdown;
  machines: Array<{
    machine: OeeMachine;
    breakdown: OeeBreakdown;
    currentRun: OeeRun | null;
    openDowntime: OeeDowntimeEvent | null;
  }>;
  statusCounts: Record<OeeMachine["status"], number>;
  openAlerts: number;
  criticalAlerts: number;
  recentAlerts: Array<
    OeeAlert & { machineName: string; machineId: number }
  >;
  topLossReasons: Array<{
    reason: OeeDowntimeEvent["reason"];
    totalMs: number;
    count: number;
  }>;
};

export async function getOeeDashboard(
  windowHours = 24,
): Promise<OeeDashboard> {
  const { profile, isAdminUser } = await requireUser();
  const machines = await db
    .select()
    .from(oeeMachines)
    .where(
      isAdminUser ? sql`true` : eq(oeeMachines.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(oeeMachines.updatedAt));

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);

  // Compute per-machine breakdown in parallel (each is just a SELECT).
  const perMachine = await Promise.all(
    machines.map(async (m) => {
      const breakdown = await computeOeeForWindow(m.id, windowStart, now);
      const [currentRun] = await db
        .select()
        .from(oeeRuns)
        .where(
          and(
            eq(oeeRuns.machineId, m.id),
            sql`${oeeRuns.actualStart} is not null`,
            sql`${oeeRuns.actualEnd} is null`,
          ),
        )
        .orderBy(desc(oeeRuns.actualStart))
        .limit(1);
      const [openDowntime] = await db
        .select()
        .from(oeeDowntimeEvents)
        .where(
          and(
            eq(oeeDowntimeEvents.machineId, m.id),
            sql`${oeeDowntimeEvents.endAt} is null`,
          ),
        )
        .orderBy(desc(oeeDowntimeEvents.startAt))
        .limit(1);
      return {
        machine: m,
        breakdown,
        currentRun: currentRun ?? null,
        openDowntime: openDowntime ?? null,
      };
    }),
  );

  // Fleet roll-up = simple aggregate over the per-machine numbers.
  let plannedTimeMs = 0;
  let runTimeMs = 0;
  let plannedDowntimeMs = 0;
  let unplannedDowntimeMs = 0;
  let goodCount = 0;
  let totalCount = 0;
  for (const p of perMachine) {
    plannedTimeMs += p.breakdown.plannedTimeMs;
    runTimeMs += p.breakdown.runTimeMs;
    plannedDowntimeMs += p.breakdown.plannedDowntimeMs;
    unplannedDowntimeMs += p.breakdown.unplannedDowntimeMs;
    goodCount += p.breakdown.goodCount;
    totalCount += p.breakdown.totalCount;
  }
  // Fleet performance: use the machines' weighted average rather than
  // assuming a single ideal cycle. Weight by run-time.
  const avgPerf =
    perMachine.reduce(
      (s, p) => s + p.breakdown.performance * p.breakdown.runTimeMs,
      0,
    ) / Math.max(1, runTimeMs);
  const availability = plannedTimeMs > 0 ? runTimeMs / plannedTimeMs : 0;
  const quality = totalCount > 0 ? goodCount / totalCount : 0;

  const statusCounts: Record<OeeMachine["status"], number> = {
    running: 0,
    idle: 0,
    down: 0,
    maintenance: 0,
    offline: 0,
  };
  for (const m of machines) statusCounts[m.status] += 1;

  // Alerts
  const alertRows = await db
    .select({ a: oeeAlerts, name: oeeMachines.name, mId: oeeMachines.id })
    .from(oeeAlerts)
    .innerJoin(oeeMachines, eq(oeeMachines.id, oeeAlerts.machineId))
    .where(
      isAdminUser ? sql`true` : eq(oeeMachines.ownerUserId, profile.clerkUserId),
    )
    .orderBy(desc(oeeAlerts.raisedAt))
    .limit(50);
  const recentAlerts = alertRows.map((r) => ({
    ...r.a,
    machineName: r.name,
    machineId: r.mId,
  }));
  const openAlerts = recentAlerts.filter(
    (a) => a.status === "open" || a.status === "acknowledged",
  ).length;
  const criticalAlerts = recentAlerts.filter(
    (a) =>
      a.severity === "critical" &&
      (a.status === "open" || a.status === "acknowledged"),
  ).length;

  // Top loss reasons within the window
  const lossRows = await db
    .select({
      reason: oeeDowntimeEvents.reason,
      ms: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(${oeeDowntimeEvents.endAt}, now()) - ${oeeDowntimeEvents.startAt})) * 1000), 0)`,
      count: count(oeeDowntimeEvents.id),
    })
    .from(oeeDowntimeEvents)
    .innerJoin(oeeMachines, eq(oeeMachines.id, oeeDowntimeEvents.machineId))
    .where(
      and(
        isAdminUser ? sql`true` : eq(oeeMachines.ownerUserId, profile.clerkUserId),
        gte(oeeDowntimeEvents.startAt, windowStart),
      ),
    )
    .groupBy(oeeDowntimeEvents.reason);
  const topLossReasons = lossRows
    .map((r) => ({
      reason: r.reason,
      totalMs: Number(r.ms),
      count: Number(r.count),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    asOf: now,
    windowHours,
    fleet: {
      availability: clamp01(availability),
      performance: clamp01(avgPerf),
      quality: clamp01(quality),
      oee: clamp01(availability * avgPerf * quality),
      plannedTimeMs,
      runTimeMs,
      plannedDowntimeMs,
      unplannedDowntimeMs,
      goodCount,
      totalCount,
    },
    machines: perMachine,
    statusCounts,
    openAlerts,
    criticalAlerts,
    recentAlerts: recentAlerts.slice(0, 10),
    topLossReasons,
  };
}

export async function getMachineDetail(machineId: number): Promise<{
  machine: OeeMachine;
  runs: OeeRun[];
  downtime: OeeDowntimeEvent[];
  quality: OeeQualityEvent[];
  alerts: OeeAlert[];
  breakdown24h: OeeBreakdown;
} | null> {
  try {
    const { machine } = await requireMachine(machineId);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const [runs, downtime, quality, alerts, breakdown24h] = await Promise.all([
      db
        .select()
        .from(oeeRuns)
        .where(eq(oeeRuns.machineId, machineId))
        .orderBy(desc(oeeRuns.plannedStart))
        .limit(20),
      db
        .select()
        .from(oeeDowntimeEvents)
        .where(eq(oeeDowntimeEvents.machineId, machineId))
        .orderBy(desc(oeeDowntimeEvents.startAt))
        .limit(30),
      db
        .select()
        .from(oeeQualityEvents)
        .where(eq(oeeQualityEvents.machineId, machineId))
        .orderBy(desc(oeeQualityEvents.occurredAt))
        .limit(30),
      db
        .select()
        .from(oeeAlerts)
        .where(eq(oeeAlerts.machineId, machineId))
        .orderBy(desc(oeeAlerts.raisedAt))
        .limit(20),
      computeOeeForWindow(machineId, dayAgo, now),
    ]);
    return { machine, runs, downtime, quality, alerts, breakdown24h };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED DEMO DATA — quick way to populate the dashboard with 4 machines + a
// day of runs / downtime / quality so the UI is non-empty out of the box.
// Idempotent: only seeds if the user has zero machines.
// ─────────────────────────────────────────────────────────────────────────────

export async function seedOeeDemoData(): Promise<{
  seeded: boolean;
  machineIds: number[];
}> {
  const { profile } = await requireUser();
  const existing = await db
    .select({ id: oeeMachines.id })
    .from(oeeMachines)
    .where(eq(oeeMachines.ownerUserId, profile.clerkUserId))
    .limit(1);
  if (existing.length > 0) return { seeded: false, machineIds: [] };

  const now = new Date();
  const hour = 3600 * 1000;

  const machineDefs: Array<{
    name: string;
    code: string;
    line: string;
    location: string;
    idealCycleSeconds: string;
    status: OeeMachine["status"];
  }> = [
    {
      name: "CNC Mill #1",
      code: "CNC-01",
      line: "Line A",
      location: "Bay 1",
      idealCycleSeconds: "45",
      status: "running",
    },
    {
      name: "CNC Mill #2",
      code: "CNC-02",
      line: "Line A",
      location: "Bay 2",
      idealCycleSeconds: "45",
      status: "down",
    },
    {
      name: "Press Brake",
      code: "PB-01",
      line: "Line B",
      location: "Bay 3",
      idealCycleSeconds: "30",
      status: "running",
    },
    {
      name: "Laser Cutter",
      code: "LC-01",
      line: "Line B",
      location: "Bay 4",
      idealCycleSeconds: "20",
      status: "maintenance",
    },
  ];

  const inserted = await db
    .insert(oeeMachines)
    .values(
      machineDefs.map((m) => ({
        ownerUserId: profile.clerkUserId,
        name: m.name,
        code: m.code,
        line: m.line,
        location: m.location,
        idealCycleSeconds: m.idealCycleSeconds,
        status: m.status,
        statusSince: new Date(now.getTime() - Math.random() * 6 * hour),
      })),
    )
    .returning();
  const ids = inserted.map((r) => r.id);

  // One run per machine over the last 24h.
  await db.insert(oeeRuns).values(
    inserted.map((m, i) => ({
      machineId: m.id,
      partNumber: `P-${1000 + i}`,
      partName: `Demo Part ${String.fromCharCode(65 + i)}`,
      plannedStart: new Date(now.getTime() - 24 * hour),
      plannedEnd: new Date(now.getTime() + 4 * hour),
      actualStart: new Date(now.getTime() - 22 * hour),
      actualEnd: null,
      targetCount: 500,
      goodCount: [420, 180, 380, 240][i] ?? 200,
      scrapCount: [12, 24, 8, 6][i] ?? 5,
      reworkCount: [6, 4, 10, 3][i] ?? 2,
    })),
  );

  // Some downtime over the day — a planned changeover everywhere, a real
  // breakdown on machine #2 still open, a maintenance window on #4.
  await db.insert(oeeDowntimeEvents).values([
    {
      machineId: ids[0],
      reason: "changeover",
      category: "planned",
      startAt: new Date(now.getTime() - 12 * hour),
      endAt: new Date(now.getTime() - 11.5 * hour),
    },
    {
      machineId: ids[1],
      reason: "breakdown",
      category: "unplanned",
      startAt: new Date(now.getTime() - 2 * hour),
      endAt: null,
      notes: "Spindle bearing noise — pulled from line",
    },
    {
      machineId: ids[1],
      reason: "setup",
      category: "planned",
      startAt: new Date(now.getTime() - 8 * hour),
      endAt: new Date(now.getTime() - 7 * hour),
    },
    {
      machineId: ids[2],
      reason: "material",
      category: "unplanned",
      startAt: new Date(now.getTime() - 4 * hour),
      endAt: new Date(now.getTime() - 3.5 * hour),
      notes: "Coil delivery delayed 30 min",
    },
    {
      machineId: ids[3],
      reason: "maintenance",
      category: "planned",
      startAt: new Date(now.getTime() - 1 * hour),
      endAt: null,
      notes: "Scheduled gas refill + mirror clean",
    },
  ]);

  // A couple of alerts so the alert queue is visible.
  await db.insert(oeeAlerts).values([
    {
      machineId: ids[1],
      severity: "critical",
      code: "downtime.breakdown",
      title: "Machine down: breakdown",
      body: "Spindle bearing noise — pulled from line",
    },
    {
      machineId: ids[2],
      severity: "warning",
      code: "downtime.material",
      title: "Material wait > 30min",
      body: "Coil delivery delayed",
      status: "resolved",
      resolvedAt: new Date(now.getTime() - 3 * hour),
    },
  ]);

  revalidatePath("/oee");
  revalidatePath("/oee/machines");
  revalidatePath("/oee/alerts");
  return { seeded: true, machineIds: ids };
}
