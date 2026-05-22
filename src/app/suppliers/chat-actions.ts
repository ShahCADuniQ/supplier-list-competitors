"use server";

// Live chat between buyer (Lightbase team / supplier-editors) and a
// supplier's portal users. One supplier can have many channels (default
// "General" auto-created on first access, plus any custom channels the
// buyer adds). Each call goes through `assertCanChat(supplierId)` so both
// sides hit the same authz path.
//
// Real-time delivery is implemented by polling — clients fetch every few
// seconds while a channel is open. Cheap, no Socket.IO/SSE infra needed,
// and avoids tying chat to a specific edge runtime. If latency becomes a
// problem we can swap in SSE without changing the data model.

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  chatChannels,
  chatMessages,
  chatReads,
  suppliers,
  supplierContacts,
  type ChatChannel,
  type ChatMessage,
} from "@/db/schema";
import {
  canViewSuppliers,
  getOrCreateProfile,
  isSupplierUser,
} from "@/lib/permissions";
import { ensureSupplierColumns } from "./_ensure-schema";

// ─────────────────────────────────────────────────────────────────────────────
// AUTHZ
// ─────────────────────────────────────────────────────────────────────────────

type ChatActor = {
  clerkUserId: string;
  email: string;
  name: string | null;
  role: "buyer" | "supplier";
};

// Either party can read/post in any channel for the given supplier:
//   • Buyer = signed-in user with supplier-edit permissions
//   • Supplier = signed-in user with is_supplier flag whose email matches
//     the supplier's primary email OR any supplier_contacts row.
async function assertCanChat(supplierId: number): Promise<ChatActor> {
  await ensureSupplierColumns();
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: please sign in");
  const name = profile.displayName?.trim() || profile.email;

  // Any tenant team member with supplier-view access is treated as
  // the "buyer" actor in chat — they can read AND post in any
  // channel for any supplier they're allowed to see. canEdit is not
  // required (the user wants every Lightbase team member fully
  // functional in chat without needing edit permission).
  if (canViewSuppliers(profile)) {
    return { clerkUserId: profile.clerkUserId, email: profile.email, name, role: "buyer" };
  }
  if (isSupplierUser(profile)) {
    const emailLc = profile.email.toLowerCase();
    const matches = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .leftJoin(supplierContacts, eq(supplierContacts.supplierId, suppliers.id))
      .where(
        and(
          eq(suppliers.id, supplierId),
          sql`(LOWER(${suppliers.email}) = ${emailLc} OR LOWER(${supplierContacts.email}) = ${emailLc})`,
        ),
      )
      .limit(1);
    if (matches.length > 0) {
      return { clerkUserId: profile.clerkUserId, email: profile.email, name, role: "supplier" };
    }
  }
  throw new Error("Unauthorized: not a participant on this supplier's chat");
}

// Only the buyer can create/rename/archive channels — keeps the supplier's
// view focused on conversation rather than organisational churn.
async function assertBuyerForSupplier(supplierId: number): Promise<ChatActor> {
  const actor = await assertCanChat(supplierId);
  if (actor.role !== "buyer") throw new Error("Only the buyer can change channels");
  return actor;
}

// Ensure the supplier always has at least the default "General" channel.
// Called by listChannels so the supplier sees something on first visit.
async function ensureDefaultChannel(supplierId: number, actor: ChatActor): Promise<void> {
  const existing = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(eq(chatChannels.supplierId, supplierId))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(chatChannels).values({
    supplierId,
    name: "General",
    kind: "default",
    createdByClerkId: actor.clerkUserId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// READS — channels + messages
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelWithUnread = ChatChannel & { unreadCount: number; lastMessageAt: Date | null };

export async function listChannels(supplierId: number): Promise<ChannelWithUnread[]> {
  const actor = await assertCanChat(supplierId);
  await ensureDefaultChannel(supplierId, actor);

  const channels = await db
    .select()
    .from(chatChannels)
    .where(and(eq(chatChannels.supplierId, supplierId), eq(chatChannels.archived, false)))
    .orderBy(desc(chatChannels.kind), asc(chatChannels.createdAt));
  if (channels.length === 0) return [];

  const ids = channels.map((c) => c.id);
  const reads = await db
    .select({ channelId: chatReads.channelId, lastReadAt: chatReads.lastReadAt })
    .from(chatReads)
    .where(and(inArray(chatReads.channelId, ids), eq(chatReads.clerkUserId, actor.clerkUserId)));
  const readMap = new Map(reads.map((r) => [r.channelId, r.lastReadAt]));

  // Per-channel last-message timestamp + unread count (messages newer than
  // the user's last read, NOT authored by the user themselves).
  const stats = (await db.execute(sql`
    SELECT
      ${chatMessages.channelId} AS channel_id,
      MAX(${chatMessages.createdAt}) AS last_at,
      COUNT(*) FILTER (
        WHERE ${chatMessages.authorClerkId} <> ${actor.clerkUserId}
      ) AS total_other
    FROM ${chatMessages}
    WHERE ${chatMessages.channelId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      AND ${chatMessages.deletedAt} IS NULL
    GROUP BY ${chatMessages.channelId}
  `)) as unknown as
    | { rows?: Array<{ channel_id: number; last_at: Date | null; total_other: number }> }
    | Array<{ channel_id: number; last_at: Date | null; total_other: number }>;
  const statList = Array.isArray(stats) ? stats : (stats?.rows ?? []);
  const statMap = new Map(statList.map((r) => [Number(r.channel_id), r]));

  const result: ChannelWithUnread[] = [];
  for (const c of channels) {
    const s = statMap.get(c.id);
    const lastAt = s?.last_at ? new Date(s.last_at) : null;
    const lastRead = readMap.get(c.id) ?? null;
    let unread = 0;
    if (lastAt) {
      // Count messages newer than the last read AND not authored by self.
      const newCount = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.channelId, c.id),
            sql`${chatMessages.authorClerkId} <> ${actor.clerkUserId}`,
            sql`${chatMessages.deletedAt} IS NULL`,
            lastRead ? gt(chatMessages.createdAt, lastRead) : sql`true`,
          ),
        );
      unread = Number(newCount[0]?.n ?? 0);
    }
    result.push({ ...c, lastMessageAt: lastAt, unreadCount: unread });
  }
  return result;
}

