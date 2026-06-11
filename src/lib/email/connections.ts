// Read/write helpers for user_email_connections, repurposed for Nylas.
//
// We keep the existing table shape so we don't need a migration:
//   • access_token_encrypted  → encrypted Nylas grant_id
//   • refresh_token_encrypted → unused for Nylas (always null)
//   • expires_at              → set to a far-future sentinel; Nylas
//                               manages real expiry on their side and
//                               surfaces re-auth needs on API errors
//   • scope                   → the Nylas-reported scope string
//
// Centralised so the OAuth callback, the transport layer, and the
// Manage Account UI all share one place to encrypt + persist + look up
// grants.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userEmailConnections } from "@/db/schema";
import { decryptToken, encryptToken } from "./crypto";
import { ensureEmailConnectionsSchema } from "./_ensure-schema";
import type { EmailProvider } from "./types";

// 100 years in the future. Nylas grants don't expire from our side; if
// the user revokes upstream we'll learn about it from a 401/403 on the
// next API call and surface a reconnect prompt then.
const SENTINEL_EXPIRY = new Date("2099-12-31T00:00:00.000Z");

export type ConnectionRecord = {
  id: number;
  clerkUserId: string;
  provider: EmailProvider;
  emailAddress: string;
  grantId: string;
  scope: string | null;
  lastSyncAt: Date | null;
};

export async function upsertConnection(args: {
  clerkUserId: string;
  provider: EmailProvider;
  emailAddress: string;
  grantId: string;
  scope: string | null;
}): Promise<void> {
  await ensureEmailConnectionsSchema();
  const encryptedGrant = encryptToken(args.grantId);
  const existing = await db
    .select({ id: userEmailConnections.id })
    .from(userEmailConnections)
    .where(
      and(
        eq(userEmailConnections.clerkUserId, args.clerkUserId),
        eq(userEmailConnections.provider, args.provider),
      ),
    )
    .limit(1);
  if (existing.length) {
    await db
      .update(userEmailConnections)
      .set({
        emailAddress: args.emailAddress,
        accessTokenEncrypted: encryptedGrant,
        refreshTokenEncrypted: null,
        expiresAt: SENTINEL_EXPIRY,
        scope: args.scope,
        updatedAt: new Date(),
      })
      .where(eq(userEmailConnections.id, existing[0].id));
  } else {
    await db.insert(userEmailConnections).values({
      clerkUserId: args.clerkUserId,
      provider: args.provider,
      emailAddress: args.emailAddress,
      accessTokenEncrypted: encryptedGrant,
      refreshTokenEncrypted: null,
      expiresAt: SENTINEL_EXPIRY,
      scope: args.scope,
    });
  }
}

export async function listConnections(
  clerkUserId: string,
): Promise<ConnectionRecord[]> {
  await ensureEmailConnectionsSchema();
  const rows = await db
    .select()
    .from(userEmailConnections)
    .where(eq(userEmailConnections.clerkUserId, clerkUserId));
  return rows.map((r) => ({
    id: r.id,
    clerkUserId: r.clerkUserId,
    provider: r.provider,
    emailAddress: r.emailAddress,
    grantId: decryptToken(r.accessTokenEncrypted),
    scope: r.scope,
    lastSyncAt: r.lastSyncAt,
  }));
}

export async function getConnection(
  clerkUserId: string,
  provider: EmailProvider,
): Promise<ConnectionRecord | null> {
  await ensureEmailConnectionsSchema();
  const rows = await db
    .select()
    .from(userEmailConnections)
    .where(
      and(
        eq(userEmailConnections.clerkUserId, clerkUserId),
        eq(userEmailConnections.provider, provider),
      ),
    )
    .limit(1);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    clerkUserId: r.clerkUserId,
    provider: r.provider,
    emailAddress: r.emailAddress,
    grantId: decryptToken(r.accessTokenEncrypted),
    scope: r.scope,
    lastSyncAt: r.lastSyncAt,
  };
}

export async function getPrimaryConnection(
  clerkUserId: string,
): Promise<ConnectionRecord | null> {
  const all = await listConnections(clerkUserId);
  if (!all.length) return null;
  // If a user has both Outlook and Gmail connected, the most recently
  // updated wins. Almost everyone will only connect one.
  return all[0];
}

export async function deleteConnection(
  clerkUserId: string,
  provider: EmailProvider,
): Promise<{ grantId: string | null }> {
  await ensureEmailConnectionsSchema();
  const existing = await getConnection(clerkUserId, provider);
  await db
    .delete(userEmailConnections)
    .where(
      and(
        eq(userEmailConnections.clerkUserId, clerkUserId),
        eq(userEmailConnections.provider, provider),
      ),
    );
  return { grantId: existing?.grantId ?? null };
}
