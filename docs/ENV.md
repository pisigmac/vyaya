# ENV.md — environment variable reference

Every variable is parsed and validated at service boot by `@vyaya/config`
(zod). Services fail fast on invalid values. `Required` means the service
refuses to boot without it. Empty-string values in `.env.example` count as
unset for optional vars.

## Shared

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `NODE_ENV` | all | no | `development` | `development` \| `test` \| `production`. |
| `LOG_LEVEL` | all | no | `info` | `debug` \| `info` \| `warn` \| `error` (pino). |
| `DATABASE_URL` | web, proxy, worker, db | yes | — | Postgres 16 connection string. Neon URL in prod. |
| `REDIS_URL` | web, proxy, worker | no | unset | Redis 7 for rate limiting + job locks. Unset = in-memory fallback with identical semantics. |

## Identity (DeskId)

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `AUTH_MODE` | web, proxy, worker | no | `dev` | `dev` = apps/mock-deskid (DEV ONLY); `deskid` = real DeskId server. Never default to `dev` in prod images. |
| `DESKID_ISSUER` | web, proxy, worker | yes | — | Expected JWT `iss` claim. |
| `DESKID_JWKS_URL` | web, proxy, worker | yes | — | `GET /.well-known/jwks.json`; cached, refreshed on unknown `kid` or TTL. |
| `DESKID_BASE_URL` | web, worker | yes | — | DeskId base URL for OAuth start redirects and admin APIs. |
| `DESKID_ADMIN_TOKEN` | web, worker | no | unset | Admin token for DeskId grants/reconciliation APIs. Web uses it for the post-onboarding audience grant; mock-deskid ignores it. |
| `AUTH_SPA_CALLBACK_URL` | web | yes | — | Where DeskId redirects after OAuth; points at apps/web `/auth/callback`. |
| `SESSION_COOKIE_SECRET` | web | yes | — | Session cookie signing secret, min 32 chars. Cookies are Secure/HttpOnly/SameSite=Lax. |

## apps/web

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `WEB_PORT` | web | no | `3000` | HTTP port. |
| `SESSION_TTL_SEC` | web | no | `43200` | Session cookie lifetime (12h). The DeskId token itself is verified once at the callback; the session is our own signed cookie. |
| `PROXY_BASE_URL` | web | no | `http://localhost:8787` | Where the onboarding "Send test request" button points (the Vyaya proxy). Also the base URL shown in the SDK swap snippets. |
| `WORKER_CLI_PATH` | web | no | unset | DEV ONLY: absolute path to the worker entrypoint (`apps/worker/dist/index.js`) for the "Run the classifier now" button (`POST /api/onboarding/classify`, spawns `--job classify --once`). Unset = the endpoint returns the manual command. Never used when `AUTH_MODE=deskid` (403). |
| `REPORT_OUTPUT_DIR` | web, worker | no | `reports` | Where report PDFs live. Web and worker must resolve to the SAME directory (shared volume in compose) or downloads 404. Relative paths resolve against each service's own cwd. |

## apps/proxy

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `PROXY_PORT` | proxy | no | `8787` | HTTP port. |
| `UPSTREAM_MODE` | proxy | no | `openai` | `openai` \| `kubemind`; selects upstream base URL per workspace. |
| `OPENAI_BASE_URL` | proxy | no | `http://localhost:8788` | OpenAI-compatible upstream. Points at apps/mock-openai in dev, `https://api.openai.com` in prod. |
| `OPENAI_API_KEY` | proxy | no | unset | Real OpenAI key; env-only, never required in dev. |
| `KUBEMIND_ROUTER_URL` | proxy | no | unset | KubeMind router base URL (only when `UPSTREAM_MODE=kubemind`). |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | proxy | no | `600` | Per-API-key sliding-window limit (Redis, in-memory fallback). |
| `FEATURE_TAG_ALLOWLIST` | proxy | no | empty | Comma-separated fallback allowlist for `X-Vyaya-Tag`. The workspace's `feature_tag_allowlist` rows take precedence when present; this env list applies only when the workspace has no rows; empty env = allow all. Rejected tags never fail the request (logged with null tag). |
| `MASTER_ENCRYPTION_KEY` | proxy, worker, db | yes (proxy, worker); optional (db) | — | AES-256-GCM master key, 32 bytes as 64 hex chars (`openssl rand -hex 32`). KMS adapter is the documented upgrade path. The db package's dev seed uses it to encrypt demo bodies; unset there = metadata-only seed. |
| `LOG_BODIES` | proxy | no | `false` | Store AES-256-GCM-encrypted prompt/response bodies. Per-workspace opt-in enforced; default is metadata-only logging. |
| `CLICKHOUSE_URL` | proxy, worker | no | unset | ClickHouse HTTP endpoint. Unset = Postgres LogSink (default, fully working). |
| `STRIPE_ENABLED` | proxy | no | `false` | Stripe test-mode meter events only; no live checkout in v1. |
| `STRIPE_SECRET_KEY` | proxy | no | unset | Stripe test-mode secret key. |
| `STRIPE_METER_EVENT_NAME` | proxy | no | `vyaya.llm_tokens` | Meter event name for usage records. |
| `SENTINEL_ENABLED` | proxy, worker | no | `false` | Emit OTel spans (waste events, proxy latency) to KubeMind sentinel. |
| `SENTINEL_OTEL_URL` | proxy, worker | no | unset | OTel collector endpoint. Graceful no-op when unset. |

