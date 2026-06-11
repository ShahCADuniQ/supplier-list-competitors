// Surface to /settings which Nylas env vars are still missing, so the
// page can show a clear "needs setup" panel instead of letting the user
// click Connect → 500. Reads-only, no secrets returned — just booleans
// flagging which keys are blank.

export type SetupStatus = {
  encryptionKey: boolean;
  nylas: { clientId: boolean; apiKey: boolean };
};

export async function getEmailSetupStatus(): Promise<SetupStatus> {
  return {
    encryptionKey: !!process.env.EMAIL_TOKEN_ENCRYPTION_KEY,
    nylas: {
      clientId: !!process.env.NYLAS_CLIENT_ID,
      apiKey: !!process.env.NYLAS_API_KEY,
    },
  };
}

export function isProviderReady(status: SetupStatus): boolean {
  return status.encryptionKey && status.nylas.clientId && status.nylas.apiKey;
}
