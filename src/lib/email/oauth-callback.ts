// Single OAuth callback for the Nylas hosted-auth flow. Nylas redirects
// here for BOTH Outlook and Gmail (one redirect URI whitelisted in the
// dashboard); the signed state cookie tells us which provider the user
// originally chose and which Clerk user owns the grant.

import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { upsertConnection } from "./connections";
import { exchangeCodeForGrant } from "./nylas";
import { STATE_COOKIE, verifyState } from "./oauth-state";

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:32px;line-height:1.5">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function handleOAuthCallback(
  request: Request,
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

  try {
    const exchange = await exchangeCodeForGrant({ code, request });
    // Map Nylas's provider hint back to our enum. IMAP is unlikely here
    // (we only ever request microsoft/google), but if it shows up we
    // default it to google so it still stores cleanly.
    const provider =
      exchange.provider === "microsoft" ? "microsoft" : "google";
    await upsertConnection({
      clerkUserId: userId,
      provider,
      emailAddress: exchange.email,
      grantId: exchange.grant_id,
      scope: exchange.scope ?? null,
    });
    jar.delete(STATE_COOKIE);
    return new Response(null, {
      status: 302,
      headers: { Location: `/settings?connected=${provider}#email` },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(
      `<h1>Could not finish connecting</h1><pre style="white-space:pre-wrap">${msg.replace(/</g, "&lt;")}</pre><p><a href="/settings#email">Back to settings</a></p>`,
      500,
    );
  }
}
