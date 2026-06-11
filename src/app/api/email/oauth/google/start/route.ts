// Kick off the Google (Gmail) OAuth flow. Mirrors the Microsoft start
// route — only the provider id and scope list differ. See providers.ts
// for the access_type=offline + prompt=consent quirks that ensure we
// actually receive a refresh_token.

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
  const cfg = providerConfig("google");
  const state = signState({ u: userId, p: "google" });
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri("google", request));
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
