# Changelog

All notable changes to Vyaya. The format: one section per release, stages
as subsections while the project is young.

## v0.1.0 — 2026-09-20

The initial build. Full system green: 383 tests, pnpm audit clean, e2e
round trip passing (11/11 assertions, dockerless variant).

### Stage 1 — scaffold, config, core

- pnpm + Turborepo monorepo. Node >= 22.12.0, pnpm 10.17.1, exact pins.
- `@vyaya/config`: zod-validated env for every service. The only
  `process.env` reader in the codebase.
- `@vyaya/core`: the five waste detectors (`ghost_output`, `retry_storm`,
  `schema_failure_burn`, `context_amnesia`, `overprovisioned_max_tokens`,
  all v1.0.0), versioned price table + cost math, AES-256-GCM envelope
  encryption, DeskId RS256 JWT verification with JWKS caching, LogSink
  with retry-queue wrapper.
- 136 tests (config 12, core 124). Detector coverage 100% statements.

### Stage 2 — database (`@vyaya/db`)

- Drizzle schemas + migrations `0000`/`0001`: 7 enums, 10 tables, RLS
  ENABLE + FORCE everywhere, roles `vyaya_app` / `vyaya_service`.
- Seed script: 2 workspaces, 194 request logs engineered to fire all five
  detectors on workspace A.
- 27 new tests including live cross-workspace RLS rejection on embedded
  Postgres 16.

### Stage 3 — dev doubles

- `apps/mock-openai` (port 8788): deterministic chat completions (+SSE)
  and embeddings; latency knobs, failure injection, schema-failure
  injection.
- `apps/mock-deskid` (port 8091): RS256 JWT issuer with the exact DeskId
  claim shape; JWKS endpoint, OAuth start stubs, grants, reconciliation
  feed, key rotation. Refuses to boot unless `AUTH_MODE=dev`.
- 206 tests total.

### Stage 4A — proxy (`@vyaya/proxy`)

- Hono on plain Node, port 8787. Byte-faithful buffered + SSE passthrough.
- Observe-only contract enforced by test: with the logging backend forced
  down, 200 proxied requests return 200 with p95 added latency of
  6.5-6.9ms under load (3.7-4.4ms isolated). Budget: <10ms p95.
- Per-key sliding-window rate limit (600/min default; Redis or in-memory,
  fail-open), argon2id API-key auth with 30s cache, server-side cost from
  the price table, feature-tag allowlist, encrypted body opt-in, Stripe
  outbox, OTel no-op wiring.
- 305 tests total. Proxy coverage 90.87% statements.

### Stage 4B — worker (`@vyaya/worker`)

- Four jobs: `classify` (24h, checkpointed batches of 5000, dedupe-keyed
  idempotent writes, crash-resume proven by injection test),
  `weekly-report` (previous completed ISO week, pdf-lib PDF, Resend or
  recording stub), `retention-sweeper` (1h; bodies 7d, metadata 400d
  rolled into `daily_aggregates` in the same transaction),
  `deskid-reconcile` (flag-gated).
- Migrations `0002`/`0003`: `daily_aggregates`, `reconciliation_cursor`,
  `user_grants_cache`, `reports.pdf_path`.
- Health endpoint on port 8790. 348 tests total.

### Stage 5 — web (`@vyaya/web`)

- Next.js 16.3.5 + React 19.2.0 (exact pins), App Router, Tailwind v4,
  `proxy.ts` gating, standalone Docker output. Port 3000.
- Pages: landing, login, auth callback, onboarding, dashboard, settings.
  BFF: 17 route handlers covering session, keys, stats, waste events,
  fixes, reports (PDF download), onboarding, workspace settings.
- HMAC-SHA256 session cookie (12h TTL). RBAC: viewer read-only,
  operator/admin write.
- UI rules enforced and scan-verified: Inter, 5 type sizes, #F5F0EB /
  #1A1A1A with toggle, zero gradients, no marquees or fake testimonials,
  buttons with specific verbs.
- 383 tests total.

### Stage 6 — compose + e2e

- `docker-compose.yml`: 10 services, one network, five volumes. Default
  profile: postgres 16, redis 7, mock-openai, proxy, worker, web.
  Profiles: `mock-deskid`, `deskid` (pinned commit, 1 replica —
  per-process rate limiting), `clickhouse`.
- `scripts/e2e-local.sh` (dockerless, actually run): 11/11 assertions.
  Round trip: token -> session -> API key -> proxied request ->
  request_log -> classify -> 20 waste events -> dashboard APIs.
- `scripts/e2e.sh` (docker variant, same assertion library) and
  `docs/DEPLOY.md`.

### Stage 7 — documentation

- This changelog plus the full doc set: 21 files in `docs/` (including
  `OPENAPI.yaml`) and 10 runbooks in `ops/`.

### Known limitations at v0.1.0

- Docker image builds and `docker compose up` are statically validated
  only — no daemon in the build environment.
- Real DeskId OAuth round trip untested (mock-deskid path verified).
- Stripe is test-mode plumbing; no live checkout.
- Detectors are deterministic heuristics v1; `context_amnesia` requires
  body logging opt-in.
