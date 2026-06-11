// Shared start-route logic for /api/email/oauth/{microsoft,google}/start.
// Falls back to a friendly diagnostic page instead of throwing 500 when
// the OAuth env vars aren't configured yet.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { providerConfig, redirectUri } from "./providers";
import { signState, STATE_COOKIE } from "./oauth-state";
import type { EmailProvider } from "./types";

function diagnostic(provider: EmailProvider, missing: string[]): Response {
  const items = missing.map((m) => `<li><code>${m}</code></li>`).join("");
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.55;color:#111">
      <h1 style="font-size:22px;margin:0 0 12px">Can&apos;t connect ${provider === "microsoft" ? "Outlook" : "Gmail"} yet</h1>
      <p>The server is missing OAuth credentials for this provider. Add the following to <code>.env</code> and restart <code>next dev</code>:</p>
      <ul>${items}</ul>
      <p>See <code>docs/rfq-email.md</code> for the Azure / Google Cloud setup walkthrough.</p>
      <p style="margin-top:24px"><a href="/settings#email">← Back to Manage Account</a></p>
    </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function handleOAuthStart(
  request: Request,
  provider: EmailProvider,
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }

  const missing: string[] = [];
  if (!process.env.EMAIL_TOKEN_ENCRYPTION_KEY) {
    missing.push("EMAIL_TOKEN_ENCRYPTION_KEY");
  }
  if (provider === "microsoft") {
    if (!process.env.MICROSOFT_OAUTH_CLIENT_ID)
      missing.push("MICROSOFT_OAUTH_CLIENT_ID");
    if (!process.env.MICROSOFT_OAUTH_CLIENT_SECRET)
      missing.push("MICROSOFT_OAUTH_CLIENT_SECRET");
  } else {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID)
      missing.push("GOOGLE_OAUTH_CLIENT_ID");
    if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET)
      missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  }
  if (missing.length) return diagnostic(provider, missing);

  const cfg = providerConfig(provider);
  const state = signState({ u: userId, p: provider });
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(provider, request));
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) {
    url.searchParams.set(k, v);
  }
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  redirect(url.toString());
}
