// Google (Gmail) OAuth callback. Mirrors the Microsoft callback — see
// @/lib/email/oauth-callback for the shared logic.

import { handleOAuthCallback } from "@/lib/email/oauth-callback";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleOAuthCallback(request, "google");
}
