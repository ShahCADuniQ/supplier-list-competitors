// Single Nylas hosted-auth callback. The provider (Outlook / Gmail) is
// resolved from the Nylas token-exchange response — see oauth-callback.

import { handleOAuthCallback } from "@/lib/email/oauth-callback";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleOAuthCallback(request);
}
