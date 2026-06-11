// Detect which email provider a user's address belongs to so we can
// pre-select Outlook vs Gmail and skip the chooser on Nylas's hosted
// auth screen. Covers the obvious consumer domains; corporate domains
// can be added to CORPORATE_DOMAIN_OVERRIDES as we encounter them.
//
// When detection fails, callers should show both options and let the
// user pick. Nylas's hosted UI handles the actual provider redirect
// either way, so detection is purely a UX optimisation.

import type { EmailProvider } from "./types";

const MICROSOFT_CONSUMER_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "outlook.co.uk",
  "hotmail.co.uk",
  "live.co.uk",
  "passport.com",
]);

const GOOGLE_CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
]);

// Corporate / org domains where we know the MX provider in advance.
// Populate as we onboard new tenants. The Manage Account flow falls back
// to "let the user choose" gracefully when a domain isn't listed.
const CORPORATE_DOMAIN_OVERRIDES: Record<string, EmailProvider> = {
  "lightbase.ca": "microsoft",
  "caduniq.com": "microsoft",
};

export function detectEmailProvider(email: string | null | undefined): EmailProvider | null {
  if (!email) return null;
  const domain = email.split("@").pop()?.toLowerCase().trim();
  if (!domain) return null;
  if (MICROSOFT_CONSUMER_DOMAINS.has(domain)) return "microsoft";
  if (GOOGLE_CONSUMER_DOMAINS.has(domain)) return "google";
  if (CORPORATE_DOMAIN_OVERRIDES[domain]) {
    return CORPORATE_DOMAIN_OVERRIDES[domain];
  }
  return null;
}
