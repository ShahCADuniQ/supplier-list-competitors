"use server";

// Server actions for the Stage 1 design-engineering workflow. Owns the
// design_projects table CRUD plus the Claude-powered material/process
// recommender that wraps the "AI material picker" from the concept guide
// step 4 (path C).
//
// Auth model: a project is owned by the Clerk user who created it; only
// that user (and admins) can read/write it. No cross-tenant sharing yet.
//
// Migration safety: ensureDesignProjectsSchema() self-heals migration 0019
// on first call so a deploy that ships this code without the operator
// running `npm run db:apply` still works. Same pattern as
// ensureCompetitorProductsSchema in src/app/competitors/_attachments.ts —
// see feedback_migration_forward_compat.md memory.

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  designProjects,
  type DesignBomItem,
  type DesignCadFile,
  type DesignDrawingSettings,
  type DesignProject,
} from "@/db/schema";
import { getOrCreateProfile, isAdmin } from "@/lib/permissions";
import type Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL,
  CLAUDE_FALLBACK_MODELS,
  claudeClient,
  hasClaudeKey,
} from "@/lib/ai/claude";
import { extractBomFromStepText, isStepFile } from "./step-parser";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA AUTO-ENSURE — runs once per server process
// ─────────────────────────────────────────────────────────────────────────────

let _schemaEnsured: Promise<boolean> | null = null;

export async function ensureDesignProjectsSchema(): Promise<boolean> {
  if (_schemaEnsured) return _schemaEnsured;
  _schemaEnsured = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS __applied_migrations (
          filename text PRIMARY KEY,
          applied_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`
        DO $$ BEGIN
          CREATE TYPE "design_project_status" AS ENUM ('draft', 'in-review', 'approved');
        EXCEPTION WHEN duplicate_object THEN null; END $$
      `);
      await db.execute(sql`
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
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "design_projects_user_idx" ON "design_projects" ("clerk_user_id")
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "design_projects_status_idx" ON "design_projects" ("status")
      `);
      await db.execute(sql`
        INSERT INTO __applied_migrations (filename)
        VALUES ('0019_design_projects.sql')
        ON CONFLICT DO NOTHING
      `);
      return true;
    } catch (e) {
      console.warn(
        "[design-engineering] auto-ensure schema failed — run `npm run db:apply` to apply migration 0019.",
        e,
      );
      return false;
    }
  })();
  return _schemaEnsured;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GATE
// ─────────────────────────────────────────────────────────────────────────────