export async function listMessages(input: {
  channelId: number;
  // Optional cursor: only fetch messages strictly newer than this. Used by
  // the polling loop to incrementally pull new messages.
  sinceMs?: number;
  limit?: number;
}): Promise<ChatMessage[]> {
  // Look up the channel's supplier so we can run the same authz path.
  const [channel] = await db
    .select({ supplierId: chatChannels.supplierId })
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) throw new Error("Channel not found");
  await assertCanChat(channel.supplierId);

  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const conds = [
    eq(chatMessages.channelId, input.channelId),
    sql`${chatMessages.deletedAt} IS NULL`,
  ];
  if (input.sinceMs) {
    conds.push(gt(chatMessages.createdAt, new Date(input.sinceMs)));
  }
  return db
    .select()
    .from(chatMessages)
    .where(and(...conds))
    .orderBy(asc(chatMessages.createdAt))
    .limit(limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMessage(input: {
  channelId: number;
  body: string;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentPathname?: string;
}): Promise<{ messageId: number }> {
  const body = input.body.trim();
  if (!body && !input.attachmentUrl) throw new Error("Message body or attachment required");
  const [channel] = await db
    .select({ supplierId: chatChannels.supplierId })
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) throw new Error("Channel not found");
  const actor = await assertCanChat(channel.supplierId);

  const [row] = await db
    .insert(chatMessages)
    .values({
      channelId: input.channelId,
      authorClerkId: actor.clerkUserId,
      authorRole: actor.role,
      authorName: actor.name,
      body,
      attachmentUrl: input.attachmentUrl ?? null,
      attachmentName: input.attachmentName ?? null,
      attachmentPathname: input.attachmentPathname ?? null,
    })
    .returning({ id: chatMessages.id });

  // Bump the sender's own read pointer so they don't see their own message
  // as unread on another device.
  await markChannelRead({ channelId: input.channelId });

  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { messageId: row.id };
}

export async function markChannelRead(input: { channelId: number }): Promise<void> {
  const [channel] = await db
    .select({ supplierId: chatChannels.supplierId })
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) return;
  const actor = await assertCanChat(channel.supplierId);
  // Upsert pattern via ON CONFLICT against the unique (channel, user) index.
  await db.execute(sql`
    INSERT INTO chat_reads (channel_id, clerk_user_id, last_read_at)
    VALUES (${input.channelId}, ${actor.clerkUserId}, now())
    ON CONFLICT (channel_id, clerk_user_id)
    DO UPDATE SET last_read_at = EXCLUDED.last_read_at
  `);
}

export async function deleteMessage(input: { messageId: number }): Promise<void> {
  const [msg] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, input.messageId))
    .limit(1);
  if (!msg) return;
  const [channel] = await db
    .select({ supplierId: chatChannels.supplierId })
    .from(chatChannels)
    .where(eq(chatChannels.id, msg.channelId))
    .limit(1);
  if (!channel) return;
  const actor = await assertCanChat(channel.supplierId);
  // Sender can delete own message; buyer can delete any.
  if (msg.authorClerkId !== actor.clerkUserId && actor.role !== "buyer") {
    throw new Error("Only the author or a buyer can delete this message");
  }
  await db
    .update(chatMessages)
    .set({ deletedAt: new Date() })
    .where(eq(chatMessages.id, input.messageId));
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL ADMIN (buyer-only)
// ─────────────────────────────────────────────────────────────────────────────

export async function createChannel(input: {
  supplierId: number;
  name: string;
}): Promise<{ channelId: number }> {
  const actor = await assertBuyerForSupplier(input.supplierId);
  const name = input.name.trim();
  if (!name) throw new Error("Channel name is required");
  const [row] = await db
    .insert(chatChannels)
    .values({
      supplierId: input.supplierId,
      name,
      kind: "custom",
      createdByClerkId: actor.clerkUserId,
    })
    .returning({ id: chatChannels.id });
  revalidatePath("/suppliers");
  revalidatePath("/portal");
  return { channelId: row.id };
}

export async function renameChannel(input: { channelId: number; name: string }): Promise<void> {
  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) throw new Error("Channel not found");
  await assertBuyerForSupplier(channel.supplierId);
  const name = input.name.trim();
  if (!name) throw new Error("Channel name is required");
  await db
    .update(chatChannels)
    .set({ name, updatedAt: new Date() })
    .where(eq(chatChannels.id, input.channelId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}

export async function archiveChannel(input: { channelId: number; archived: boolean }): Promise<void> {
  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) throw new Error("Channel not found");
  if (channel.kind === "default" && input.archived) {
    throw new Error("The General channel cannot be archived");
  }
  await assertBuyerForSupplier(channel.supplierId);
  await db
    .update(chatChannels)
    .set({ archived: input.archived, updatedAt: new Date() })
    .where(eq(chatChannels.id, input.channelId));
  revalidatePath("/suppliers");
  revalidatePath("/portal");
}
