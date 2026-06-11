# RFQ Email — setup

The "Send RFQ via email" flow lives at `Orders → RFQ detail → recipient row → ✉ Email`. Procurement-routed drafts queue up at `Orders → ⌛ Procurement review`.

The transport layer (`src/lib/email/index.ts`) dispatches **through the composer's own connected mailbox** — Outlook (Microsoft Graph) or Gmail. Each user connects their account once at `/settings/email`; suppliers then see the buyer's real address on the From line, and we can read their inbox for the home-page summariser. When the composer hasn't connected a mailbox yet, every call **logs to the server console** and the workflow keeps working in dev mode.

## Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `MICROSOFT_OAUTH_CLIENT_ID` | for Outlook | — | Azure AD App Registration client id. |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | for Outlook | — | App Registration client secret value. |
| `MICROSOFT_OAUTH_TENANT` | optional | `common` | `common` allows any Azure AD tenant + personal MS accounts; set to a tenant id for single-tenant. |
| `GOOGLE_OAUTH_CLIENT_ID` | for Gmail | — | Google Cloud OAuth 2.0 client id. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for Gmail | — | Google Cloud OAuth 2.0 client secret. |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | required for either | — | Any long random string (≥16 chars). Hashed with SHA-256 to a 32-byte AES key. Also signs the OAuth state cookie. |
| `APP_BASE_URL` | recommended | request origin | Public origin of the app; used to build the OAuth redirect URI. Falls back to `NEXT_PUBLIC_APP_URL`. |
| `PROCUREMENT_EMAIL` | optional | `imendo@lightbase.ca` | Comma-separated. Where the heads-up email goes when a draft is routed via procurement. |
| `PROCUREMENT_NAME` | optional | `Procurement` | Friendly name on that heads-up email. |
| `NEXT_PUBLIC_APP_URL` | recommended | — | Used to build absolute review/portal URLs in the email bodies. |
| `ANTHROPIC_API_KEY` | optional | — | Used by `buildAiSummary` to add a plain-language summary to the email for unregistered suppliers. |

## OAuth app setup (one-time)

### Microsoft (Outlook / 365)
1. Azure portal → **App registrations** → New registration.
2. Redirect URI (Web): `${APP_BASE_URL}/api/email/oauth/microsoft/callback`.
3. **Certificates & secrets** → New client secret → copy the **value**.
4. **API permissions** → Add → Microsoft Graph → Delegated:
   - `Mail.Read`, `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email`, `profile`.
5. Set `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, and `MICROSOFT_OAUTH_TENANT` (leave as `common` unless single-tenant).

### Google (Gmail / Workspace)
1. Google Cloud Console → **APIs & Services** → Enable **Gmail API**.
2. **OAuth consent screen** → External (or Internal for Workspace), add the Gmail scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `openid`, `email`, `profile`.
3. **Credentials** → Create OAuth client → Web application.
4. Authorised redirect URI: `${APP_BASE_URL}/api/email/oauth/google/callback`.
5. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

### Shared
- `EMAIL_TOKEN_ENCRYPTION_KEY=<long-random>` is required regardless of provider — it encrypts tokens at rest and signs the OAuth state cookie.
- Restart `next dev` after changing env vars.

## Connecting a mailbox

Users connect their own at `/settings/email`:
1. Click **Connect Outlook / Microsoft 365** or **Connect Gmail**.
2. Approve scopes on the provider's consent screen.
3. They land back at `/settings/email?connected=<provider>` with the address shown.

Tokens (access + refresh) are stored AES-256-GCM-encrypted in `user_email_connections`. The transport refreshes automatically a minute before expiry.

## Flow

### Direct to supplier
1. Buyer clicks **✉ Email** on a recipient row.
2. Dialog auto-fills subject + body from `suggestRfqEmailBody`. The compose banner warns if they haven't connected a mailbox yet.
3. Buyer picks **Send direct to the supplier** + Send now.
4. Server inserts a `draft` row, marks it `sent`, fires through the buyer's connected provider (Graph `/me/sendMail` or Gmail `users.messages.send`), stores the message id.

### Routed through procurement
1. Same compose UI, buyer picks **Route through Procurement**.
2. Server inserts the draft as `pending_procurement_review` and emails the procurement contacts a heads-up — sent from the BUYER's mailbox so replies thread back to them.
3. Reviewers open **Orders → ⌛ Procurement review**, see pending cards, edit subject + body in place.
4. Approve & send → status flips to `approved` then `sent`, the supplier email goes out **through the original composer's connected mailbox** (not the reviewer's).
5. Reject → status flips to `rejected` with reviewer comment. The buyer can revise + resubmit.

## What's NOT in this slice yet
- Inbox summarisation on the home page (Phase 2 — the read scopes are already requested).
- Round-trip threading (parsing supplier replies and attaching them to the RFQ).
- File attachments on the outbound email (RFQ PDF). Currently the body links into the portal where the supplier sees the rendered RFQ + attachments.
- Resubmit-after-rejection helper UI.