## apps/worker

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `WORKER_PORT` | worker | no | `8790` | Health/metrics port. |
| `DESKID_RECONCILE_ENABLED` | worker | no | `false` | Poll DeskId `GET /v1/admin/reconciliation/events?since_id=...` to sync grants/users. |
| `DESKID_RECONCILE_INTERVAL_MS` | worker | no | `60000` | Reconciliation poll interval. |
| `CLASSIFY_INTERVAL_MS` | worker | no | `86400000` | Nightly classifier cadence. `--job classify --once` bypasses it. |
| `CLASSIFY_BATCH_SIZE` | worker | no | `5000` | `request_logs` processed per workspace per classify transaction. |
| `WEEKLY_REPORT_INTERVAL_MS` | worker | no | `21600000` | Weekly-report check cadence (6h); the job itself decides when an ISO week has closed. |
| `RETENTION_SWEEP_INTERVAL_MS` | worker | no | `3600000` | Retention sweeper cadence. |
| `REPORT_OUTPUT_DIR` | worker | no | `reports` | Worker-local directory for generated weekly-report PDFs; the path is stored on the `reports` row. |
| `RESEND_API_KEY` | worker | no | unset | Resend key for the weekly report email. Unset = recording stub (report row + PDF still stored). |
| `EMAIL_FROM` | worker | no | `reports@vyaya.local` | From address for weekly reports. |
| `BODY_RETENTION_DAYS` | worker | no | `7` | Retention for encrypted bodies; enforced by the retention sweeper. |
| `METADATA_RETENTION_DAYS` | worker | no | `400` | Retention for request-log metadata. Aggregates kept forever. |

## Detector thresholds (worker; global defaults, per-workspace-overridable)

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `RETRY_STORM_MIN_ATTEMPTS` | worker | no | `3` | Identical `prompt_hash` calls within the window that count as a storm (taxonomy). |
| `RETRY_STORM_WINDOW_MS` | worker | no | `60000` | Retry-storm sliding window (taxonomy). |
| `GHOST_OUTPUT_MIN_AGE_MS` | worker | no | `300000` | Unconsumed responses younger than this are not flagged yet. |
| `CONTEXT_AMNESIA_JACCARD_THRESHOLD` | worker | no | `0.6` | Minimum Jaccard similarity (token shingles) between consecutive turns. |
| `CONTEXT_AMNESIA_MIN_OVERLAP_TOKENS` | worker | no | `64` | Minimum estimated repeated input tokens per wasted turn. |
| `CONTEXT_AMNESIA_SHINGLE_SIZE` | worker | no | `3` | Word-shingle size for Jaccard. |
| `OVERPROVISIONED_MIN_CALLS` | worker | no | `50` | Rolling-window call count (taxonomy). |
| `OVERPROVISIONED_MAX_RATIO` | worker | no | `0.30` | `completion_tokens / max_tokens` must stay below this (taxonomy). |
| `OVERPROVISIONED_RESERVATION_OVERHEAD` | worker | no | `0.10` | Fraction of excess provisioned output tokens valued as waste. |

## apps/mock-openai (dev upstream)

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `MOCK_OPENAI_PORT` | mock-openai | no | `8788` | HTTP port. |
| `MOCK_OPENAI_LATENCY_MS` | mock-openai | no | `50` | Base response latency knob. Per-request override: `X-Mock-Latency-Ms` header. |
| `MOCK_LATENCY_MS` | mock-openai | no | unset | Short alias for `MOCK_OPENAI_LATENCY_MS`; canonical name wins when both are set. |
| `MOCK_OPENAI_LATENCY_JITTER_MS` | mock-openai | no | `0` | Random extra latency, 0..value. |
| `MOCK_OPENAI_FAILURE_RATE` | mock-openai | no | `0` | Failure injection probability, 0..1. Per-request override: `X-Mock-Fail` header. |
| `MOCK_FAIL_RATE` | mock-openai | no | unset | Short alias for `MOCK_OPENAI_FAILURE_RATE`; canonical name wins when both are set. |
| `MOCK_OPENAI_SEED` | mock-openai | no | `42` | Seed for deterministic token counts. |

Request-level headers (no env): `X-Mock-Completion-Tokens` (force
`completion_tokens`), `X-Mock-Invalid-Schema-Response` (return JSON that
violates the declared `response_format` schema). See
apps/mock-openai/README.md.

