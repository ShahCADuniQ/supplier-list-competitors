// Read/write helpers for user_email_connections. Centralised so the
// OAuth callbacks, the transport layer, and the Settings UI all share
// one place to encrypt + persist + decrypt + refresh tokens.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userEmailConnections } from "@/db/schema";
import { decryptToken, encryptToken } from "./crypto";
import { ensureEmailConnectionsSchema } from "./_ensure-schema";
import { providerConfig, redirectUri } from "./providers";
import type { EmailProvider, TokenResponse } from "./types";

export type DecryptedConnection = {
  id: number;
  clerkUserId: string;
  provider: EmailProvider;
  emailAddress: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
  lastSyncAt: Date | null;
};

export async function upsertConnection(args: {
  clerkUserId: string;
  provider: EmailProvider;
  emailAddress: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}): Promise<void> {
  await ensureEmailConnectionsSchema();
  const enc = {
    accessTokenEncrypted: encryptToken(args.accessToken),
    refreshTokenEncrypted: args.refreshToken
      ? encryptToken(args.refreshToken)
      : null,
  };
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
        accessTokenEncrypted: enc.accessTokenEncrypted,
        // Preserve old refresh token when the new exchange didn't return
        // one (Google in particular only emits it on first consent).
        refreshTokenEncrypted:
          enc.refreshTokenEncrypted ?? undefined,
        expiresAt: args.expiresAt,
        scope: args.scope,
        updatedAt: new Date(),
      })
      .where(eq(userEmailConnections.id, existing[0].id));
  } else {
    await db.insert(userEmailConnections).values({
      clerkUserId: args.clerkUserId,
      provider: args.provider,
      emailAddress: args.emailAddress,
      accessTokenEncrypted: enc.accessTokenEncrypted,
      refreshTokenEncrypted: enc.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      scope: args.scope,
    });
  }
}

export async function listConnections(
  clerkUserId: string,
): Promise<DecryptedConnection[]> {
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
    accessToken: decryptToken(r.accessTokenEncrypted),
    refreshToken: r.refreshTokenEncrypted
      ? decryptToken(r.refreshTokenEncrypted)
      : null,
    expiresAt: r.expiresAt,
    scope: r.scope,
    lastSyncAt: r.lastSyncAt,
  }));
}

export async function getConnection(
  clerkUserId: string,
  provider: EmailProvider,
): Promise<DecryptedConnection | null> {
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
    accessToken: decryptToken(r.accessTokenEncrypted),
    refreshToken: r.refreshTokenEncrypted
      ? decryptToken(r.refreshTokenEncrypted)
      : null,
    expiresAt: r.expiresAt,
    scope: r.scope,
    lastSyncAt: r.lastSyncAt,
  };
}

export async function getPrimaryConnection(
  clerkUserId: string,
): Promise<DecryptedConnection | null> {
  const all = await listConnections(clerkUserId);
  if (!all.length) return null;
  // Most recently updated wins. Users typically connect one provider;
  // for the rare both-connected case, the freshest wins.
  return all.sort(
    (a, b) => b.expiresAt.getTime() - a.expiresAt.getTime(),
  )[0];
}

export async function deleteConnection(
  clerkUserId: string,
  provider: EmailProvider,
): Promise<void> {
  await ensureEmailConnectionsSchema();
  await db
    .delete(userEmailConnections)
    .where(
      and(
        eq(userEmailConnections.clerkUserId, clerkUserId),
        eq(userEmailConnections.provider, provider),
      ),
    );
}

// ---- OAuth token exchange + refresh -------------------------------------

export async function exchangeCodeForTokens(args: {
  provider: EmailProvider;
  code: string;
  request: Request;
}): Promise<TokenResponse> {
  const cfg = providerConfig(args.provider);
  const body = new URLSearchParams({
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
    code: args.code,
    redirect_uri: redirectUri(args.provider, args.request),
    grant_type: "authorization_code",
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Token exchange failed (${args.provider}, ${res.status}): ${txt}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(args: {
  provider: EmailProvider;
  refreshToken: string;
}): Promise<TokenResponse> {
  const cfg = providerConfig(args.provider);
  const body = new URLSearchParams({
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Token refresh failed (${args.provider}, ${res.status}): ${txt}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

// Returns a valid access token, refreshing if necessary. Updates the
// stored row in place so the next call doesn't pay the refresh cost.
const REFRESH_LEEWAY_MS = 60_000; // refresh 60s before actual expiry

export async function getValidAccessToken(
  conn: DecryptedConnection,
): Promise<string> {
  const now = Date.now();
  if (conn.expiresAt.getTime() - now > REFRESH_LEEWAY_MS) {
    return conn.accessToken;
  }
  if (!conn.refreshToken) {
    throw new Error(
      `Email connection for ${conn.emailAddress} is expired and has no refresh token. Please reconnect.`,
    );
  }
  const fresh = await refreshAccessToken({
    provider: conn.provider,
    refreshToken: conn.refreshToken,
  });
  const newExpiresAt = new Date(now + fresh.expires_in * 1000);
  await upsertConnection({
    clerkUserId: conn.clerkUserId,
    provider: conn.provider,
    emailAddress: conn.emailAddress,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token ?? conn.refreshToken,
    expiresAt: newExpiresAt,
    scope: fresh.scope ?? conn.scope,
  });
  return fresh.access_token;
}

// Resolve the email address from the just-issued tokens by calling the
// provider's userinfo endpoint. We need this because the OAuth response
// itself doesn't always include the address (Microsoft tucks it inside
// the id_token JWT; Google returns it on /userinfo).
export async function fetchEmailAddress(args: {
  provider: EmailProvider;
  accessToken: string;
}): Promise<string> {
  if (args.provider === "microsoft") {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch Microsoft profile (${res.status}): ${await res.text()}`,
      );
    }
    const data = (await res.json()) as {
      mail?: string;
      userPrincipalName?: string;
    };
    const addr = data.mail || data.userPrincipalName;
    if (!addr) throw new Error("Microsoft profile returned no email address");
    return addr;
  }
  const res = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Google profile (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("Google userinfo returned no email");
  return data.email;
}
