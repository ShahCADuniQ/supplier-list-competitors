// Per-user transactional email transport, backed by Nylas.
//
// Each user connects their own Outlook (Microsoft Graph) or Gmail
// account through Nylas's hosted-auth flow at /api/email/oauth/{microsoft,google}/start.
// After consent Nylas hands us a long-lived `grant_id` which we
// encrypt + store. Outbound RFQ mail flows through that grant via
// Nylas's send API, so the supplier sees the buyer's real address.
// The same grant is used to read inbox messages for summarisation.
//
// When the composer hasn't connected an account, sendEmail logs the
// payload and returns a dev-stub result so the rest of the pipeline
// (status transitions, audit rows) still works.

import {
  getPrimaryConnection,
} from "./connections";
import { sendMessage } from "./nylas";
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

function toNylasAddress(
  a: EmailAddress,
): { email: string; name?: string } {
  if (typeof a === "string") return { email: a };
  return { email: a.email, name: a.name };
}

function toList(
  a: EmailAddress | EmailAddress[] | undefined,
): Array<{ email: string; name?: string }> | undefined {
  if (!a) return undefined;
  return (Array.isArray(a) ? a : [a]).map(toNylasAddress);
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const conn = await getPrimaryConnection(input.fromUserId);

  if (!conn) {
    const to = Array.isArray(input.to)
      ? input.to.map((a) => (typeof a === "string" ? a : a.email))
      : [typeof input.to === "string" ? input.to : input.to.email];
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

  // Inline-fetch attachments (when given as URLs) so Nylas gets a
  // base64 blob it can upload. For tiny RFQ emails this is fine; large
  // attachments should switch to the multipart upload endpoint later.
  const nylasAttachments = input.attachments
    ? await Promise.all(
        input.attachments.map(async (att) => {
          let content = att.content;
          let contentType = att.contentType ?? "application/octet-stream";
          if (!content && att.path) {
            const r = await fetch(att.path);
            if (!r.ok) {
              throw new Error(
                `Could not fetch attachment ${att.filename}: ${r.status}`,
              );
            }
            content = Buffer.from(await r.arrayBuffer()).toString("base64");
            contentType =
              att.contentType ??
              r.headers.get("content-type") ??
              "application/octet-stream";
          }
          return {
            filename: att.filename,
            content_type: contentType,
            content: content ?? "",
          };
        }),
      )
    : undefined;

  const toAddrs = toList(input.to) ?? [];
  const result = await sendMessage({
    grantId: conn.grantId,
    to: toAddrs,
    cc: toList(input.cc),
    bcc: toList(input.bcc),
    replyTo: input.replyTo ? [{ email: input.replyTo }] : undefined,
    subject: input.subject,
    body: input.html ?? input.text,
    attachments: nylasAttachments,
  });

  return { id: result.id, provider: conn.provider, sent: true };
}

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
