import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { handbookRevisions } from "@/db/schema";
import { getOrCreateProfile, canViewHandbook } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

async function load(id: number, clerkUserId: string) {
  const [row] = await db
    .select()
    .from(handbookRevisions)
    .where(
      and(
        eq(handbookRevisions.id, id),
        eq(handbookRevisions.ownerClerkId, clerkUserId),
      ),
    )
    .limit(1);
  return row;
}

// GET /api/handbook/revisions/[id] — full revision including content.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const profile = await getOrCreateProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewHandbook(profile)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }

  const row = await load(numId, profile.clerkUserId);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ revision: row });
}

// PATCH /api/handbook/revisions/[id] — update name, content, and/or status.
// Body: { name?, content?, status? }
export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  const profile = await getOrCreateProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewHandbook(profile)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }

  let body: { name?: string; content?: unknown; status?: "draft" | "final" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const existing = await load(numId, profile.clerkUserId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updates: Partial<typeof handbookRevisions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (body.content && typeof body.content === "object") {
    updates.content = body.content;
  }
  if (body.status === "draft" || body.status === "final") {
    updates.status = body.status;
  }

  const [row] = await db
    .update(handbookRevisions)
    .set(updates)
    .where(
      and(
        eq(handbookRevisions.id, numId),
        eq(handbookRevisions.ownerClerkId, profile.clerkUserId),
      ),
    )
    .returning();

  return NextResponse.json({ revision: row });
}

// DELETE /api/handbook/revisions/[id]
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const profile = await getOrCreateProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewHandbook(profile)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }

  const result = await db
    .delete(handbookRevisions)
    .where(
      and(
        eq(handbookRevisions.id, numId),
        eq(handbookRevisions.ownerClerkId, profile.clerkUserId),
      ),
    )
    .returning({ id: handbookRevisions.id });

  if (!result.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
