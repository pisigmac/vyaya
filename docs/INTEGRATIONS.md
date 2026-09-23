# Integrations

Contract per integration: env vars, failure behavior, how to enable. All
integrations are off by default. The code compiles and every test passes
with all of them off.

## DeskId (identity) — required, mockable in dev

Self-hosted identity from `https://github.com/pisigmac/DeskId`. JSON +
RS256 JWTs — NOT OIDC; there is no OIDC client library in this repo.

**Contract.**

- **JWKS:** `GET /.well-known/jwks.json`. Vyaya caches public keys and
  refreshes on unknown `kid` or cache TTL — key ring rotation upstream is
  supported (old keys verify during the overlap window).
- **Verification is stateless per request.** RS256 signature against the
  `kid` key, `iss == DESKID_ISSUER`, `aud` contains `vyaya`, `exp > now`.
  Vyaya never calls DeskId per request.
- **Claims:** `sub` (user uuid), `email`, `org_id`, `workspace_id`,
  `aud[]`, `roles: { "vyaya": "admin" | "operator" | "viewer" }`,
  `token_version`. Service-wide grants (`org_id = null`) act as platform
  roles and are honored in authorization.
- **OAuth:** browsers go to `GET /v1/oauth/google/start` or
  `GET /v1/oauth/github/start`; DeskId redirects to
  `AUTH_SPA_CALLBACK_URL` (our `/auth/callback`) with `?token=`.
- **Audience grants:** on workspace creation the web app calls
  `POST /v1/admin/grants` with `DESKID_ADMIN_TOKEN` (best-effort). The
  alternative: set `AUTH_DEFAULT_AUDIENCES=vyaya` at DeskId bootstrap
  (our compose `deskid` profile does exactly this).
- **Reconciliation:** the worker polls
  `GET /v1/admin/reconciliation/events?since_id=...` into
  `user_grants_cache` + `reconciliation_cursor` when
  `DESKID_RECONCILE_ENABLED=true`. Events are zod-validated; malformed
  events are skipped without blocking the cursor.
- **Key rotation:** upstream rotates its keyring; JWKS refresh handles it.
  The mock exposes `POST /v1/admin/rotate-keys` to exercise this in dev.
- **Rate limiting is per-process upstream.** Pin DeskId to 1 replica. Our
  compose sets `deploy.replicas: 1`; see `ops/RATE_LIMITS.md`.

**Env vars.** `AUTH_MODE` (`dev` | `deskid`), `DESKID_ISSUER`,
`DESKID_JWKS_URL`, `DESKID_BASE_URL`, `DESKID_ADMIN_TOKEN`,
`AUTH_SPA_CALLBACK_URL`, `DESKID_RECONCILE_ENABLED`,
`DESKID_RECONCILE_INTERVAL_MS`. Compose-wiring helpers:
`DESKID_JWKS_URL_INTERNAL`, `DESKID_BASE_URL_INTERNAL`,
`DESKID_JWT_PRIVATE_KEY_FILE`, `DESKID_JWT_PUBLIC_KEY_FILE`,
`DESKID_OPEN_REGISTRATION`, `DESKID_BOOTSTRAP_TOKEN`,
`DESKID_GOOGLE_CLIENT_ID/SECRET`, `DESKID_GITHUB_CLIENT_ID/SECRET`.

**Failure behavior.** DeskId down: existing sessions keep working (HMAC
cookie, verified locally), new logins fail at the OAuth redirect. JWKS
cached; an unknown kid triggers one refresh attempt before rejection. The
audience-grant call at onboarding is best-effort — failure never blocks
provisioning.

**Enable.** Dev: `AUTH_MODE=dev` + the `mock-deskid` compose profile (port
8091). Prod: `AUTH_MODE=deskid`, `deskid` compose profile, keys via
`scripts/deskid-keygen.sh`, `DESKID_ISSUER` identical on both sides.

## KubeMind (upstream router) — optional

`UPSTREAM_MODE=kubemind` points the proxy at a KubeMind router
(`KUBEMIND_ROUTER_URL`) instead of `OPENAI_BASE_URL`. Passthrough is
OpenAI-compatible either way — the proxy contract (headers, logging, cost
math) doesn't change.

**Failure behavior.** Router unreachable -> 502 `upstream_unavailable`,
logged with zero tokens. Same as any upstream failure.

**Enable.** `UPSTREAM_MODE=kubemind`, `KUBEMIND_ROUTER_URL=http://...`.
Per-workspace router URLs are on the roadmap (`docs/FUTURE_PLAN.md` Q2);
today the upstream is global per proxy deployment.

## Sentinel (OTel export) — optional

When `SENTINEL_ENABLED=true` and `SENTINEL_OTEL_URL` is set, proxy and
worker emit OpenTelemetry spans into KubeMind sentinel. Loading is via
dynamic imports — with the flag off, the OTel packages are never touched
and the tracer is a no-op.

**What's emitted.**

- Proxy: span `proxy /v1/chat/completions` (or `/v1/embeddings`) with
  attributes `vyaya.workspace_id`, `vyaya.request_id`, `llm.model`,
  `http.endpoint`, plus `vyaya.status` and `vyaya.latency_ms` at
  finalize.
- Worker: `worker.job.run` spans per job with duration;
  `waste_event.emitted` spans from the classifier.

**Failure behavior.** Export failures never affect requests or jobs.
Flag unset = zero overhead, zero spans.

## Resend (weekly report email) — optional

The weekly report job sends through Resend's HTTPS API
(`POST https://api.resend.com/emails`) when `RESEND_API_KEY` is set;
`EMAIL_FROM` sets the sender (default `reports@vyaya.local`).

**Failure behavior.** Without a key, a recording stub stands in — the
report row and PDF are stored either way. With a key, send failures mark
the report `failed`; nothing is retried implicitly, rerun the job (the
report row upsert keeps it idempotent — same week, no duplicate PDF).

**Enable.** Set `RESEND_API_KEY`, verify your sender domain in Resend, set
`EMAIL_FROM` to an address on it. Detail: `ops/EMAIL.md`.

## Stripe (usage metering) — optional, test mode only in v1

When `STRIPE_ENABLED=true`, each proxied request records usage: event name
`STRIPE_METER_EVENT_NAME` (default `vyaya.llm_tokens`), payload
`{ request_id, workspace_id, tokens }`, posted to
`POST /v2/billing/meter_events` (2s timeout) AND appended to the
`stripe_meter_events` outbox (idempotency key = request id).

**Failure behavior.** Both paths are fire-and-forget. Failures increment a
counter and log a warning; user requests are never affected. Outbox rows
stay `pending` for reconciliation.

**Enable.** `STRIPE_ENABLED=true` + `STRIPE_SECRET_KEY=sk_test_...`. No
live checkout exists in v0.1.0 — this is plumbing for metered billing, not
billing. Ops: `ops/PAYMENTS.md`. Tiers: `docs/PRICING.md`.

## ClickHouse (analytics sink) — optional

`CLICKHOUSE_URL` switches request-log writes from Postgres to the
`ClickHouseLogSink`. Postgres is the default and fully working; ClickHouse
is the high-volume path.

**Failure behavior.** Identical to the Postgres sink: the retry queue
sits in front, proxy health is independent, drops are counted in
`/healthz` queue metrics.

**Enable.** Set `CLICKHOUSE_URL` and start the `clickhouse` compose
profile (port 8123). Historical backfill is not built — plan a dual-write
window if you migrate a live deployment (`docs/FUTURE_PLAN.md` Q2).
