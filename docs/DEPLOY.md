# DEPLOY.md — Vyaya runbook

Vyaya is a pnpm + Turborepo monorepo of five services plus three packages.
Every app ships its own Dockerfile (node:24-alpine, non-root); the root
`docker-compose.yml` wires the whole stack for local/dev. There is also a
fully dockerless path (`scripts/e2e-local.sh`) that runs the same topology
with user-space Postgres and a from-source Redis.

## Services

| Service | Port | Healthcheck | Notes |
|---|---|---|---|
| web | 3000 | `GET /` (landing; no dedicated route) | Next.js 16 standalone |
| proxy | 8787 | `GET /healthz` | observe-only LLM proxy |
| worker | 8790 | `GET /healthz` | classifier, reports, retention |
| mock-openai | 8788 | `GET /healthz` | default dev upstream |
| mock-deskid | 8091 | `GET /healthz` | dev identity (profile `mock-deskid`, `AUTH_MODE=dev` only) |
| deskid | 8090 | `GET /health` | real DeskId (profile `deskid`), 1 replica max |
| postgres | 5432 | `pg_isready` | dev database |
| redis | 6379 | `redis-cli ping` | rate limits + job locks |
| clickhouse | 8123 | `GET /ping` | optional (profile `clickhouse`) |

## Path A — docker compose (recommended)

Requires Docker with compose v2.24+ (`env_file.required` is used so the file
works before you create `.env`; `docker compose version` to check).

First-run checklist:

```bash
cp .env.example .env

# 1. Fill the two secrets (both required):
sed -i "s/^SESSION_COOKIE_SECRET=.*/SESSION_COOKIE_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^MASTER_ENCRYPTION_KEY=.*/MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env

# 2. Start the stack with the dev identity issuer:
COMPOSE_PROFILES=mock-deskid docker compose up --build -d
#    (or set COMPOSE_PROFILES=mock-deskid in .env)

# 3. Migrate + seed (from the host, against the mapped postgres port):
pnpm install && pnpm -r build
pnpm --filter @vyaya/db migrate
pnpm --filter @vyaya/db seed    # prints two demo API keys, shown once

# 4. Open http://localhost:3000 — "Continue with GitHub/Google" runs the
#    mock OAuth stub and lands you in a provisioned workspace.
```

The seed creates two demo workspaces (Acme, Beacon) with ~194 synthetic
request logs covering all five waste patterns, so the first
`docker compose exec worker node dist/index.js --job classify --once`
already produces waste events on the dashboard.

Day-to-day:

```bash
docker compose ps                    # health status
docker compose logs -f proxy         # tails
docker compose restart worker
docker compose down                  # stop (volumes kept)
docker compose down -v               # stop + wipe all data
```

### Real DeskId instead of the mock

```bash
scripts/deskid-keygen.sh             # writes ./.deskid/{private,public}.pem
# .env edits:
#   AUTH_MODE=deskid
#   DESKID_ISSUER=http://localhost:8090        (== DeskId's AUTH_ISSUER)
#   DESKID_BASE_URL=http://localhost:8090      (browser-facing)
#   DESKID_JWKS_URL_INTERNAL=http://deskid:8090/.well-known/jwks.json
#   DESKID_BASE_URL_INTERNAL=http://deskid:8090
#   DESKID_GOOGLE_CLIENT_ID=... / DESKID_GITHUB_CLIENT_ID=... (real OAuth apps)
COMPOSE_PROFILES=deskid docker compose up --build -d
```

DeskId runs from a pinned upstream commit
(`pisigmac/DeskId@77c0f056`), mirrors its own compose pattern (dedicated
`deskid-db` postgres, `/run/secrets` key mounts), applies its schema at boot
(`init_db` in its app lifespan), and auto-grants the `vyaya` audience via
`AUTH_DEFAULT_AUDIENCES=vyaya`. Its rate limiter is per-process: keep it at
1 replica (the compose `deploy.replicas: 1` is documentation; see
ops/RATE_LIMITS.md).

### ClickHouse sink

```bash
# .env: CLICKHOUSE_URL=http://clickhouse:8123   (compose-internal address)
COMPOSE_PROFILES="mock-deskid,clickhouse" docker compose up -d
```

Unset `CLICKHOUSE_URL` returns to the default Postgres LogSink.

## Path B — dockerless dev (no docker, no sudo)

`scripts/e2e-local.sh` is the reference implementation and the CI-grade
proof: it starts a user-space Postgres 16 (`scripts/dev-pg.mjs`, the
@vyaya/db embedded-postgres test harness), builds Redis 7.4.5 from source
into `$HOME/vendor` when needed, migrates, seeds, starts all four apps from
built `dist`/standalone output, and runs the full round trip (mock-deskid
login → API key via BFF → proxied chat completion → request_log row →
classifier → waste_event rows → dashboard stats API). PASS/FAIL per step;
exit code is the verdict.

To run the stack by hand instead, follow the same script's env block
(`AUTH_MODE=dev`, `DESKID_ISSUER`/`DESKID_JWKS_URL`/`DESKID_BASE_URL` at the
mock, `OPENAI_BASE_URL` at mock-openai) and start, in order:

```bash
node scripts/dev-pg.mjs /tmp/pg.json &          # user-space Postgres
redis-server --port 6379 &                      # or REDIS_URL unset (in-memory)
node packages/db/dist/migrate.js
node packages/db/dist/seed.js
node apps/mock-openai/dist/index.js &
node apps/mock-deskid/dist/index.js &
node apps/proxy/dist/index.js &
node apps/web/.next/standalone/apps/web/server.js &   # after cp -r .next/static
node apps/worker/dist/index.js &                # scheduler; or --job classify --once
```

## Production notes

- **Database:** set `DATABASE_URL` to Neon (or any Postgres 16). Run
  `pnpm --filter @vyaya/db migrate` at deploy time. The dev compose database
  is a convenience, not a prod topology. App traffic is expected to run as
  the `vyaya_app` role (RLS-enforced); the worker/migrations as
  `vyaya_service`/owner — see docs/DB_SCHEMA.md.
- **Identity:** real DeskId only (`AUTH_MODE=deskid`). One replica. Set
  `AUTH_ISSUER` to its public URL and make every Vyaya service's
  `DESKID_ISSUER` match it exactly; `DESKID_JWKS_URL` must resolve from
  inside your network. mock-deskid must never ship to prod (it refuses to
  boot unless `AUTH_MODE=dev`).
- **Secrets:** `SESSION_COOKIE_SECRET`, `MASTER_ENCRYPTION_KEY`,
  `DESKID_ADMIN_TOKEN`, Stripe/Resend keys — env-only, from your secret
  store. The master key wraps per-workspace DEKs (AES-256-GCM envelope); the
  KMS upgrade path is the `EnvelopeCipher` interface in packages/core
  (swap key-wrapping for KMS calls, data format unchanged).
- **Proxy:** terminate TLS in front; added latency budget is <10ms p95 —
  keep its Postgres/Redis close. Proxy health is independent of logging
  backends by design.
- **Web:** serve the standalone output behind the same TLS terminator;
  cookies are Secure in production (`NODE_ENV=production`).
- **Flags off by default:** `STRIPE_ENABLED`, `SENTINEL_ENABLED`,
  `DESKID_RECONCILE_ENABLED`, `LOG_BODIES`, `CLICKHOUSE_URL`.

## Verification

```bash
scripts/e2e.sh          # docker variant: compose up, full round trip, down
scripts/e2e-local.sh    # dockerless variant: same assertions on the host
```

Both print PASS/FAIL per step and exit non-zero on any failure.
