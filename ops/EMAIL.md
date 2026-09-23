# ops/EMAIL.md — weekly report email

## What ships

Once per completed ISO week (Monday-Sunday UTC), per workspace, the
worker's `weekly-report` job (checked every `WEEKLY_REPORT_INTERVAL_MS`,
default 6h) sends a digest:

- **Subject:** `Your weekly waste report — {weekStart} to {weekEnd}.`
- **Body (plain text):** total spend, dollars wasted + waste rate, the
  biggest single waste event (amount + type), and the top fixes ranked by
  projected annual savings (weekly waste x 52). Ends with periods. No
  exclamation spam.
- **Attachment:** `vyaya-weekly-{weekStart}.pdf`, rendered with pdf-lib
  (no headless browser), also stored under `REPORT_OUTPUT_DIR` and linked
  from the settings screen.

**Recipients.** `workspaces.report_email` when set (Settings -> "Where the
weekly waste report goes"). Empty = every user email in the workspace.

## Setup (Resend)

1. Verify your sending domain in Resend (SPF/DKIM records they give you).
2. Set env for the worker:
   ```
   RESEND_API_KEY=re_...
   EMAIL_FROM=reports@your-domain.tld
   ```
   `EMAIL_FROM` defaults to `reports@vyaya.local`, which will not deliver
   anywhere — set it.
3. Restart the worker. Force a run to verify:
   `node dist/index.js --job weekly-report --once`
   (reports only generate for a completed week with a workspace present;
   same-week reruns are no-ops).

The sender calls `POST https://api.resend.com/emails` with a Bearer token.

## Failure behavior

| State | What happens |
| --- | --- |
| `RESEND_API_KEY` unset | `StubEmailSender` records the send. Report row + PDF stored with status `generated`. Nothing is lost; nothing is delivered. |
| Resend API errors | Status `failed`, warning logged (`weekly report email failed`). Report row + PDF still stored. Re-running the job for the same week is a no-op (report row exists) — to retry delivery, delete that week's report row and run again. |
| No recipients | Workspace has no `report_email` and no user emails: send skipped, status `generated`, `emailedTo: 0`. |
| Worker down for a week | Next run catches up — the job always targets the most recently COMPLETED week. A week with zero reports generated is simply absent; there's no backfill loop for older weeks beyond running the job manually during that week. |

Status lives on `reports.status`: `generated` | `emailed` | `failed`, with
`email_sent_at` set only on success.

## Deliverability notes

- Plain-text body + PDF attachment. No tracking pixels, no remote images —
  good for deliverability and on-brand for a privacy-stance product.
- Keep the subject line pattern stable; changing it breaks user filters.
- The body names real numbers. If a workspace had zero traffic, the report
  still generates with zeros — consider that a heartbeat, not a bug.
- Bounces/complaints are handled in Resend's dashboard; nothing in Vyaya
  consumes webhooks yet.

## Testing locally

Without a key, the stub records sends in-process. With the seeded dev
stack, `--job weekly-report --once` writes two PDFs (one per seeded
workspace) under `REPORT_OUTPUT_DIR` and two report rows — verified in the
worker test suite (41 tests) with `%PDF-1.7` header assertions.
