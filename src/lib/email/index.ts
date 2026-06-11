// Per-user transactional email transport.
//
// Each user connects their own Outlook (Microsoft Graph) or Gmail
// account via OAuth — see /api/email/oauth/{microsoft,google}/start —
// and outbound mail (RFQ emails, supplier invites, procurement routing)
// flows through THAT user's mailbox. There is no shared sender; the
// supplier sees the buyer's real address.
//
// When the composer hasn't connected an account, sendEmail logs the
// payload and returns a dev-stub result so the rest of the pipeline
// (status transitions, audit rows) still works. The caller can decide
// to surface a "connect email" banner.
//
// Required env (only for actual delivery — dev stub needs nothing):
//
//   MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_CLIENT_ID    / GOOGLE_OAUTH_CLIENT_SECRET
//   EMAIL_TOKEN_ENCRYPTION_KEY (also signs OAuth state cookies)

import { sendGmail } from "./transport-gmail";
import { sendGraphMail } from "./transport-graph";
import {
  getPrimaryConnection,
  getValidAccessToken,
} from "./connections";
import type {
  EmailAddress,
  SendEmailInput,
  SendEmailResult,
} from "./types";

export type {
  EmailAddress,
  EmailAttachment,
  SendEmailInput,
  SendEmailResult,
} from "./types";

export function formatAddress(addr: EmailAddress): string {
  if (typeof addr === "string") return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const conn = await getPrimaryConnection(input.fromUserId);

  if (!conn) {
    // Dev fallback — no connected mailbox. Log + return stub so the
    // rest of the pipeline keeps working in development. Production
    // callers should check hasUserEmailConnection() before composing.
    const to = Array.isArray(input.to)
      ? input.to.map(formatAddress)
      : [formatAddress(input.to)];
    console.warn(
      "[email] User has no connected mailbox — logging instead of sending.",
      {
        fromUserId: input.fromUserId,
        to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.text.slice(0, 400),
        attachments: input.attachments?.length ?? 0,
      },
    );
    return {
      id: `dev-${crypto.randomUUID()}`,
      provider: "microsoft",
      sent: false,
    };
  }

  const accessToken = await getValidAccessToken(conn);
  if (conn.provider === "microsoft") {
    const id = await sendGraphMail({
      accessToken,
      fromAddress: conn.emailAddress,
      input,
    });
    return { id, provider: "microsoft", sent: true };
  }
  const id = await sendGmail({
    accessToken,
    fromAddress: conn.emailAddress,
    input,
  });
  return { id, provider: "google", sent: true };
}

// True when the user has at least one connected mailbox. Cheap (no API
// call) — used by the compose dialog to decide whether to show a
// "Connect email" banner.
export async function hasUserEmailConnection(
  clerkUserId: string,
): Promise<boolean> {
  const conn = await getPrimaryConnection(clerkUserId);
  return !!conn;
}

export async function userEmailStatus(clerkUserId: string): Promise<{
  configured: boolean;
  provider: "microsoft" | "google" | null;
  fromAddress: string | null;
}> {
  const conn = await getPrimaryConnection(clerkUserId);
  if (!conn) {
    return { configured: false, provider: null, fromAddress: null };
  }
  return {
    configured: true,
    provider: conn.provider,
    fromAddress: conn.emailAddress,
  };
}
