// Shared OAuth callback logic for /api/email/oauth/{microsoft,google}/callback.
// The two routes are 99% identical; only the provider id changes.

import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import {
  exchangeCodeForTokens,
  fetchEmailAddress,
  upsertConnection,
} from "./connections";
import { STATE_COOKIE, verifyState } from "./oauth-state";
import type { EmailProvider } from "./types";

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:32px;line-height:1.5">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function handleOAuthCallback(
  request: Request,
  provider: EmailProvider,
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return html("<h1>Sign in required</h1>", 401);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (error) {
    return html(
      `<h1>Authorisation failed</h1><p>${error}</p><p>${errorDesc ?? ""}</p><p><a href="/settings#email">Back to settings</a></p>`,
      400,
    );
  }
  if (!code || !stateParam) {
    return html("<h1>Missing code or state parameter</h1>", 400);
  }

  const jar = await cookies();
  const cookieState = jar.get(STATE_COOKIE)?.value;
  if (!cookieState || cookieState !== stateParam) {
    return html(
      "<h1>State mismatch</h1><p>The OAuth state cookie did not match the callback. Please start the connection again.</p>",
      400,
    );
  }
  const verified = verifyState(stateParam);
  if (!verified) {
    return html("<h1>State is invalid or expired</h1>", 400);
  }
  if (verified.u !== userId) {
    return html(
      "<h1>User mismatch</h1><p>The signed-in user does not match the user who started this OAuth flow.</p>",
      400,
    );
  }
  if (verified.p !== provider) {
    return html("<h1>Provider mismatch</h1>", 400);
  }

  try {
    const tokens = await exchangeCodeForTokens({
      provider,
      code,
      request,
    });
    const emailAddress = await fetchEmailAddress({
      provider,
      accessToken: tokens.access_token,
    });
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await upsertConnection({
      clerkUserId: userId,
      provider,
      emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      scope: tokens.scope ?? null,
    });
    jar.delete(STATE_COOKIE);
    return new Response(null, {
      status: 302,
      headers: { Location: "/settings?connected=" + provider + "#email" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(
      `<h1>Could not finish connecting</h1><pre style="white-space:pre-wrap">${msg.replace(/</g, "&lt;")}</pre><p><a href="/settings#email">Back to settings</a></p>`,
      500,
    );
  }
}
