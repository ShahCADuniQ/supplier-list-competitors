// Thin Nylas v3 API client. We use Nylas as the unified Gmail + Outlook
// gateway: their hosted-auth flow handles the per-provider OAuth dance,
// they hand us a long-lived `grant_id` per connected mailbox, and the
// same grant lets us read + send through one HTTPS surface.
//
// Required env:
//   NYLAS_CLIENT_ID   Public client id from the Nylas dashboard.
//   NYLAS_API_KEY     Server-side API key (Authorization: Bearer ...).
//   NYLAS_API_URI     Region base, e.g. https://api.us.nylas.com (default)
//                     or https://api.eu.nylas.com for EU tenants.
//   APP_BASE_URL      Origin of this app; used to build the redirect_uri
//                     that's whitelisted in the Nylas dashboard. Falls
//                     back to NEXT_PUBLIC_APP_URL or the request origin.

import type { EmailProvider } from "./types";

export type NylasTokenExchange = {
  grant_id: string;
  email: string;
  provider: "google" | "microsoft" | "imap";
  scope?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
};

export type NylasMessage = {
  id: string;
  grant_id: string;
  date: number; // unix seconds
  subject: string;
  snippet: string;
  thread_id: string;
  from?: Array<{ name?: string; email: string }>;
  to?: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  body?: string;
  unread?: boolean;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Configure it in .env to enable email integration via Nylas.`,
    );
  }
  return v;
}

function apiBase(): string {
  return (process.env.NYLAS_API_URI || "https://api.us.nylas.com").replace(
    /\/$/,
    "",
  );
}

export function nylasClientId(): string {
  return required("NYLAS_CLIENT_ID");
}

export function nylasApiKey(): string {
  return required("NYLAS_API_KEY");
}

export function redirectUri(request: Request): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(request.url).origin;
  const trimmed = base.replace(/\/$/, "");
  // One callback for both providers; Nylas tells us which provider was
  // selected in the token exchange response.
  return `${trimmed}/api/email/oauth/callback`;
}

// Build the hosted-auth URL. provider hint maps to Nylas's provider
// parameter so the user lands directly on Google or Microsoft instead
// of seeing Nylas's chooser screen.
export function buildAuthUrl(args: {
  provider: EmailProvider;
  request: Request;
  state: string;
  loginHint?: string;
}): string {
  const url = new URL(`${apiBase()}/v3/connect/auth`);
  url.searchParams.set("client_id", nylasClientId());
  url.searchParams.set("redirect_uri", redirectUri(args.request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("provider", args.provider);
  url.searchParams.set("state", args.state);
  if (args.loginHint) url.searchParams.set("login_hint", args.loginHint);
  return url.toString();
}

export async function exchangeCodeForGrant(args: {
  code: string;
  request: Request;
}): Promise<NylasTokenExchange> {
  const res = await fetch(`${apiBase()}/v3/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nylasApiKey()}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      client_id: nylasClientId(),
      client_secret: nylasApiKey(),
      redirect_uri: redirectUri(args.request),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Nylas token exchange failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as NylasTokenExchange;
}

export async function revokeGrant(grantId: string): Promise<void> {
  // Delete the grant on Nylas's side so we don't keep paying for it after
  // a user disconnects. Best-effort: any error is logged but not thrown,
  // because the local row gets deleted regardless.
  try {
    const res = await fetch(`${apiBase()}/v3/grants/${grantId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${nylasApiKey()}` },
    });
    if (!res.ok && res.status !== 404) {
      console.warn(
        `[nylas] revokeGrant ${grantId} returned ${res.status}: ${await res.text()}`,
      );
    }
  } catch (e) {
    console.warn(`[nylas] revokeGrant ${grantId} failed:`, e);
  }
}

// ---- Send / read ---------------------------------------------------------

export type NylasSendInput = {
  grantId: string;
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  replyTo?: Array<{ email: string; name?: string }>;
  subject: string;
  body: string; // text/html; Nylas auto-detects
  attachments?: Array<{
    filename: string;
    content_type?: string;
    content: string; // base64
  }>;
};

export async function sendMessage(input: NylasSendInput): Promise<{
  id: string;
  thread_id?: string;
}> {
  const res = await fetch(
    `${apiBase()}/v3/grants/${input.grantId}/messages/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nylasApiKey()}`,
      },
      body: JSON.stringify({
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        reply_to: input.replyTo,
        subject: input.subject,
        body: input.body,
        attachments: input.attachments,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Nylas send failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    data?: { id: string; thread_id?: string };
  };
  return data.data ?? { id: "" };
}

export async function listMessages(args: {
  grantId: string;
  limit?: number;
  unreadOnly?: boolean;
}): Promise<NylasMessage[]> {
  const url = new URL(`${apiBase()}/v3/grants/${args.grantId}/messages`);
  url.searchParams.set("limit", String(args.limit ?? 20));
  if (args.unreadOnly) url.searchParams.set("unread", "true");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${nylasApiKey()}` },
  });
  if (!res.ok) {
    throw new Error(
      `Nylas listMessages failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { data?: NylasMessage[] };
  return data.data ?? [];
}
