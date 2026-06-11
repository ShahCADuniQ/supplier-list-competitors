// Microsoft (Outlook / Microsoft 365) OAuth callback. Delegates the
// real work to the shared handler in @/lib/email/oauth-callback so the
// two providers stay in lock-step.

import { handleOAuthCallback } from "@/lib/email/oauth-callback";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleOAuthCallback(request, "microsoft");
}