async function requireProject(
  projectId: number,
): Promise<{ project: DesignProject; clerkUserId: string; isAdminUser: boolean }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  await ensureDesignProjectsSchema();
  const [project] = await db
    .select()
    .from(designProjects)
    .where(eq(designProjects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found");
  const adminUser = isAdmin(profile);
  if (project.clerkUserId !== profile.clerkUserId && !adminUser) {
    throw new Error("Forbidden: not your project");
  }
  return {
    project,
    clerkUserId: profile.clerkUserId,
    isAdminUser: adminUser,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function listMyDesignProjects(): Promise<DesignProject[]> {
  const profile = await getOrCreateProfile();
  if (!profile) return [];
  await ensureDesignProjectsSchema();
  // Admins see every project; everyone else sees only their own.
  const where = isAdmin(profile)
    ? undefined
    : eq(designProjects.clerkUserId, profile.clerkUserId);
  const rows = await db
    .select()
    .from(designProjects)
    .where(where ?? sql`true`)
    .orderBy(desc(designProjects.updatedAt));
  return rows;
}

export async function getDesignProject(
  id: number,
): Promise<DesignProject | null> {
  const profile = await getOrCreateProfile();
  if (!profile) return null;
  await ensureDesignProjectsSchema();
  const [row] = await db
    .select()
    .from(designProjects)
    .where(
      isAdmin(profile)
        ? eq(designProjects.id, id)
        : and(
            eq(designProjects.id, id),
            eq(designProjects.clerkUserId, profile.clerkUserId),
          ),
    )
    .limit(1);
  return row ?? null;
}

export async function createDesignProject(input: {
  name: string;
  niche?: string;
  description?: string;
}): Promise<{ id: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");
  await ensureDesignProjectsSchema();
  const [row] = await db
    .insert(designProjects)
    .values({
      clerkUserId: profile.clerkUserId,
      name,
      niche: input.niche?.trim() || null,
      description: input.description?.trim() || null,
    })
    .returning();
  revalidatePath("/design-engineering");
  return { id: row.id };
}

export async function deleteDesignProject(id: number): Promise<void> {
  await requireProject(id);
  await db.delete(designProjects).where(eq(designProjects.id, id));
  revalidatePath("/design-engineering");
}

export async function updateDesignProjectMeta(
  id: number,
  patch: { name?: string; niche?: string; description?: string },
): Promise<void> {
  await requireProject(id);
  const set: Partial<typeof designProjects.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.niche !== undefined) set.niche = patch.niche.trim() || null;
  if (patch.description !== undefined)
    set.description = patch.description.trim() || null;
  await db
    .update(designProjects)
    .set(set)
    .where(eq(designProjects.id, id));
  revalidatePath(`/design-engineering/projects/${id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — CAD FILES
// ─────────────────────────────────────────────────────────────────────────────

export async function attachCadFile(
  projectId: number,
  file: DesignCadFile,
): Promise<void> {
  const { project } = await requireProject(projectId);
  const next = [...project.cadFiles, file];
  await db
    .update(designProjects)
    .set({ cadFiles: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function removeCadFile(
  projectId: number,
  blobPathname: string,
): Promise<void> {
  const { project } = await requireProject(projectId);
  const next = project.cadFiles.filter((f) => f.blobPathname !== blobPathname);
  await db
    .update(designProjects)
    .set({ cadFiles: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — DRAWING SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

export async function updateDrawingSettings(
  projectId: number,
  patch: Partial<DesignDrawingSettings>,
): Promise<void> {
  const { project } = await requireProject(projectId);
  const next: DesignDrawingSettings = {
    ...project.drawingSettings,
    ...patch,
  };
  await db
    .update(designProjects)
    .set({ drawingSettings: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — BOM EDITOR
// ─────────────────────────────────────────────────────────────────────────────

function emptyBomItem(itemNumber: string): DesignBomItem {
  return {
    id: crypto.randomUUID(),
    itemNumber,
    partName: "",
    productCode: "",
    description: "",
    quantity: 1,
    material: "",
    process: "",
    notes: "",
    aiRecommendation: null,
  };
}

export async function addBomItem(projectId: number): Promise<void> {
  const { project } = await requireProject(projectId);
  const nextNumber = String(project.bomItems.length + 1);
  const next = [...project.bomItems, emptyBomItem(nextNumber)];
  await db
    .update(designProjects)
    .set({ bomItems: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function updateBomItem(
  projectId: number,
  itemId: string,
  patch: Partial<Omit<DesignBomItem, "id" | "aiRecommendation">>,
): Promise<void> {
  const { project } = await requireProject(projectId);
  const next = project.bomItems.map((b) =>
    b.id === itemId ? { ...b, ...patch } : b,
  );
  await db
    .update(designProjects)
    .set({ bomItems: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function removeBomItem(
  projectId: number,
  itemId: string,
): Promise<void> {
  const { project } = await requireProject(projectId);
  const next = project.bomItems.filter((b) => b.id !== itemId);
  await db
    .update(designProjects)
    .set({ bomItems: next, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — CLAUDE MATERIAL/PROCESS RECOMMENDER
//
// Concept guide step 4 path C: given a part description, quantity, and
// budget, Claude returns the optimal material/process pair with rationale.
// Strict tool_use schema keeps the response machine-parseable.
// ─────────────────────────────────────────────────────────────────────────────

const RECOMMEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    material: {
      type: "string",
      description:
        "Specific alloy/grade/polymer recommendation. e.g. '6061-T6', '304 SS', 'POM (Delrin)', 'ABS', 'Carbon-fiber UD prepreg'.",
    },
    process: {
      type: "string",
      description:
        "Manufacturing process. e.g. '3-axis CNC mill', '5-axis CNC mill', 'CNC turn', 'Sheet metal laser + brake', 'Injection mold', 'Die cast', 'SLS 3D print', 'MJF 3D print'.",
    },
    rationale: {
      type: "string",
      description:
        "2-3 sentence rationale explaining WHY this material/process fits the geometry, quantity, and budget.",
    },
    estimatedCostUsd: {
      type: "number",
      description:
        "Estimated unit cost in USD at the requested quantity. Use 0 if you don't have enough info.",
    },
  },
  required: ["material", "process", "rationale", "estimatedCostUsd"],
} as const;

type RecommendResult = {
  material: string;
  process: string;
  rationale: string;
  estimatedCostUsd: number;
};

export async function recommendBomItemMaterial(input: {
  projectId: number;
  itemId: string;
  partName: string;
  description: string;
  quantity: number;
  targetBudgetUsdPerPart?: number | null;
}): Promise<{
  ok: true;
  recommendation: DesignBomItem["aiRecommendation"];
} | { ok: false; error: string }> {
  try {
    const { project } = await requireProject(input.projectId);
    if (!hasClaudeKey()) {
      return {
        ok: false,
        error:
          "ANTHROPIC_API_KEY is not set on the server. Add it to .env to enable AI recommendations.",
      };
    }
    const item = project.bomItems.find((b) => b.id === input.itemId);
    if (!item) return { ok: false, error: "BOM item not found" };

    const partName = input.partName.trim() || item.partName.trim();
    const description = input.description.trim() || item.description.trim();
    if (!partName && !description) {
      return {
        ok: false,
        error:
          "Add a part name or description to the BOM line before requesting a recommendation.",
      };
    }

    const userMsg = `Recommend the best material and manufacturing process for this part:

Part: ${partName || "(unnamed)"}
Description: ${description || "(no description)"}
Quantity: ${input.quantity}
Target budget per part: ${
      input.targetBudgetUsdPerPart
        ? `$${input.targetBudgetUsdPerPart.toFixed(2)} USD`
        : "(not specified — recommend a sensible default)"
    }
Project niche: ${project.niche ?? "(unspecified)"}
Project description: ${project.description ?? "(unspecified)"}

Return a SPECIFIC material grade (not just "aluminum" — pick e.g. "6061-T6"), a SPECIFIC process (not just "CNC" — pick e.g. "3-axis CNC mill"), and a 2-3 sentence rationale.`;

    const systemPrompt = `You are an expert manufacturing engineer recommending materials and processes for hardware components. Match the recommendation to the geometry (inferred from the description), the quantity, and the budget. At low volumes (<50 units) prefer CNC / 3D printing. At medium volumes (50-1000) prefer CNC for precision parts and sheet metal / casting for structural parts. At high volumes (>1000) prefer injection molding for plastics and die casting / stamping for metals. Always use the record_recommendation tool to return your answer — that's the only valid response.`;

    const client = claudeClient();
    const requestedModel = CLAUDE_MODEL;
    const tryModels = [
      requestedModel,
      ...CLAUDE_FALLBACK_MODELS.filter((m) => m !== requestedModel),
    ];

    let parsed: RecommendResult | null = null;
    let lastModel = requestedModel;
    for (const model of tryModels) {
      lastModel = model;
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 1024,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: [
            {
              name: "record_recommendation",
              description:
                "Record the recommended material, process, rationale, and estimated unit cost.",
              input_schema:
                RECOMMEND_SCHEMA as unknown as Anthropic.Tool.InputSchema,
              cache_control: { type: "ephemeral" },
            },
          ],
          tool_choice: { type: "tool", name: "record_recommendation" },
          messages: [{ role: "user", content: userMsg }],
        });
        for (const block of res.content) {
          if (
            block.type === "tool_use" &&
            block.name === "record_recommendation"
          ) {
            parsed = block.input as RecommendResult;
            break;
          }
        }
        if (parsed) break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          !/not[_ ]?found|permission|invalid[_ ]?model|404|403/i.test(msg)
        ) {
          throw e;
        }
        console.warn(
          `[recommendBomItemMaterial] ${model} unavailable, trying next fallback`,
          msg,
        );
      }
    }
    if (!parsed) {
      return {
        ok: false,
        error: "Claude returned no recommendation across all fallback models.",
      };
    }

    const recommendation: DesignBomItem["aiRecommendation"] = {
      material: parsed.material,
      process: parsed.process,
      rationale: parsed.rationale,
      estimatedCostUsd:
        typeof parsed.estimatedCostUsd === "number" && parsed.estimatedCostUsd > 0
          ? parsed.estimatedCostUsd
          : null,
      model: lastModel,
      at: new Date().toISOString(),
    };

    const next = project.bomItems.map((b) =>
      b.id === input.itemId
        ? {
            ...b,
            partName: partName || b.partName,
            description: description || b.description,
            quantity: input.quantity || b.quantity,
            material: recommendation.material,
            process: recommendation.process,
            aiRecommendation: recommendation,
          }
        : b,
    );
    await db
      .update(designProjects)
      .set({ bomItems: next, updatedAt: new Date() })
      .where(eq(designProjects.id, input.projectId));
    revalidatePath(`/design-engineering/projects/${input.projectId}`);

    return { ok: true, recommendation };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[recommendBomItemMaterial] failed:", msg);
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEPS 5/6 — FEA + INSTALLATION-MANUAL NOTES
// ─────────────────────────────────────────────────────────────────────────────

