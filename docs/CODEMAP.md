# CODEMAP.md

Current state after Stage 6. `packages/config`, `packages/core`,
`packages/db`, the two dev doubles (`apps/mock-openai`, `apps/mock-deskid`),
the observe-only traffic proxy (`apps/proxy`), the batch worker
(`apps/worker`), and the web app (`apps/web`) exist, wired end-to-end by the
root `docker-compose.yml` and the two e2e scripts (docker + dockerless).

```
vyaya/
├── package.json            # root; engines node>=22.12.0, packageManager pnpm@10.17.1
├── pnpm-workspace.yaml     # apps/*, packages/*, onlyBuiltDependencies, esbuild override
├── turbo.json              # build/test/typecheck pipeline, ^build ordering
├── tsconfig.base.json      # strict, noUncheckedIndexedAccess, NodeNext ESM
├── .npmrc                  # save-exact, engine-strict
├── .env.example            # every env var with placeholders (see docs/ENV.md)
├── docker-compose.yml      # full stack: postgres+redis (default), mock-openai,
│                           # mock-deskid (profile), deskid+deskid-db (profile,
│                           # pinned git commit), clickhouse (profile),
│                           # proxy/worker/web; healthchecks + restart everywhere
├── scripts/
│   ├── e2e.sh              # docker variant: compose up (mock profile), wait
│   │                       # for healthy, host migrate+seed, round trip, down
│   ├── e2e-local.sh        # dockerless variant: embedded Postgres runner +
│   │                       # from-source Redis + node processes from dist
│   ├── e2e-lib.sh          # shared assertions: mock-deskid login -> BFF key ->
│   │                       # proxy request -> request_log -> classify ->
│   │                       # waste_event -> dashboard stats API; PASS/FAIL
│   ├── dev-pg.mjs          # user-space Postgres 16 runner (embedded-postgres
│   │                       # harness), writes {url,port} ready-file, SIGTERM stop
│   ├── e2e-sql.mjs         # psql-free SQL helper (driver via @vyaya/db)
│   └── deskid-keygen.sh    # RSA keypair for the deskid profile (./.deskid)
├── docs/
│   ├── ENV.md              # var × service × required × default × description
│   ├── DEPLOY.md           # runbook: compose path, dockerless path, prod notes
│   ├── ASSUMPTIONS.md      # every build assumption, per stage
│   ├── TECH_STACK.md       # stack with exact pins
│   ├── DB_SCHEMA.md        # table/column/index/RLS reference
│   └── CODEMAP.md          # this file
├── apps/
│   ├── proxy/              # @vyaya/proxy — observe-only LLM proxy (Hono, :8787)
│   │   ├── Dockerfile          # node:24-alpine, non-root, pnpm deploy
│   │   └── src/
│   │       ├── app.ts              # createProxyApp: passthrough routes, auth,
│   │       │                       # rate limit, tap, fire-and-forget logging
│   │       ├── auth.ts             # X-Vyaya-Key: last4 lookup + argon2id + TTL cache
│   │       ├── rate-limit.ts       # sliding window: Redis + in-memory, fail-open
│   │       ├── tap.ts              # byte-faithful response tap; SSE/JSON usage extract
│   │       ├── schema-check.ts     # response_format validation (ajv), record-only
│   │       ├── feature-tags.ts     # X-Vyaya-Tag allowlist check, cached
│   │       ├── bodies.ts           # opt-in encrypted body store, FK-race retry
│   │       ├── stripe.ts           # meter events: outbox + stubbed HTTP, behind flag
│   │       ├── otel.ts             # OTel spans via dynamic import, no-op default
│   │       ├── sinks.ts            # per-workspace PostgresLogSink dispatch
│   │       ├── deps.ts             # wiring from env; DbAuthStore, jsonb writes
│   │       └── index.ts            # entrypoint (loadProxyEnv + serve + shutdown)
│   ├── worker/             # @vyaya/worker — batch brain (plain Node, :8790 health)
│   │   ├── Dockerfile          # node:24-alpine, non-root, pnpm deploy
│   │   └── src/
│   │       ├── jobs/
│   │       │   ├── classify.ts         # detector run: checkpointed batches,
│   │       │   │                       # dedupe_key idempotency, per-workspace
│   │       │   ├── weekly-report.ts    # 7d digest -> reports row + PDF + email
│   │       │   ├── report-pdf.ts       # pdf-lib rendering (no headless browser)
│   │       │   ├── email.ts            # EmailSender: Resend + recording stub
│   │       │   ├── retention-sweeper.ts# bodies 7d / metadata 400d (rolled into
│   │       │   │                       # daily_aggregates, kept forever)
│   │       │   └── deskid-reconcile.ts # reconciliation feed -> user_grants_cache
│   │       ├── request-logs.ts     # cursor parse/format + checkpointed batch
│   │       │                       # loader (decrypts prompt bodies per DEK)
│   │       ├── scheduler.ts        # in-process interval loop, per-job status
│   │       ├── locks.ts            # JobLock: Redis (SET PX NX) / in-memory
│   │       ├── health.ts           # node:http GET /healthz: job statuses
│   │       ├── otel.ts             # spans via dynamic import, no-op default
│   │       ├── deps.ts             # wiring from env (db, tracer, lock, sender)
│   │       ├── index.ts            # CLI: --job <name> --once, scheduler boot
│   │       └── *.test.ts           # idempotency, crash-resume, reconcile vs
│   │                               # mock-deskid, retention, health, locks
│   ├── web/                # @vyaya/web — Next.js 16 App Router + BFF (:3000)
│   │   ├── Dockerfile          # node:24-alpine, non-root, standalone output
│   │   ├── next.config.ts      # output:standalone, security headers (CSP,
│   │   │                       # HSTS, X-Frame-Options DENY, nosniff, Referrer)
│   │   ├── proxy.ts            # Next "proxy" (ex-middleware): gates /dashboard,
│   │   │                       # /settings, /onboarding on the session cookie
│   │   ├── app/
│   │   │   ├── layout.tsx          # Inter via next/font, theme bootstrap
│   │   │   ├── globals.css         # Tailwind v4 tokens: #F5F0EB/#1A1A1A,
│   │   │   │                       # 5 type sizes, 1 primary + 1 accent
│   │   │   ├── page.tsx            # landing (logged-out; redirects authed)
│   │   │   ├── login/page.tsx      # GitHub/Google -> DeskId OAuth start URLs
│   │   │   ├── auth/callback/route.ts  # token -> JWKS verify -> provision ->
│   │   │   │                       # session cookie -> /onboarding|/dashboard
│   │   │   ├── onboarding/page.tsx # 4-step first-run flow
│   │   │   ├── dashboard/page.tsx  # waste-rate hero, trend, donut, events,
│   │   │   │                       # top-3 fixes (server component)
│   │   │   ├── settings/page.tsx   # keys, workspace settings, reports
│   │   │   └── api/                # BFF route handlers (zod-validated,
│   │   │                           # withWorkspace-scoped, viewer read-only):
│   │   │                           # auth/{session,callback,logout},
│   │   │                           # onboarding/{workspace,test-request,classify},
│   │   │                           # keys (+[id]/revoke, [id]/rotate),
│   │   │                           # stats/{summary,trend,breakdown},
│   │   │                           # waste-events, fixes, reports (+[id] PDF),
│   │   │                           # settings/workspace
│   │   ├── lib/
│   │   │   ├── env.ts            # memoized loadWebEnv (only env access)
│   │   │   ├── db.ts             # memoized createDb (globalThis)
│   │   │   ├── session.ts        # HMAC-SHA256 JWT-in-cookie (Web Crypto)
│   │   │   ├── provision.ts      # claims -> workspace mapping + auto-create
│   │   │   │                       # + best-effort DeskId audience grant
│   │   │   ├── jwks.ts           # memoized JwksCache (5min TTL)
│   │   │   ├── http.ts           # session guard, zod parsing, error mapping
│   │   │   ├── errors.ts         # HttpError + RBAC (requireWrite/requireAdmin)
│   │   │   ├── schemas.ts        # zod input schemas for every BFF boundary
│   │   │   ├── format.ts         # money/percent/evidence-summary display
│   │   │   └── bff/              # framework-free logic (unit-tested):
│   │   │       ├── auth.ts           # handleAuthCallback (verify+provision+
│   │   │       │                   # grant+session)
│   │   │       ├── keys.ts           # list/create/revoke/rotate (plaintext once)
│   │   │       ├── stats.ts          # summary/trend/breakdown/events/fixes SQL
│   │   │       ├── settings.ts       # workspace settings + tag allowlist
│   │   │       ├── reports.ts        # report list + confined PDF read
│   │   │       └── onboarding.ts     # proxy test request; dev classifier spawn
│   │   └── components/           # charts (inline SVG, no lib), theme toggle,
│   │                           # breakdown toggle, onboarding flow, keys manager
│   ├── mock-openai/        # @vyaya/mock-openai — deterministic dev upstream (Hono, :8788)
│   │   ├── Dockerfile          # node:24-alpine, non-root, pnpm deploy
│   │   └── src/
│   │       ├── deterministic.ts    # fnv1a, token estimates, PRNG embeddings,
│   │       │                       # JSON-schema stub + violation generator
│   │       ├── app.ts              # createApp: chat/completions (+SSE), embeddings,
│   │       │                       # X-Mock-* knobs, failure injection
│   │       ├── index.ts            # entrypoint (loadMockOpenAiEnv + serve)
│   │       └── app.test.ts         # determinism, latency, failures, schema, stream
│   └── mock-deskid/        # @vyaya/mock-deskid — DEV ONLY mock DeskId (Hono, :8091)
│       ├── Dockerfile          # node:24-alpine, non-root; requires AUTH_MODE=dev
│       ├── keys/               # generated keypair (gitignored, private 0600)
│       └── src/
│           ├── keys.ts             # keyring load/generate/persist, kid derivation,
│           │                       # rotation, JWKS export
│           ├── token.ts            # RS256 issuance, DeskId claim shape
│           ├── store.ts            # in-memory grants + reconciliation event log
│           ├── app.ts              # createApp + assertDevMode; jwks, OAuth stubs,
│           │                       # grants, reconciliation, rotate-keys, dev token
│           ├── index.ts            # entrypoint (refuses boot unless AUTH_MODE=dev)
│           └── app.test.ts         # claim shape, JWKS, rotation refresh via
│                                   # @vyaya/core verify, grants, reconciliation
└── packages/
    ├── config/             # @vyaya/config — sole reader of process.env
    │   └── src/
    │       ├── shared.ts           # bool/int/float/port/url/csv/hex-key field helpers
    │       ├── services/web-proxy.ts  # loadWebEnv, loadProxyEnv (+shared field bundles)
    │       ├── services/worker.ts     # loadWorkerEnv + detectorThresholdsEnvSchema
    │       ├── services/mocks.ts      # loadMockOpenAiEnv, loadMockDeskIdEnv
    │       ├── services/db.ts         # loadDbEnv (+ optional MASTER_ENCRYPTION_KEY)
    │       ├── index.ts
    │       └── config.test.ts
    ├── core/               # @vyaya/core — cross-service domain logic
    │   └── src/
    │       ├── types.ts            # RequestLog, WasteEvent, DeskIdClaims, WasteType
    │       ├── schemas.ts          # zod mirrors for boundary validation
    │       ├── cost/
    │       │   ├── price-table.ts  # versioned per-1M prices, effectiveFrom resolution
    │       │   └── compute-cost.ts # computeCost, UnknownModelPriceError, roundUsd
    │       ├── crypto/
    │       │   └── envelope.ts     # AES-256-GCM: DEK wrap/unwrap, encrypt/decrypt(+AAD)
    │       ├── jwt/
    │       │   ├── jwks-cache.ts   # JWKS fetch+cache, TTL + unknown-kid refresh
    │       │   └── verify.ts       # stateless RS256 verify: iss/aud("vyaya")/exp
    │       ├── detectors/
    │       │   ├── interface.ts    # WasteDetector, DetectorContext, DetectorThresholds
    │       │   ├── registry.ts     # DETECTOR_REGISTRY, pins detector_version
    │       │   ├── ghost-output.ts
    │       │   ├── retry-storm.ts
    │       │   ├── schema-failure-burn.ts
    │       │   ├── context-amnesia.ts        # Jaccard over word shingles
    │       │   ├── overprovisioned-max-tokens.ts
    │       │   └── *.test.ts       # >=5 cases per detector, 100% line coverage
    │       ├── prompt/
    │       │   └── normalize.ts    # canonical prompt normalization, SHA-256 hash,
    │       │                       # token estimates (shared proxy/worker contract)
    │       └── logsink/
    │           ├── interface.ts    # LogSink: write(), healthy()
    │           ├── postgres.ts     # default sink; injected query fn; idempotent insert
    │           ├── clickhouse.ts   # HTTP JSONEachRow insert; CLICKHOUSE_URL gated
    │           └── retry-queue.ts  # in-memory queue, drop-oldest backpressure, metrics
    └── db/                 # @vyaya/db — schema, migrations, RLS, client, seed
        ├── drizzle.config.ts       # drizzle-kit: schema src/schema, out drizzle/
        ├── drizzle/                # 0000_init (generated) + 0001_rls_policies (custom)
        │                           # + 0002_worker_tables (generated) + 0003_worker_service_rls (custom) + meta/
        ├── rls/
        │   ├── policies.sql        # RLS source of truth (roles, GUC helper, policies)
        │   └── policies-worker.sql # RLS for Stage-4b tables (daily_aggregates tenant
        │                           # policy; service/read policies for the two
        │                           # service-global reconciliation tables)
        ├── test-support/icu60/     # fetch-on-demand ICU 60 libs for zonky PG16 binaries (tests only)
        └── src/
            ├── schema/             # one module per table + enums (13 tables)
            ├── client.ts           # createDb (DATABASE_URL via @vyaya/config),
            │                       # withWorkspace (SET LOCAL app.workspace_id),
            │                       # listWorkspaceIds (service role), scopedQueryFn
            ├── api-keys.ts         # vy_live_ key generation + argon2id hash/verify
            ├── migrate.ts          # runMigrations + CLI (pnpm --filter @vyaya/db migrate)
            ├── seed.ts             # dev seed: 2 workspaces, keys, ~194 logs, all 5 waste patterns
            ├── test-support/embedded-pg.ts  # user-space Postgres 16 harness (not built)
            └── *.test.ts           # migrations, RLS cross-workspace, seed, api keys
```

## Dependency direction

`apps/*` and `packages/db` → `@vyaya/core`, `@vyaya/config`. Never the
reverse. `@vyaya/config` is the only package that may read `process.env`;
`@vyaya/core` takes everything via injection (thresholds, keys, query fns),
which keeps detectors and crypto deterministic under test.

