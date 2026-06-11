// Surface to /settings which OAuth env vars are still missing,
// so the page can show a clear "needs setup" panel instead of letting
// the user click Connect → 500. Reads-only, no secrets returned — just
// booleans flagging which keys are blank.

import type { EmailProvider } from "@/lib/email/types";

export type SetupStatus = {
  encryptionKey: boolean;
  microsoft: { clientId: boolean; clientSecret: boolean };
  google: { clientId: boolean; clientSecret: boolean };
};

export async function getEmailSetupStatus(): Promise<SetupStatus> {
  return {
    encryptionKey: !!process.env.EMAIL_TOKEN_ENCRYPTION_KEY,
    microsoft: {
      clientId: !!process.env.MICROSOFT_OAUTH_CLIENT_ID,
      clientSecret: !!process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    },
    google: {
      clientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
  };
}

export function isProviderReady(
  status: SetupStatus,
  provider: EmailProvider,
): boolean {
  if (!status.encryptionKey) return false;
  if (provider === "microsoft") {
    return status.microsoft.clientId && status.microsoft.clientSecret;
  }
  return status.google.clientId && status.google.clientSecret;
}
