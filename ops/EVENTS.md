# ops/EVENTS.md — event and telemetry catalog

Everything the system emits: durable events, telemetry spans, and log
fields. Metric semantics live in `docs/ANALYTICS.md`.

## waste_events (the product)

One row per detected unit of waste. Written by the worker's classify job,
dedupe-keyed (`sha256(workspace_id | waste_type | detector_version |
sorted request_ids)`) behind `waste_events_workspace_dedupe_idx` —
re-runs conflict, never duplicate.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | Event id. |
| `workspace_id` | uuid | Tenant. RLS-enforced. |
| `waste_type` | enum | `ghost_output`, `retry_storm`, `schema_failure_burn`, `context_amnesia`, `overprovisioned_max_tokens`. |
| `request_ids` | jsonb text[] | Implicated `request_logs.request_id` values. |
| `dedupe_key` | text | Idempotency anchor. |
| `dollars_wasted` | numeric(14,8) | From the detector; price-table-derived. |
| `evidence` | jsonb | Why this is waste (detector-specific; always includes `detector`). |
| `detector_version` | text | Pinned semver (all `1.0.0` in v0.1.0). |
| `suggested_fix` | text | The remediation text. |
| `detected_at` | timestamptz | When the detector fired (injected clock). |

## request_logs (the raw material)

One row per proxied request. `request_id` is the primary key and the
idempotency key (`ON CONFLICT DO NOTHING` on replay). Carries: model,
endpoint, latency, token counts, `max_tokens`, cost split
(input/output/total), `prompt_hash`, `session_id`, `feature_tag`,
`status` (`success` | `error` | `client_disconnect`),
`schema_validation` (`passed` | `failed` | `not_requested`),
`response_consumed`, retry metadata. Retention: 400 days, then rolled
into `daily_aggregates`.

## Stripe meter events

Outbox table `stripe_meter_events`: one row per recorded usage
(workspace, request id, event name `vyaya.llm_tokens`, payload
`{ request_id, workspace_id, tokens }`, idempotency key = request id).
Status lifecycle: `pending` -> `sent` (with `stripe_event_id`) or
`failed` (with `error`). Only exists when `STRIPE_ENABLED=true`.

## OTel spans (behind SENTINEL_ENABLED + SENTINEL_OTEL_URL)

| Span | Emitter | Attributes |
| --- | --- | --- |
| `proxy /v1/chat/completions`, `proxy /v1/embeddings` | proxy | `vyaya.workspace_id`, `vyaya.request_id`, `llm.model`, `http.endpoint`; at finalize: `vyaya.status`, `vyaya.latency_ms`. |
| `worker.job.run` | worker | per job run, duration recorded. |
| `waste_event.emitted` | worker classify | per emitted event. |

Graceful no-op when the flag is off — spans are the no-op tracer and the
OTel packages are never imported.

## pino log fields

Structured JSON logs (pino) in proxy and worker, level from `LOG_LEVEL`.

| Field | Where | Notes |
| --- | --- | --- |
| `requestId` | proxy | Child-logger binding on every request-scoped line. Echoes `X-Vyaya-Request-Id` or the assigned UUID. |
| `model` | proxy | On the unknown-price warning. |
| `tag` | proxy | On feature-tag rejection. |
| `err` | both | Serialized error on failures. |
| `bucketKey` | proxy | On Redis rate-limit fail-open (`apikey:<id>` — ids, not key material). |
| msg `unhandled route error` | web | 500s; deliberately free of internals. |

**Never in logs:** prompt or response bodies, API key plaintext, session
cookie values, DeskId tokens. Bodies only ever touch
`request_bodies` (encrypted) when a workspace opts in.

## Audit trail (durable, by design)

| What | Where |
| --- | --- |
| API key lifecycle | `api_keys` rows are soft-deleted (`revoked_at`), never removed. `created_by_user_id` ties keys to users. |
| Detector activity | `detector_runs`: per workspace, started/finished timestamps, checkpoint cursor, `running`/`completed`/`failed` + error text. |
| Identity sync | `reconciliation_cursor` (singleton `id='deskid'`) + `user_grants_cache` (latest role wins per deskid_sub + audience). |
| Reports | `reports` rows persist with content snapshots; past reports don't change when detectors improve. |
| Daily history | `daily_aggregates`: per-workspace per-day rollups, kept forever. |
