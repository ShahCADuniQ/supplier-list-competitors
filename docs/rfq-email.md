# RFQ Email — setup

The "Send RFQ via email" flow lives at `Orders → RFQ detail → recipient row → ✉ Email`. Procurement-routed drafts queue up at `Orders → ⌛ Procurement review`.

The transport layer (`src/lib/email/index.ts`) is provider-agnostic but currently wired to [Resend](https://resend.com). When no API key is set, every call **logs to the server console** and the workflow keeps working in dev mode — useful for testing the procurement queue without actually sending mail.

## Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | for real delivery | — | `re_xxx...`. Without this we fall back to console-log + a `dev-<uuid>` message id, but the draft still flows through approve/reject. |
| `EMAIL_FROM_ADDRESS` | recommended | `rfq@caduniq.com` | Must be a domain you've verified inside Resend (DNS records: MX, SPF, DKIM). |
| `EMAIL_FROM_NAME` | optional | `CADuniQ` | Friendly name shown on the From header. |
| `EMAIL_REPLY_TO` | optional | — | Default Reply-To when the caller doesn't pass one. The send action overrides this with the requesting buyer's email so supplier replies land in their inbox. |
| `PROCUREMENT_EMAIL` | optional | `imendo@lightbase.ca` | Where the heads-up email goes when a draft is routed via procurement. |
| `PROCUREMENT_NAME` | optional | `Procurement (Imen)` | Friendly name on that heads-up email. |
| `NEXT_PUBLIC_APP_URL` | recommended | — | Already used elsewhere; we use it to build absolute review/portal URLs in the email bodies. |
| `ANTHROPIC_API_KEY` | optional | — | Used by `buildAiSummary` to add a plain-language summary to the email for unregistered suppliers. Without it, the "AI summary" checkbox just produces nothing. |

## Resend domain setup (one-time, ~10 min)

1. In Resend → **Domains** → Add domain → pick a domain you control (e.g. `caduniq.com`).
2. Add the DNS records Resend shows (MX, SPF/TXT, DKIM/CNAME).
3. Wait for the dashboard to show all three as **Verified** (usually 1–5 min).
4. Set `EMAIL_FROM_ADDRESS=rfq@caduniq.com` (or any address on the verified domain) and `RESEND_API_KEY=re_xxx...` in `.env`.
5. Restart `next dev`.

## Flow

### Direct to supplier
1. Buyer clicks **✉ Email** on a recipient row.
2. Dialog auto-fills subject + body from `suggestRfqEmailBody`. Reply-to is the buyer's email; from is the verified sender.
3. Buyer picks **Send direct to the supplier** + Send now.
4. Server inserts a `draft` row, marks it `sent`, fires through Resend, stores the message id.

### Routed through procurement
1. Same compose UI, buyer picks **Route through Procurement (Imen)**.
2. Server inserts the draft as `pending_procurement_review` and emails Imen a heads-up with a deep link to the review queue.
3. Imen opens **Orders → ⌛ Procurement review**, sees pending cards, can edit subject + body in place.
4. Approve & send → status flips to `approved` then `sent`, the supplier email goes out.
5. Reject → status flips to `rejected` with reviewer comment. The buyer can revise + resubmit (still as a fresh draft for now).

## What's NOT in this slice yet
- Per-user Gmail/Outlook OAuth (the "send from your own address" alternative path).
- Round-trip threading (parsing supplier replies and attaching them to the RFQ).
- File attachments on the outbound email (RFQ PDF). Currently the body links into the portal where the supplier sees the rendered RFQ + attachments.
- Resubmit-after-rejection helper UI.
