# TECH_STACK.md

What the project runs on, with exact pins. Framework-critical dependencies
are exact (no `^`/`~`); `save-exact=true` in `.npmrc` enforces this.

## Toolchain

- Node >= 22.12.0 (engines; built and tested on v24.8.0)
- pnpm 10.17.1 (packageManager pin)
- Turborepo 2.11.2
- TypeScript 5.9.3 (strict + `noUncheckedIndexedAccess`, NodeNext ESM)
- vitest 5.0.1 + @vitest/coverage-v8 5.0.1 (see docs/ASSUMPTIONS.md #9)
- Docker: compose v2 spec; app images on node:24-alpine, non-root `node`
  user, `pnpm deploy --legacy --prod` runtime layout

## Packages

- `packages/config` (@vyaya/config) — zod 4.6.5 env validation, the only
  package that reads `process.env`. Per-service schemas: web, proxy, worker,
  mock-openai, mock-deskid, db. All thresholds and flags default per the
  waste taxonomy and spec.
- `packages/core` (@vyaya/core) — zod 4.6.5 as the only runtime
  dependency:
  - cost: versioned price table + deterministic cost math
  - crypto: AES-256-GCM envelope (per-workspace DEK wrapped by env master key)
  - jwt: DeskId RS256 verification, cached JWKS with kid/TTL refresh
  - detectors: 5 deterministic waste detectors behind a pinned-version
    registry
  - logsink: LogSink interface, Postgres sink, ClickHouse HTTP sink,
    in-memory retry queue with backpressure drop + metrics
  - prompt: canonical normalization + SHA-256 prompt hashing + token
    estimation
  - types + zod schemas for request_log, waste_event, evidence, DeskId claims
- `packages/db` (@vyaya/db) — Drizzle ORM 0.45.2 + drizzle-kit 0.31.10 +
  postgres.js 3.4.9 against Postgres 16; argon2id API keys via
  @node-rs/argon2 2.2.1; 5 migrations (0000 init, 0001 RLS, 0002 worker
  tables, 0003 worker RLS, 0004 report_email); integration tests boot a
  real user-space Postgres 16.14 via embedded-postgres 16.14.0-beta.17.

## Apps

- `apps/web` (@vyaya/web, port 3000) — Next.js 16.3.5 + React 19.2.0
  (exact pins, per spec), App Router, `proxy.ts` (middleware is
  deprecated), Tailwind CSS 4.3.3 via @tailwindcss/postcss, standalone
  Docker output. Inter via next/font/google.
- `apps/proxy` (@vyaya/proxy, port 8787) — Hono 4.13.8 on
  @hono/node-server 2.1.1 (plain Node — runs anywhere). ioredis 5.11.1
  (rate limiting, fail-open), pino 10.3.1 (structured logs), ajv 8.20.0
  (JSON-schema validation of responses), postgres.js 3.4.9, OpenTelemetry
  API 1.9.1 + OTLP HTTP exporter 0.222.0 (dynamic-import, no-op unless
  SENTINEL_ENABLED).
- `apps/worker` (@vyaya/worker, port 8790 health) — plain Node scheduler;
  pdf-lib 1.17.1 (report PDFs, no headless browser), ioredis 5.11.1 (job
  locks), pino 10.3.1, Resend over plain HTTPS fetch. Same OTel no-op
  pattern as the proxy.
- `apps/mock-openai` (@vyaya/mock-openai, port 8788) — Hono 4.13.8.
  Deterministic token counts (fnv1a + seeded PRNG), latency/failure
  injection headers, SSE streaming, schema-conforming/violating responses.
- `apps/mock-deskid` (@vyaya/mock-deskid, port 8091) — Hono 4.13.8, DEV
  ONLY behind `AUTH_MODE=dev`. RS256 JWT issuance with node:crypto (no JWT
  library), persisted RSA keyring with rotation, JWKS, OAuth stubs, grants
  + reconciliation feed.

## Data + infra

- Postgres 16 (docker-compose dev; Neon via `DATABASE_URL` for prod).
  RLS ENABLE + FORCE on all 13 tables; roles `vyaya_app` / `vyaya_service`.
- Redis 7 (rate limiting + job locks; optional in dev — in-memory
  fallbacks with identical semantics).
- ClickHouse 24.8 (config-gated log sink, compose profile `clickhouse`).
- DeskId (self-hosted identity, compose profile `deskid`, pinned upstream
  commit). Python/FastAPI upstream; Vyaya talks JSON + RS256 JWTs, no OIDC.

## Test-only dependencies

embedded-postgres 16.14.0-beta.17 (user-space Postgres for integration
tests), ioredis-mock 8.13.1 (Redis semantics without a server). The e2e
script builds a real Redis 7.4.5 from source.

## Deliberate absences

- No OIDC client library (DeskId contract is JSON + RS256).
- No headless browser (pdf-lib renders reports).
- No LLM SDK inside detectors (deterministic heuristics, zero LLM cost).
- No framework code in `packages/core` — it's importable from anything.