export async function updateFeaNotes(
  projectId: number,
  notes: string,
): Promise<void> {
  await requireProject(projectId);
  await db
    .update(designProjects)
    .set({ feaNotes: notes, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function updateManualNotes(
  projectId: number,
  notes: string,
): Promise<void> {
  await requireProject(projectId);
  await db
    .update(designProjects)
    .set({ manualNotes: notes, updatedAt: new Date() })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — APPROVAL + MANIFEST EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export async function approveDesignProject(
  projectId: number,
  approvalNotes: string,
): Promise<void> {
  const { project, clerkUserId } = await requireProject(projectId);
  const updates: Partial<typeof designProjects.$inferInsert> = {
    approvalNotes: approvalNotes.trim(),
    updatedAt: new Date(),
  };
  if (project.status !== "approved") {
    updates.status = "approved";
    updates.approvedAt = new Date();
    updates.approvedBy = clerkUserId;
  }
  await db
    .update(designProjects)
    .set(updates)
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function reopenDesignProject(projectId: number): Promise<void> {
  await requireProject(projectId);
  await db
    .update(designProjects)
    .set({
      status: "draft",
      approvedAt: null,
      approvedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(designProjects.id, projectId));
  revalidatePath(`/design-engineering/projects/${projectId}`);
}

export async function buildProjectManifest(
  projectId: number,
): Promise<{ filename: string; content: string }> {
  const { project } = await requireProject(projectId);
  const manifest = {
    schemaVersion: 1,
    project: {
      id: project.id,
      name: project.name,
      niche: project.niche,
      description: project.description,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      approvedAt: project.approvedAt,
      approvedBy: project.approvedBy,
    },
    drawingSettings: project.drawingSettings,
    cadFiles: project.cadFiles,
    bom: project.bomItems,
    feaNotes: project.feaNotes,
    manualNotes: project.manualNotes,
    approvalNotes: project.approvalNotes,
    sha256: createHash("sha256")
      .update(
        JSON.stringify({
          id: project.id,
          name: project.name,
          cadFiles: project.cadFiles,
          bomItems: project.bomItems,
          drawingSettings: project.drawingSettings,
        }),
      )
      .digest("hex"),
    generatedAt: new Date().toISOString(),
  };
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `project-${project.id}`;
  return {
    filename: `caduniq-design-${project.id}-${slug}.json`,
    content: JSON.stringify(manifest, null, 2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-BOM EXTRACTION FROM STEP FILES
//
// Fetches a STEP file from blob storage, parses it with the lightweight
// PRODUCT/NAUO extractor, and merges the result into the project's BOM.
// Merge strategy: existing BOM lines whose lower-cased name matches an
// extracted entry are LEFT ALONE (so manual edits + AI recommendations
// survive auto-runs). New extracted lines are appended.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_PARSE_MAX_BYTES = 30 * 1024 * 1024; // 30 MB — large STEPs take ~10s

export type AutoExtractResult =
  | {
      ok: true;
      extracted: number;
      added: number;
      kept: number;
      skipped: number;
    }
  | { ok: false; error: string };

export async function autoExtractBomFromCadFile(
  projectId: number,
  blobPathname: string,
  options: { mode: "merge" | "replace" } = { mode: "merge" },
): Promise<AutoExtractResult> {
  try {
    const { project } = await requireProject(projectId);
    const cad = project.cadFiles.find((f) => f.blobPathname === blobPathname);
    if (!cad) return { ok: false, error: "CAD file not found on project" };
    if (!isStepFile({ name: cad.name, mime: cad.mime })) {
      return {
        ok: false,
        error: `Auto-extract works on STEP files only. "${cad.name}" looks like a different format — parse failed.`,
      };
    }

    // Fetch the STEP file from blob.
    const res = await fetch(cad.url);
    if (!res.ok) {
      return {
        ok: false,
        error: `Could not fetch CAD file (HTTP ${res.status}).`,
      };
    }
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength && contentLength > STEP_PARSE_MAX_BYTES) {
      return {
        ok: false,
        error: `CAD file is ${(contentLength / 1024 / 1024).toFixed(1)} MB — too large to auto-parse. Add BOM lines manually.`,
      };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > STEP_PARSE_MAX_BYTES) {
      return {
        ok: false,
        error: `CAD file is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB — too large to auto-parse.`,
      };
    }
    const text = new TextDecoder("utf-8").decode(buf);

    // Parse.
    const extracted = extractBomFromStepText(text);
    if (extracted.length === 0) {
      return {
        ok: false,
        error:
          "Couldn't find any PRODUCT entries in this STEP file. It may be empty, encrypted, or use a non-standard variant. Add BOM lines manually.",
      };
    }

    // Merge into existing BOM.
    const existingKeys = new Set(
      project.bomItems.map((b) => b.partName.toLowerCase().trim()),
    );
    let nextItems: DesignBomItem[];
    if (options.mode === "replace") {
      nextItems = [];
    } else {
      nextItems = [...project.bomItems];
    }

    let added = 0;
    let kept = 0;
    let skipped = 0;
    let nextItemNumber =
      Math.max(0, ...nextItems.map((b) => Number(b.itemNumber) || 0)) + 1;

    for (const e of extracted) {
      const key = e.name.toLowerCase().trim();
      if (options.mode === "merge" && existingKeys.has(key)) {
        skipped++;
        continue;
      }
      nextItems.push({
        id: crypto.randomUUID(),
        itemNumber: String(nextItemNumber++),
        partName: e.name,
        productCode: "",
        description: e.description,
        quantity: e.quantity,
        material: "",
        process: "",
        notes: "",
        aiRecommendation: null,
      });
      added++;
    }
    kept = options.mode === "merge" ? project.bomItems.length : 0;

    await db
      .update(designProjects)
      .set({ bomItems: nextItems, updatedAt: new Date() })
      .where(eq(designProjects.id, projectId));
    revalidatePath(`/design-engineering/projects/${projectId}`);

    return {
      ok: true,
      extracted: extracted.length,
      added,
      kept,
      skipped,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[autoExtractBomFromCadFile] failed:", msg);
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-PROJECT QUERIES (used by the Enterprise PDM tab and Software dashboard)
// ─────────────────────────────────────────────────────────────────────────────

export type DesignProjectStats = {
  totalProjects: number;
  drafts: number;
  approved: number;
  totalCadFiles: number;
  totalBomLines: number;
  totalCadBytes: number;
};

export async function getDesignProjectStats(): Promise<DesignProjectStats> {
  const projects = await listMyDesignProjects();
  let totalCadFiles = 0;
  let totalBomLines = 0;
  let totalCadBytes = 0;
  let drafts = 0;
  let approved = 0;
  for (const p of projects) {
    totalCadFiles += p.cadFiles.length;
    totalBomLines += p.bomItems.length;
    totalCadBytes += p.cadFiles.reduce((s, f) => s + f.size, 0);
    if (p.status === "approved") approved++;
    else drafts++;
  }
  return {
    totalProjects: projects.length,
    drafts,
    approved,
    totalCadFiles,
    totalBomLines,
    totalCadBytes,
  };
}

export type VaultFile = DesignCadFile & {
  projectId: number;
  projectName: string;
  projectStatus: DesignProject["status"];
  uploadedAt: string;
};

export async function listVaultFiles(): Promise<VaultFile[]> {
  const projects = await listMyDesignProjects();
  const out: VaultFile[] = [];
  for (const p of projects) {
    for (const f of p.cadFiles) {
      out.push({
        ...f,
        projectId: p.id,
        projectName: p.name,
        projectStatus: p.status,
        // We don't have per-file upload timestamps; use project's
        // updatedAt as a coarse proxy. Future migration: per-file
        // uploadedAt timestamp.
        uploadedAt: p.updatedAt.toISOString(),
      });
    }
  }
  // Most-recent first.
  out.sort(
    (a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
  return out;
}
