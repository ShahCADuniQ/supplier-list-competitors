// Kick off the Nylas hosted-auth flow for a given provider hint
// (microsoft|google). Nylas's consent UI handles the provider-specific
// OAuth dance and bounces back to our single /api/email/oauth/callback.
//
// Falls back to a friendly diagnostic HTML page when the Nylas env
// vars aren't set yet, instead of throwing 500.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { buildAuthUrl } from "./nylas";
import { signState, STATE_COOKIE } from "./oauth-state";
import { getOrCreateProfile, isCaduniqUser } from "@/lib/permissions";
import { isTenantApproved } from "./integration-requests";
import type { EmailProvider } from "./types";

function notApproved(provider: EmailProvider): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.55;color:#111">
      <h1 style="font-size:22px;margin:0 0 12px">Awaiting CADuniQ approval</h1>
      <p>Your company has to be approved by CADuniQ HQ before users can connect their ${provider === "microsoft" ? "Outlook" : "Gmail"} mailbox.</p>
      <p>Your company administrator can request the integration from the home page; CADuniQ usually decides within a business day.</p>
      <p style="margin-top:24px"><a href="/">← Back to home</a></p>
    </body></html>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function diagnostic(provider: EmailProvider, missing: string[]): Response {
  const items = missing.map((m) => `<li><code>${m}</code></li>`).join("");
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.55;color:#111">
      <h1 style="font-size:22px;margin:0 0 12px">Can&apos;t connect ${provider === "microsoft" ? "Outlook" : "Gmail"} yet</h1>
      <p>Nylas isn&apos;t fully configured. Add the following to <code>.env</code> on the server and restart:</p>
      <ul>${items}</ul>
      <p>See <code>docs/rfq-email.md</code> for the Nylas dashboard walkthrough.</p>
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
  if (!process.env.EMAIL_TOKEN_ENCRYPTION_KEY)
    missing.push("EMAIL_TOKEN_ENCRYPTION_KEY");
  if (!process.env.NYLAS_CLIENT_ID) missing.push("NYLAS_CLIENT_ID");
  if (!process.env.NYLAS_API_KEY) missing.push("NYLAS_API_KEY");
  if (missing.length) return diagnostic(provider, missing);

  // Tenant gate: only tenants CADuniQ HQ has approved can run the Nylas
  // flow. CADuniQ staff bypass the gate so they can dogfood without
  // approving themselves.
  const profile = await getOrCreateProfile();
  if (profile && !isCaduniqUser(profile)) {
    if (profile.clientId == null) {
      return notApproved(provider);
    }
    if (!(await isTenantApproved(profile.clientId))) {
      return notApproved(provider);
    }
  }

  const state = signState({ u: userId, p: provider });
  const loginHint = new URL(request.url).searchParams.get("email") ?? undefined;
  const url = buildAuthUrl({ provider, request, state, loginHint });

  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  redirect(url);
}
