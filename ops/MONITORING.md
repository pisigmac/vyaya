# ops/MONITORING.md

What to watch, where, and what to alert on. Vyaya's philosophy: the proxy
protects user traffic above all, so most failures show up as metrics, not
outages. Your alerts should read the metrics.

## Health endpoints

| Service | Endpoint | Payload |
| --- | --- | --- |
| proxy :8787 | `GET /healthz` | `{ status: "ok", service: "vyaya-proxy", queue: {...} }` — always 200, even with Postgres down. |
| worker :8790 | `GET /healthz` | `{ status: "ok", service: "vyaya-worker", uptimeSec, jobs: [...] }` — per-job `lastOutcome`, `failures`, `lastFinishedAt`. |
| web :3000 | `GET /` | Landing page is the liveness signal (compose healthcheck uses it). |
| mock-openai :8788 | `GET /healthz` | dev only. |
| mock-deskid :8091 | `GET /healthz` | dev only. |
| deskid :8090 | `GET /health` | real DeskId profile. |

Compose wires healthchecks for every service (`pg_isready`,
`redis-cli ping`, wget on the HTTP endpoints).

## What to alert on

| Signal | Where | Threshold | Meaning |
| --- | --- | --- | --- |
| `queue.droppedBackpressure` > 0 | proxy /healthz | any sustained increase | The 10k log queue is overflowing: sink (Postgres/ClickHouse) is down or too slow. Logs are being LOST (oldest dropped). User traffic is fine — act fast anyway. |
| `queue.droppedExhausted` > 0 | proxy /healthz | any increase | Writes failed 3 times and were dropped. Sink trouble. |
| `queue.queueDepth` growing | proxy /healthz | sustained growth over minutes | Flush isn't keeping up. Check Postgres health and `writeFailures`. |
| Worker `lastOutcome: "failed"` | worker /healthz | any job | Check `lastError` and the `detector_runs` row with `status='failed'`. |
| Worker `lastFinishedAt` stale | worker /healthz | classify older than 2 x `CLASSIFY_INTERVAL_MS` | Scheduler dead-locked or the process is wedged. |
| Checkpoint lag | `detector_runs` | classify hasn't advanced `last_processed_log_id` while traffic flows | Detector crash-looping or an unparseable batch. |
| Redis down | logs | `redis rate-limit error; allowing request` warnings | Rate limiting has failed OPEN. Traffic is fine and unlimited — fix Redis. |
| Stripe backlog | DB | `stripe_meter_events` pending count growing | See `ops/PAYMENTS.md`. |
| DeskId down | web | login failures at `/auth/callback`; JWKS refresh warnings | Existing sessions unaffected (12h cookie TTL). New logins blocked. |

Deliberately NOT alertable: proxy 4xx/5xx toward clients (upstream and
auth outcomes are client-visible and expected), single job skips
(`skipped_locked` is normal under overlap), OTel exporter errors
(fire-and-forget by design).

## Log fields worth grepping

All services log JSON via pino at `LOG_LEVEL` (default `info`).

- `requestId` — proxy request correlation (echoes `X-Vyaya-Request-Id`).
- `weekly report generated` — worker, with `workspaceId`, `weekStart`,
  `status`, `pdfPath`.
- `weekly report email failed` — Resend trouble.
- `no price table entry for model` — a model needs a price-table row;
  costs for it are logged as 0 until you add one.
- `request log failed schema validation; dropped` — a bug. The log was
  dropped rather than mis-stored. Page on this in practice.
- `unhandled route error` — web 500s; no internals by design, correlate
  by timestamp.

## OTel (when SENTINEL_ENABLED)

Spans: `proxy /v1/...` with `vyaya.latency_ms` and `vyaya.status`;
`worker.job.run` with duration; `waste_event.emitted` per classified
event. Point `SENTINEL_OTEL_URL` at your collector. With the flag off the
tracer is a no-op and nothing is emitted — don't alert on missing spans
unless the flag is on.

## Dashboards (suggested, not shipped)

- Proxy: added-latency histogram (from OTel spans), queue depth,
  dropped counters, 401/429 rates.
- Worker: per-job run durations and failure counts, waste events emitted
  per run.
- Data: request_logs rows/day per workspace, `daily_aggregates` growth,
  `request_bodies` size (7-day retention should cap it).
