# RFQ Email — setup (Nylas)

The "Send RFQ via email" flow lives at `Orders → RFQ detail → recipient row → ✉ Email`. Procurement-routed drafts queue up at `Orders → ⌛ Procurement review`.

The transport layer (`src/lib/email/index.ts`) routes outbound mail through **Nylas**, the unified Gmail + Outlook API. Each user connects their own mailbox once at `/settings`; outbound RFQs go through Nylas's send endpoint so the supplier sees the buyer's real address, and the same Nylas grant gives us read access for the upcoming home-page summariser. When the composer hasn't connected a mailbox yet, every call **logs to the server console** and the workflow keeps working in dev mode.

## Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `NYLAS_CLIENT_ID` | yes | — | Public client id from the Nylas dashboard. |
| `NYLAS_API_KEY` | yes | — | Server API key — never expose to the browser. |
| `NYLAS_API_URI` | optional | `https://api.us.nylas.com` | EU customers should set `https://api.eu.nylas.com`. |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | yes | — | Long random string (≥16 chars). Hashed with SHA-256 to a 32-byte AES key. Encrypts the stored grant_id and signs the OAuth state cookie. |
| `APP_BASE_URL` | recommended | request origin | Public origin of the app; used to build the OAuth callback URI. |
| `PROCUREMENT_EMAIL` | optional | `imendo@lightbase.ca` | Comma-separated. Where the heads-up email goes when a draft is routed via procurement. |
| `PROCUREMENT_NAME` | optional | `Procurement` | Friendly name on the heads-up email. |
| `NEXT_PUBLIC_APP_URL` | recommended | — | Used to build absolute review/portal URLs in the email bodies. |
| `ANTHROPIC_API_KEY` | optional | — | Used by `buildAiSummary` to add a plain-language summary for unregistered suppliers. |

## One-time Nylas setup (~5 min)

1. Sign up at [dashboard-v3.nylas.com](https://dashboard-v3.nylas.com/).
2. Create an application. Provider connectors for Microsoft and Google are enabled by default on the developer plan.
3. **Settings → Hosted authentication → Callback URIs** — add:
   ```
   ${APP_BASE_URL}/api/email/oauth/callback
   ```
   (For local dev that's `http://localhost:3000/api/email/oauth/callback`.)
4. Copy your client id from the dashboard.
5. **API Keys → Create API key** — copy the value (only shown once).
6. Paste both into `.env`:
   ```
   NYLAS_CLIENT_ID=...
   NYLAS_API_KEY=nyk_v0_...
   ```
7. Restart `next dev`.

You do not need to register apps in Azure AD or Google Cloud Console — Nylas owns those OAuth registrations and proxies the consent flow for you.

## Connecting a mailbox

Users connect their own at `/settings` (Manage Account → Email integration):
1. Click **Connect Outlook / Microsoft 365** or **Connect Gmail / Google Workspace**.
2. Nylas hosts the consent screen; user logs in to their provider and approves scopes.
3. They land back at `/settings?connected=<provider>#email` with the address shown.

The Nylas `grant_id` is AES-256-GCM-encrypted in `user_email_connections.access_token_encrypted`. Disconnect from the settings page also revokes the grant on Nylas's side so you don't keep paying for it.

## Flow

### Direct to supplier
1. Buyer clicks **✉ Email** on a recipient row.
2. Compose dialog auto-fills subject + body from `suggestRfqEmailBody`. A banner warns if they haven't connected a mailbox yet.
3. Buyer picks **Send direct to the supplier** + Send now.
4. Server inserts a `draft` row, marks it `sent`, fires through the buyer's Nylas grant (`POST /v3/grants/{grant_id}/messages/send`), stores the message id.

### Routed through procurement
1. Same compose UI, buyer picks **Route through Procurement**.
2. Server inserts the draft as `pending_procurement_review` and emails the procurement contacts a heads-up — sent from the BUYER's mailbox so replies thread back to them.
3. Reviewers open **Orders → ⌛ Procurement review**, see pending cards, edit subject + body in place.
4. Approve & send → status flips to `approved` then `sent`, the supplier email goes out **through the original composer's connected mailbox** (not the reviewer's).
5. Reject → status flips to `rejected` with reviewer comment. The buyer can revise + resubmit.

## What's NOT in this slice yet
- Inbox summarisation on the home page (Phase 2 — the read scopes are already granted; just need to poll `/v3/grants/{grant_id}/messages`).
- Round-trip threading (parsing supplier replies and attaching them to the RFQ).
- File attachments on the outbound email (RFQ PDF). Currently the body links into the portal where the supplier sees the rendered RFQ + attachments.
- Resubmit-after-rejection helper UI.
