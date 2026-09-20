# @vyaya/worker

The batch brain. Plain Node service on `WORKER_PORT` (8790) with a health
endpoint and four scheduled jobs:

| Job | Flag / interval | What it does |
| --- | --- | --- |
| `classify` | `CLASSIFY_INTERVAL_MS` (default 24h) | Runs the five `@vyaya/core` detectors over unprocessed `request_logs` per workspace, writes `waste_events`, advances the per-workspace checkpoint in `detector_runs`. |
| `weekly-report` | `WEEKLY_REPORT_INTERVAL_MS` (default 6h) | Builds the previous ISO week's digest per workspace, renders a PDF (pdf-lib, no headless browser) to `REPORT_OUTPUT_DIR`, stores a `reports` row, emails via Resend (`RESEND_API_KEY`) or the recording stub. |
| `retention-sweeper` | `RETENTION_SWEEP_INTERVAL_MS` (default 1h) | Deletes `request_bodies` older than `BODY_RETENTION_DAYS` (7) and `request_logs` older than `METADATA_RETENTION_DAYS` (400) after rolling them into `daily_aggregates` (kept forever). |
| `deskid-reconcile` | `DESKID_RECONCILE_ENABLED`, `DESKID_RECONCILE_INTERVAL_MS` | Polls `GET /v1/admin/reconciliation/events?since_id=...` and applies grant/user changes to `user_grants_cache`, advancing `reconciliation_cursor`. |

## Guarantees

- **Idempotent classify.** Every waste event carries a deterministic
  `dedupe_key` (`sha256(workspace_id | waste_type | detector_version |
  sorted request_ids)`) anchored by a unique index; inserts are
  `ON CONFLICT DO NOTHING`. Re-running over the same logs never duplicates
  events.
- **Resumable.** Each batch commits events + checkpoint row in one
  transaction. A crash rolls back only the in-flight batch; the next run
  resumes from the last committed checkpoint. Proven by a crash-injection
  test (`hooks.afterBatch`).
- **Report idempotency.** One report per `(workspace_id, week_start)`; a
  second run for the same week is a no-op (no duplicate emails).

## CLI

```
node dist/index.js                    # scheduler + /healthz on WORKER_PORT
node dist/index.js --once             # run every enabled job once, exit
node dist/index.js --job classify --once   # force one job once (e2e)
```

## Health

`GET /healthz` returns per-job `lastStartedAt`/`lastFinishedAt`,
`lastOutcome` (`ok` | `failed` | `skipped_locked`), and run/failure counts.

## Locking

Job runs take a lock (`vyaya:job:<name>`): Redis (`SET PX NX` + compare-del
release) when `REDIS_URL` is set, in-memory otherwise (single-process dev).
Lock TTL 30 minutes; jobs are idempotent, so an expired lock overlap is
safe.

## OTel

Behind `SENTINEL_ENABLED` + `SENTINEL_OTEL_URL`: a `worker.job.run` span per
run (duration attribute) and a `waste_event.emitted` span per emitted event.
Dynamic imports; graceful no-op when off.
