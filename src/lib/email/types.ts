// Shared types for the per-user email integration. Kept separate so
// providers.ts, the route handlers, and the transport layer can all
// import without creating cycles.

export type EmailProvider = "microsoft" | "google";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type EmailAddress =
  | string
  | { email: string; name?: string };

export type EmailAttachment = {
  filename: string;
  content?: string; // base64
  path?: string; // URL we fetch + inline
  contentType?: string;
};

export type SendEmailInput = {
  // Clerk user id of the SENDER. We dispatch through this user's
  // connected mailbox (Outlook or Gmail) — no shared "service" address.
  fromUserId: string;
  to: EmailAddress | EmailAddress[];
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
};

export type SendEmailResult = {
  id: string;
  provider: EmailProvider;
  // True when actually dispatched. False = dev stub (composer hasn't
  // connected an account yet) — caller can decide to still record the
  // outbound row for audit + show a "connect email" banner.
  sent: boolean;
};
