// Centralised transactional email transport.
//
// All outbound mail (RFQ emails, supplier invites, procurement routing,
// future password resets) goes through here so we keep one place to swap
// providers, throttle, add headers, or fall back when an API key isn't
// configured.
//
// Configuration (set in .env):
//
//   RESEND_API_KEY        Resend API key (re_xxx). Required to actually
//                         deliver mail. Without it, sendEmail() logs the
//                         payload to console + returns a dev "stub" id so
//                         the rest of the pipeline keeps working in
//                         development.
//   EMAIL_FROM_ADDRESS    Verified sender (e.g. "rfq@caduniq.com").
//                         Default: "rfq@caduniq.com"
//   EMAIL_FROM_NAME       Friendly name on the From header.
//                         Default: "CADuniQ"
//   EMAIL_REPLY_TO        Default Reply-To when the caller doesn't pass
//                         one. Usually a user's real address. Optional.

import { Resend } from "resend";

export type EmailAddress =
  | string
  | { email: string; name?: string };

function formatAddress(addr: EmailAddress): string {
  if (typeof addr === "string") return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

export type EmailAttachment = {
  filename: string;
  // Either content (base64) or a public URL Resend can fetch.
  content?: string;
  path?: string;
  contentType?: string;
};

export type SendEmailInput = {
  to: EmailAddress | EmailAddress[];
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  replyTo?: string;
  from?: EmailAddress;
  subject: string;
  // Plain text body. Required.
  text: string;
  // HTML body. Optional — when omitted, Resend uses the text body alone.
  html?: string;
  attachments?: EmailAttachment[];
  // Custom headers — useful for threading / unsubscribe / tagging.
  headers?: Record<string, string>;
};

export type SendEmailResult = {
  id: string;
  // True when the email actually went out via the provider.
  // False = dev stub (no API key configured).
  sent: boolean;
};

export function hasEmailTransport(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export function defaultFromAddress(): string {
  const addr = process.env.EMAIL_FROM_ADDRESS || "rfq@caduniq.com";
  const name = process.env.EMAIL_FROM_NAME || "CADuniQ";
  return `${name} <${addr}>`;
}

let _resend: Resend | null = null;
function client(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY not configured");
    _resend = new Resend(key);
  }
  return _resend;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const to = Array.isArray(input.to)
    ? input.to.map(formatAddress)
    : [formatAddress(input.to)];

  // Dev fallback: no API key → log + return stub so the rest of the
  // pipeline (status transitions, audit rows) keeps working in
  // development without a Resend account.
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "[email] No RESEND_API_KEY configured — logging the email instead of sending.",
      {
        from: input.from ? formatAddress(input.from) : defaultFromAddress(),
        to,
        cc: input.cc,
        bcc: input.bcc,
        replyTo: input.replyTo ?? process.env.EMAIL_REPLY_TO ?? null,
        subject: input.subject,
        body: input.text.slice(0, 400),
        attachments: input.attachments?.length ?? 0,
      },
    );
    return { id: `dev-${crypto.randomUUID()}`, sent: false };
  }

  const result = await client().emails.send({
    from: input.from ? formatAddress(input.from) : defaultFromAddress(),
    to,
    cc: input.cc
      ? (Array.isArray(input.cc) ? input.cc : [input.cc]).map(formatAddress)
      : undefined,
    bcc: input.bcc
      ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]).map(formatAddress)
      : undefined,
    replyTo: input.replyTo ?? process.env.EMAIL_REPLY_TO ?? undefined,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
    headers: input.headers,
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "", sent: true };
}
