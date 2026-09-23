# API reference

Every HTTP surface in Vyaya. The machine-readable version is
`docs/OPENAPI.yaml`. Error catalog with remediation: `docs/ERRORS.md`.

Ports in dev (compose): proxy 8787, web 3000, worker 8790, mock-openai
8788, mock-deskid 8091, real DeskId 8090.

---

## 1. Proxy (`apps/proxy`, port 8787)

OpenAI-compatible passthrough. The proxy speaks OpenAI on failure paths:
errors are `{ "error": { "message", "type", "param": null, "code" } }`.

### Request headers

| Header | Required | Rules |
| --- | --- | --- |
| `X-Vyaya-Key` | yes | Workspace API key, `vy_live_` + 64 hex chars. |
| `X-Vyaya-Request-Id` | no | Client correlation id. Must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`; malformed values are ignored and a UUID is assigned. |
| `X-Vyaya-Session` | no | Session id for `context_amnesia`. Max 256 chars. |
| `X-Vyaya-Tag` | no | Feature tag for breakdowns. Max 128 chars; validated against the workspace allowlist (env `FEATURE_TAG_ALLOWLIST` fallback). Rejected tags become null — the request still succeeds. |
| `X-Vyaya-Retry-Attempt` | no | Integer 0-10000. 0 = first attempt. |
| `X-Vyaya-Retry-Of` | no | Request id of the first attempt in a retry chain. Max 128 chars. |
| `X-Vyaya-Consumed` | no | Downstream-consumption signal for `ghost_output`. `false`, `0`, `no` (case-insensitive) mark the response as not consumed; anything else is consumed. |
| `Authorization` | no | Never forwarded upstream. The proxy injects the upstream credential itself (`OPENAI_API_KEY` / KubeMind router). |

Every response carries `x-vyaya-request-id` (the assigned or echoed id).

### POST /v1/chat/completions

Body: standard OpenAI chat completion payload. `stream: true` with
`stream_options.include_usage` is supported; usage is extracted from the
SSE stream. `response_format` (`json_object`, `json_schema`) triggers
server-side schema validation, recorded per request.

Response: the upstream response, byte-faithful (buffered or SSE).
Token usage comes from the provider's `usage` field when present; for
streams without `include_usage` it's estimated deterministically
(`packages/core/src/prompt/`). Errored upstream calls are logged with zero
tokens — the provider didn't bill them.

### POST /v1/embeddings

Body: standard OpenAI embeddings payload (string or array input, batch
supported). Usage: input tokens only; completion is always 0.

### GET /healthz

```json
{
  "status": "ok",
  "service": "vyaya-proxy",
  "queue": {
    "enqueued": 0, "written": 0, "droppedBackpressure": 0,
    "droppedExhausted": 0, "writeFailures": 0, "flushCount": 0,
    "queueDepth": 0
  }
}
```

Health is `ok` even when the database is down — by design. Watch `queue`
for the real story (`droppedBackpressure`, `queueDepth`).

### Proxy error codes

| HTTP | code | Cause |
| --- | --- | --- |
| 401 | `missing_api_key` | No `X-Vyaya-Key` header. |
| 401 | `invalid_api_key` | Key unknown, malformed, or revoked. |
| 503 | `auth_unavailable` | Auth store down and the key isn't cached. Fail-closed. |
| 429 | `rate_limit_exceeded` | Per-key sliding window exceeded. `Retry-After` header in seconds. |
| 502 | `upstream_unavailable` | The upstream fetch failed (DNS, connection, TLS). |

Upstream error statuses (4xx/5xx from OpenAI/mock) pass through untouched
with their original bodies.

---

## 2. Web BFF (`apps/web`, port 3000, all under `/api`)

Session auth via the `vyaya_session` cookie (HMAC-SHA256 signed, HttpOnly,
SameSite=Lax, Secure in production, 12h TTL by default). Errors are
`{ "error": "message" }`. Unauthenticated calls return 401
`"not signed in"`. Viewers get 403 `"viewers are read-only"` on mutations.

Roles: `viewer` (read), `operator` (read+write), `admin` (read+write+dev
tools).

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/auth/session` | `{ user: { sub, email, role, workspaceId } }`, or 401. |
| GET | `/auth/callback?token=...&provider=github\|google` | OAuth landing. Verifies the DeskId RS256 JWT, provisions user + workspace, sets the session cookie, redirects to `/onboarding` (new) or `/dashboard`. Also aliased at `/api/auth/callback`. |
| GET | `/api/auth/logout` | Clears the cookie, redirects to `/`. |

