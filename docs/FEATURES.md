# Features

Everything Vyaya v0.1.0 ships, what it does, how to use it, and where it
stops. Detector internals live in `packages/core/src/detectors/`; thresholds
below are the env defaults from `.env.example` and can be overridden per
workspace (`workspaces.detector_thresholds`).

## 1. Observe-only proxy

**What it does.** Sits between your app and the LLM provider. Streams
requests and responses end-to-end, logs metadata per request, computes cost
from a server-side price table. Never blocks, mutates, or fails your request
because of logging — the latency budget is <10ms p95 added (measured
3.7-6.9ms; see `ops/PERF_BUDGET.md`).

**How to use it.** Swap one line in your SDK config:

```ts
// TypeScript (openai SDK)
const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "anything", // not used; the proxy owns the upstream credential
  defaultHeaders: { "X-Vyaya-Key": process.env.VYAYA_API_KEY },
});
```

```python
# Python (openai SDK)
client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="anything",
    default_headers={"X-Vyaya-Key": os.environ["VYAYA_API_KEY"]},
)
```

**What it logs per request.** Workspace, request id, model, endpoint,
latency, prompt/completion tokens, cost (USD, from the versioned price table
— never from the client), prompt hash (SHA-256 of the normalized prompt),
session id, feature tag, status, retry metadata, schema-validation result,
requested `max_tokens`, downstream-consumption signal.

**Limits.**

- Proxied endpoints: `POST /v1/chat/completions` (buffered and SSE
  streaming) and `POST /v1/embeddings`. No other OpenAI routes yet.
- Feature tags must match `^[a-z0-9][a-z0-9-_]{0,63}$` and the workspace
  allowlist when one is set. A rejected tag is dropped to null; the request
  still succeeds.
- Rate limit: 600 requests/minute per API key by default
  (`RATE_LIMIT_REQUESTS_PER_MINUTE`), sliding window, `429` + `Retry-After`
  when exceeded.
- Response tap keeps a bounded 4MB observability copy. Larger responses
  still stream fine; the copy truncates, so usage extraction falls back to
  the provider's `usage` field or estimates.
- Bodies are stored only when the workspace opts in (`log_bodies_enabled`)
  and the deployment allows it (`LOG_BODIES=true`). Metadata-only otherwise.

## 2. The five waste detectors

Deterministic heuristics, version `1.0.0`, zero LLM cost. The worker runs
them per workspace over unprocessed request logs.

| Waste type | Rule | Env knobs (defaults) | What's counted as waste |
| --- | --- | --- | --- |
| `ghost_output` | Status `success`, `response_consumed = false`, request older than the min age | `GHOST_OUTPUT_MIN_AGE_MS` (300000) | The full call cost. |
| `retry_storm` | >=3 identical `prompt_hash` calls within the window where a later attempt succeeded | `RETRY_STORM_MIN_ATTEMPTS` (3), `RETRY_STORM_WINDOW_MS` (60000) | Every attempt before the first success in the cluster. |
| `schema_failure_burn` | `schema_validation = failed` on a `success` response | none | The full call cost. |
| `context_amnesia` | Consecutive turns of one session share Jaccard >= threshold over word shingles, with enough repeated input tokens | `CONTEXT_AMNESIA_JACCARD_THRESHOLD` (0.6), `CONTEXT_AMNESIA_MIN_OVERLAP_TOKENS` (64), `CONTEXT_AMNESIA_SHINGLE_SIZE` (3) | The repeated fraction of the later turn's input cost. |
| `overprovisioned_max_tokens` | A consecutive run of >=50 calls (per model) where `completion_tokens / max_tokens` < 0.30 | `OVERPROVISIONED_MIN_CALLS` (50), `OVERPROVISIONED_MAX_RATIO` (0.30), `OVERPROVISIONED_RESERVATION_OVERHEAD` (0.10) | Excess provisioned tokens x inferred output price x 10%. |

Every waste event carries: workspace, implicated request ids, dollars
wasted, structured evidence (why), the pinned detector version, and a
suggested fix. Re-running the same detector version over the same logs
reproduces the same events — idempotency is anchored by a dedupe key.

**Limits.**

- `context_amnesia` needs prompt bodies. On metadata-only workspaces it
  stays silent. That's the honest trade for not storing prompts.
- Detectors see one batch at a time (default 5000 logs). A retry storm that
  straddles a batch boundary is scored per batch.
