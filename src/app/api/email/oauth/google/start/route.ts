// Google (Gmail) OAuth start. Shared logic lives in
// @/lib/email/oauth-start — falls back to a friendly diagnostic page
// when env vars are missing.

import { handleOAuthStart } from "@/lib/email/oauth-start";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleOAuthStart(request, "google");
}
