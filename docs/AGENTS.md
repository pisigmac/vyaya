# AGENTS.md — guidance for any AI coding agent in this repo

Tool-neutral version of `docs/CLAUDE.md`. Same rules, same expectations.
If you edit one file, mirror the change in the other.

## The repo

Vyaya — a token-waste auditor for LLM APIs. pnpm + Turborepo monorepo,
Node >= 22.12.0, pnpm 10.17.1, TypeScript strict with
`noUncheckedIndexedAccess`. Eight buildable projects, 383 tests, one e2e
round-trip script.

```
apps/web         Next.js 16.3.5 dashboard + BFF        (port 3000)
apps/proxy       Hono observe-only LLM proxy           (port 8787)
apps/worker      Batch jobs: classify, report, sweep   (port 8790 health)
apps/mock-openai Deterministic dev upstream            (port 8788)
apps/mock-deskid Dev-only RS256 JWT issuer             (port 8091)
packages/core    Detectors, cost, crypto, JWT, LogSink
packages/db      Drizzle schemas, migrations, RLS, seed
packages/config  Zod-validated env (the ONLY process.env reader)
```

## Build, test, verify

```sh
pnpm install && pnpm build && pnpm test   # the gate; all must pass
pnpm audit --registry=https://registry.npmjs.org   # must be clean
scripts/e2e-local.sh                       # full round trip, no Docker
```

E2E flow: mint token -> auth callback -> create API key -> proxied request
-> request_log row -> classify -> waste_event rows -> dashboard API. 11
assertions; the exit code is the verdict.

## Hard rules (violations are review blockers)

1. **Observe-only proxy.** Never block, mutate, or fail a proxied request
   because of logging, metrics, or billing. Fire-and-forget with a bounded
   retry queue; backpressure drops, it never grows memory without bound.
2. **Fail-closed only for auth and upstream.** Everything else (Postgres
   sink, Redis, ClickHouse, Stripe, OTel) fails open and counts the
   failure in metrics.
3. **All env through `@vyaya/config`.** No `process.env` anywhere else.
   New variable = zod schema + `.env.example` + `docs/ENV.md` entry. Env
   parity between the example file and the doc is checked.
4. **RLS + explicit workspace filters.** Tenant queries use
   `withWorkspace(...)` AND a `WHERE workspace_id = ...` clause. Belt and
   braces — the service role bypasses RLS.
5. **Deterministic detectors.** Clock injected, no randomness, version
   pinned per event. Reproducibility is a feature: same detector version
   over the same logs yields byte-identical events.
6. **Idempotency by construction.** Dedupe keys + unique indexes +
   `ON CONFLICT DO NOTHING`. Any job must be safe to run twice.
7. **Zod on every input boundary.** HTTP bodies, query strings, queue
   payloads, external API responses (the DeskId reconciliation feed is
   validated too; malformed events are skipped, never trusted).
8. **Postgres parameter gotchas.** jsonb: `sql.unsafe`, `prepare: false`,
   `$n::jsonb` casts. timestamptz: ISO strings with `::timestamptz` casts.
   Read `docs/ASSUMPTIONS.md` #37 before touching raw SQL.
9. **Costs are server-side.** Price table in `packages/core/src/cost/`,
   versioned by date. Client claims about cost or usage are ignored.
10. **Copy rules everywhere.** UI strings, docs, emails: contractions,
    sentences end with periods, no exclamation spam, and the build spec's
    banned-word list is enforced by scan. Never name the off-limits
    identity providers or vendors the spec forbids, in any context.

## Conventions worth knowing

- Package scope `@vyaya/*`; internal imports use workspace aliases.
- API keys: `vy_live_` prefix, argon2id hashes at rest, last4 in the UI,
  soft-delete on revoke.
- Sessions: HMAC-SHA256-signed cookie (`vyaya_session`), Web Crypto, 12h
  TTL. Signed, not encrypted — identity claims only.
- Worker CLI: `node dist/index.js --job <name> --once` runs one job once;
  no flags runs the scheduler. Used by e2e and the dev-only onboarding
  button.
- OTel is dynamic-import and no-ops unless `SENTINEL_ENABLED` +
  `SENTINEL_OTEL_URL`. Keep it that way: the app must boot and pass tests
  with zero OTel packages exercised.
- vitest worker caps: `apps/worker` maxWorkers=2, `apps/web` maxWorkers=1.
  They exist because embedded-Postgres clusters under full-gate CPU
  contention flake the proxy latency gate.

## Definition of done for any change

1. `pnpm build` green, `pnpm test` green (383 tests, more if you added).
2. New env vars documented; new endpoints in `docs/API.md` +
   `docs/OPENAPI.yaml`; new tables in `docs/DB_SCHEMA.md` with RLS.
3. Banned-word scan clean on anything user-facing.
4. `pnpm audit` clean, or the finding documented in `docs/ERRORS.md`.
5. If you changed request flow: `scripts/e2e-local.sh` passes.