- Detection lags traffic by the classify cadence (default every 24h,
  `CLASSIFY_INTERVAL_MS`). In dev, "Run the classifier now" closes the gap.

## 3. Dashboard

**What it does.** One screen: waste rate for the last 30 days (hero
number), daily spend-vs-waste trend, breakdown by waste type / endpoint /
feature tag, the top-3 fixes ranked by projected annual savings, and the
costliest waste events with evidence.

**How to use it.** Sign in (GitHub or Google via DeskId OAuth) and open
`/dashboard`. The hero number is `dollars_wasted / total_spend` over 30
days. Metric definitions are in `docs/ANALYTICS.md`.

**Limits.** All dashboard windows are 7-90 days (30 default). Breakdown by
endpoint or tag splits an event's dollars evenly across its implicated
requests — an attribution rule, not gospel.

## 4. API keys

**What it does.** Per-workspace keys authenticate proxy traffic
(`X-Vyaya-Key`). Format `vy_live_` + 64 hex chars. Stored as argon2id
hashes; the plaintext is shown exactly once at creation. Last four
characters appear in the UI.

**How to use it.** Settings -> "Create key". Revoke or rotate from the same
screen. Rotation revokes the old key and issues a new one with the same
name in a single transaction.

**Limits.** Revocation propagates through the proxy's auth cache within 30
seconds (positive cache TTL). Keys are soft-deleted — revoked rows stay for
the audit trail.

## 5. Onboarding flow

**What it does.** Three steps: create a key, copy the base-URL swap snippet
(TypeScript and Python), send a real test request through the proxy. In dev
(`AUTH_MODE=dev`) a fourth step runs the classifier immediately so the
"first waste found" moment doesn't wait for the nightly job.

**Limits.** The test request needs the plaintext key pasted back (the
server stores only hashes). The dev-only classify button returns 403 in
production; there the worker runs on its schedule.

## 6. Weekly report

**What it does.** For each workspace, after each completed ISO week
(Monday-Sunday UTC): waste rate, biggest waste event, top fixes ranked by
projected annual savings (weekly waste x 52). Rendered to PDF with pdf-lib
(no headless browser), stored under `REPORT_OUTPUT_DIR`, emailed via Resend
when `RESEND_API_KEY` is set.

**How to use it.** Reports land on the settings screen with a download
link. Set the recipient under Workspace settings; empty means every
workspace member.

**Limits.** One report per workspace per week; reruns are no-ops. When
email isn't configured the report row and PDF are still stored — nothing is
blocked on email setup.

## 7. RBAC

Three roles from the DeskId claim `roles.vyaya`: `admin`, `operator`,
`viewer`. Viewers are read-only — every mutating BFF route returns 403 and
the UI hides write controls. Operators and admins can create keys and
change settings. A `requireAdmin` gate exists in the web lib for
admin-only routes; the dev classifier trigger is gated by `AUTH_MODE`
rather than role today.

## 8. Retention and privacy

Bodies 7 days, request metadata 400 days, daily aggregates forever. The
worker's sweeper enforces it hourly, rolling expired logs into aggregates
in the same transaction it deletes them. Bodies are AES-256-GCM encrypted
under a per-workspace key wrapped by the master key. Details:
`ops/DATA_RETENTION.md`, `docs/ARCHITECTURE.md`.

## 9. Flag-gated integrations

All off by default; the code compiles and the tests pass with every flag
off.

| Integration | Flag | What it adds |
| --- | --- | --- |
| Stripe meter events | `STRIPE_ENABLED` | Per-request usage records to Stripe (test mode) plus a durable outbox. |
| ClickHouse sink | `CLICKHOUSE_URL` | Request logs to ClickHouse instead of Postgres. Postgres is the default and fully working. |
| KubeMind upstream | `UPSTREAM_MODE=kubemind` | Proxy forwards to a KubeMind router instead of OpenAI. |
| Sentinel OTel | `SENTINEL_ENABLED` + `SENTINEL_OTEL_URL` | Proxy and worker emit OpenTelemetry spans. No-op when unset. |
| DeskId reconciliation | `DESKID_RECONCILE_ENABLED` | Worker polls DeskId's reconciliation feed into a local grants cache. |
| Resend email | `RESEND_API_KEY` | Weekly report email delivery. |

Contracts and failure behavior for each: `docs/INTEGRATIONS.md`.
