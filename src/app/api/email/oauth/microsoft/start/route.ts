// Kick off the Microsoft (Outlook / Microsoft 365) OAuth flow. Builds
// the authorize URL with our scopes, plants a signed state cookie, and
// 302s the user over to Microsoft. The matching callback at
// /api/email/oauth/microsoft/callback verifies state and stores tokens.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { providerConfig, redirectUri } from "@/lib/email/providers";
import { signState, STATE_COOKIE } from "@/lib/email/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  const cfg = providerConfig("microsoft");
  const state = signState({ u: userId, p: "microsoft" });
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri("microsoft", request));
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
