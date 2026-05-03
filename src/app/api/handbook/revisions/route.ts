import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { handbookRevisions } from "@/db/schema";
import { getOrCreateProfile, canViewHandbook } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// GET /api/handbook/revisions — list the current user's revisions, omitting
// the heavy `content` blob so the picker stays fast.
export async function GET() {
  const profile = await getOrCreateProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewHandbook(profile)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await db
    .select({
      id: handbookRevisions.id,
      name: handbookRevisions.name,
      status: handbookRevisions.status,
      createdAt: handbookRevisions.createdAt,
      updatedAt: handbookRevisions.updatedAt,
    })
    .from(handbookRevisions)
    .where(eq(handbookRevisions.ownerClerkId, profile.clerkUserId))
    .orderBy(desc(handbookRevisions.updatedAt));

  return NextResponse.json({ revisions: rows });
}

// POST /api/handbook/revisions — create a new revision.
// Body: { name?, content, status? }
export async function POST(request: NextRequest) {
  const profile = await getOrCreateProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewHandbook(profile)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { name?: string; content?: unknown; status?: "draft" | "final" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.content || typeof body.content !== "object") {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }
  const status = body.status === "final" ? "final" : "draft";
  const name = (body.name ?? "").trim() || defaultRevisionName();

  const [row] = await db
    .insert(handbookRevisions)
    .values({
      ownerClerkId: profile.clerkUserId,
      name,
      content: body.content,
      status,
    })
    .returning();

  return NextResponse.json({ revision: row }, { status: 201 });
}

function defaultRevisionName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Draft ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