### API keys

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/keys` | `{ keys: [{ id, name, last4, createdAt, lastUsedAt, revokedAt }] }` |
| POST | `/api/keys` | Body `{ name: string (1-100) }`. 201 `{ id, name, last4, createdAt, lastUsedAt, revokedAt, plaintext }`. `plaintext` appears once, never stored. |
| POST | `/api/keys/{id}/revoke` | Soft-delete. `{ key: ApiKeyView }`. 404 when unknown or already revoked. |
| POST | `/api/keys/{id}/rotate` | Revokes + reissues under the same name in one transaction. 201 with fresh `plaintext`. |

### Stats

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/api/stats/summary` | — | `{ days, totalSpendUsd, dollarsWasted, wasteRate, requestCount, wasteEventCount }` (30d window). |
| GET | `/api/stats/trend` | `days` 7-90 (default 30) | `{ days, points: [{ day, spendUsd, wastedUsd }] }` — one point per UTC day. |
| GET | `/api/stats/breakdown` | `dimension` = `waste_type` \| `endpoint` \| `feature_tag` (default `waste_type`), `days` 1-90 (default 30) | `{ dimension, days, slices: [{ key, dollarsWasted, eventCount }] }` sorted by dollars desc. Untagged requests group under `(untagged)`. |
| GET | `/api/waste-events` | `page` >=1 (1), `pageSize` 1-100 (20), `sort` = `dollars` \| `recent` (dollars), `wasteType` optional | `{ events: [{ id, wasteType, dollarsWasted, evidence, suggestedFix, detectedAt, requestIds }], page, pageSize, total }` |
| GET | `/api/fixes` | — | `{ fixes: [{ wasteType, suggestedFix, dollarsWasted30d, projectedAnnualSavingsUsd, eventCount }] }` — top 3 by 30d dollars. |

### Onboarding

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/onboarding/workspace` | `{ workspace: { id, name, slug }, requestCount, wasteEventCount }`. The UI polls this every 5s during onboarding. |
| POST | `/api/onboarding/test-request` | Body `{ apiKey: "vy_live_..." }`. Sends one real `gpt-4o-mini` chat completion through `PROXY_BASE_URL`. Returns `{ ok, status, latencyMs, model }`. 502 when the proxy is unreachable. |
| POST | `/api/onboarding/classify` | DEV ONLY (`AUTH_MODE=dev`; 403 otherwise). Spawns `node $WORKER_CLI_PATH --job classify --once`. 503 with the manual command when `WORKER_CLI_PATH` is unset. Returns `{ ran, detail }`. |

### Reports

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/reports` | `{ reports: [{ id, weekStart, weekEnd, totalSpendUsd, dollarsWasted, wasteRate, topWasteType, status, emailSentAt, hasPdf, createdAt }] }` newest first. |
| GET | `/api/reports/{id}` | `application/pdf` download (`vyaya-report-{id}.pdf`). 404 when the report has no PDF, the path escapes `REPORT_OUTPUT_DIR`, or the file is missing. |

### Settings

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/settings/workspace` | `{ name, slug, logBodiesEnabled, reportEmail, featureTags }`. |
| PATCH | `/api/settings/workspace` | Body (at least one field): `{ logBodiesEnabled?: boolean, reportEmail?: string \| "" \| null, featureTags?: string[] (max 50) }`. Feature tags replace the allowlist wholesale. Returns the updated settings. |

---

## 3. Worker (`apps/worker`, port 8790)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/healthz` | `{ status: "ok", service: "vyaya-worker", uptimeSec, jobs: [{ name, enabled, running, runs, failures, lastStartedAt, lastFinishedAt, lastOutcome, lastError }] }`. Everything else: 404. |

`lastOutcome` is one of `ok`, `failed`, `skipped_locked`, null. The four
jobs: `classify`, `weekly-report`, `retention-sweeper`, `deskid-reconcile`
(listed but `enabled: false` unless `DESKID_RECONCILE_ENABLED`).

---

## 4. Mock services (dev only)

### mock-openai (port 8788)

`POST /v1/chat/completions` (+ SSE), `POST /v1/embeddings`, `GET /healthz`.
Deterministic: tokens are pure functions of the normalized input and
`MOCK_OPENAI_SEED`. Control headers: `X-Mock-Completion-Tokens`,
`X-Mock-Latency-Ms`, `X-Mock-Fail` (a status code, `timeout`, or
`invalid-json`), `X-Mock-Invalid-Schema-Response` (returns schema-violating
JSON — exercises `schema_failure_burn`).

### mock-deskid (port 8091, refuses to boot unless `AUTH_MODE=dev`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | Liveness. |
| GET | `/.well-known/jwks.json` | Current + previous RS256 public keys. |
| GET | `/v1/oauth/{google\|github}/start` | 302 to `AUTH_SPA_CALLBACK_URL?token=<jwt>&provider=...`. |
| POST | `/v1/dev/token` | Direct JWT mint for tests/e2e. NOT a DeskId contract route. |
| POST | `/v1/admin/grants` | Grant an audience (default `vyaya`) to a user. |
| GET | `/v1/admin/reconciliation/events?since_id=` | In-memory feed: `{ events: [{ id, type, occurred_at, data }], latest_id }`. |
| POST | `/v1/admin/rotate-keys` | Rotate the keyring; the previous key stays advertised. |

`/v1/dev/token` exists so e2e can sign in without a browser. It has no
equivalent on real DeskId — don't build on it outside dev.