## apps/mock-deskid (dev identity, AUTH_MODE=dev only)

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `AUTH_MODE` | mock-deskid | yes | `deskid` | DEV ONLY guard: the mock refuses to start unless this is exactly `dev`. Defaults to `deskid` so a missing value can never activate a mock issuer. |
| `MOCK_DESKID_PORT` | mock-deskid | no | `8091` | HTTP port. |
| `MOCK_DESKID_ISSUER` | mock-deskid | no | `http://localhost:{port}` | Issuer claim the mock signs with. |
| `DESKID_ISSUER` | mock-deskid | no | unset | Fallback issuer when `MOCK_DESKID_ISSUER` is unset. |
| `MOCK_DESKID_PRIVATE_KEY_PEM` | mock-deskid | no | unset | Pinned RSA private key (literal PEM or base64 single line). Both PEM vars must be set together; env keys are never written to disk. |
| `MOCK_DESKID_PUBLIC_KEY_PEM` | mock-deskid | no | unset | Matching public key served via JWKS. |
| `MOCK_DESKID_KEYS_DIR` | mock-deskid | no | `keys` | Directory for the generated keypair (gitignored; private key mode 0600). |
| `MOCK_DESKID_TOKEN_TTL_SEC` | mock-deskid | no | `3600` | Token lifetime (min 60). |
| `AUTH_SPA_CALLBACK_URL` | mock-deskid | no | `http://localhost:3000/auth/callback` | Where the OAuth stubs redirect with a freshly issued token. |

## packages/db / docker-compose dev database

Migrations: `pnpm --filter @vyaya/db migrate` (needs `DATABASE_URL`).
Dev seed: `pnpm --filter @vyaya/db seed` (needs `DATABASE_URL`; uses
`MASTER_ENCRYPTION_KEY` when set). Both read env through `loadDbEnv`.

| Var | Service | Required | Default | Description |
|---|---|---|---|---|
| `POSTGRES_USER` | db, compose | no | `vyaya` | Dev database user. |
| `POSTGRES_PASSWORD` | db, compose | no | `vyaya` | Dev database password. |
| `POSTGRES_DB` | db, compose | no | `vyaya` | Dev database name. |
| `POSTGRES_PORT` | db, compose | no | `5432` | Dev database port. |

## docker-compose wiring (host-side; consumed by `docker compose`, not by apps)

These variables only drive `docker-compose.yml` interpolation. No app reads
them; `@vyaya/config` never sees them. See docs/DEPLOY.md for the full
runbook.

| Var | Required | Default | Description |
|---|---|---|---|
| `COMPOSE_PROFILES` | no | unset | Comma-separated profiles to activate: `mock-deskid` (dev identity), `deskid` (real DeskId), `clickhouse` (analytics sink). Leave unset for the default set (postgres, redis, mock-openai, proxy, worker, web). |
| `DESKID_JWKS_URL_INTERNAL` | no | `http://mock-deskid:8091/.well-known/jwks.json` | JWKS URL as seen from INSIDE the compose network (`localhost` does not resolve between containers). Set to `http://deskid:8090/.well-known/jwks.json` with the deskid profile. Becomes `DESKID_JWKS_URL` for web/proxy/worker containers. |
| `DESKID_BASE_URL_INTERNAL` | no | `http://mock-deskid:8091` | DeskId base URL the worker container uses for admin/reconcile APIs. Set to `http://deskid:8090` with the deskid profile. |
| `COMPOSE_UPSTREAM_BASE_URL` | no | `http://mock-openai:8788` | Proxy upstream base URL inside the compose network. Becomes `OPENAI_BASE_URL` for the proxy container. |
| `DESKID_JWT_PRIVATE_KEY_FILE` | with deskid profile | `./.deskid/private.pem` | Host path of the RSA private key mounted into the DeskId container (`/run/secrets/auth_private.pem`). Generate with `scripts/deskid-keygen.sh`. |
| `DESKID_JWT_PUBLIC_KEY_FILE` | with deskid profile | `./.deskid/public.pem` | Matching public key (`/run/secrets/auth_public.pem`). |
| `DESKID_OPEN_REGISTRATION` | no | `true` | Maps to DeskId `AUTH_OPEN_REGISTRATION` (email signup). OAuth does not need it. |
| `DESKID_BOOTSTRAP_TOKEN` | no | unset | Maps to DeskId `AUTH_BOOTSTRAP_TOKEN` (bootstrap admin API token). |
| `DESKID_GOOGLE_CLIENT_ID` / `DESKID_GOOGLE_CLIENT_SECRET` | no | unset | DeskId Google OAuth client credentials. |
| `DESKID_GITHUB_CLIENT_ID` / `DESKID_GITHUB_CLIENT_SECRET` | no | unset | DeskId GitHub OAuth client credentials. |

With the deskid profile, also edit the app-level vars in `.env`:
`AUTH_MODE=deskid`, `DESKID_ISSUER=http://localhost:8090` (must equal the
DeskId container's `AUTH_ISSUER`), `DESKID_BASE_URL=http://localhost:8090`.
