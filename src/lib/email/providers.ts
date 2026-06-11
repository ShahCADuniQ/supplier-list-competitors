// Per-provider OAuth + API configuration for the email integration.
//
// We support two providers — Microsoft (Outlook / Microsoft 365 via
// Microsoft Graph) and Google (Gmail). Each user connects their own
// account; outbound RFQ mail is dispatched through the composer's
// connected account, and the same tokens are reused to read inbox
// messages for the home-page summariser.
//
// Env vars (set in .env):
//
//   MICROSOFT_OAUTH_CLIENT_ID       Azure AD App Registration client id
//   MICROSOFT_OAUTH_CLIENT_SECRET   Azure AD App Registration secret
//   MICROSOFT_OAUTH_TENANT          "common" (multi-tenant) or a tenant id
//
//   GOOGLE_OAUTH_CLIENT_ID          GCP OAuth 2.0 client id
//   GOOGLE_OAUTH_CLIENT_SECRET      GCP OAuth 2.0 client secret
//
//   APP_BASE_URL                    Public origin of this app, used to
//                                   build the OAuth redirect URI. Falls
//                                   back to NEXT_PUBLIC_APP_URL or the
//                                   request origin when not set.

import type { EmailProvider } from "./types";

export type ProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  // For Microsoft we need offline_access to get a refresh token; Google
  // requires access_type=offline + prompt=consent. These flags drive the
  // start-route's URL builder.
  extraAuthParams?: Record<string, string>;
  clientId: () => string;
  clientSecret: () => string;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Configure it in .env to enable email OAuth.`,
    );
  }
  return v;
}

const MICROSOFT: ProviderConfig = {
  // "common" lets users from any Azure AD tenant + personal MS accounts
  // sign in. Single-tenant deployments can override via env.
  authorizeUrl: `https://login.microsoftonline.com/${process.env.MICROSOFT_OAUTH_TENANT || "common"}/oauth2/v2.0/authorize`,
  tokenUrl: `https://login.microsoftonline.com/${process.env.MICROSOFT_OAUTH_TENANT || "common"}/oauth2/v2.0/token`,
  scopes: [
    "openid",
    "email",
    "profile",
    "offline_access",
    "User.Read",
    "Mail.Read",
    "Mail.Send",
  ],
  extraAuthParams: {
    response_mode: "query",
    prompt: "select_account",
  },
  clientId: () => required("MICROSOFT_OAUTH_CLIENT_ID"),
  clientSecret: () => required("MICROSOFT_OAUTH_CLIENT_SECRET"),
};

const GOOGLE: ProviderConfig = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  extraAuthParams: {
    access_type: "offline",
    // prompt=consent guarantees Google issues a refresh_token even when
    // the user has already approved this app — without it, repeat
    // authorisations only return an access token, which expires.
    prompt: "consent",
    include_granted_scopes: "true",
  },
  clientId: () => required("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: () => required("GOOGLE_OAUTH_CLIENT_SECRET"),
};

export function providerConfig(p: EmailProvider): ProviderConfig {
  return p === "microsoft" ? MICROSOFT : GOOGLE;
}

export function redirectUri(provider: EmailProvider, request: Request): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(request.url).origin;
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/api/email/oauth/${provider}/callback`;
}
