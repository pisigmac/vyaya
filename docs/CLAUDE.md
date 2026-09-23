# CLAUDE.md — rules for AI coding assistants in this repo

You're working in Vyaya, a pnpm + Turborepo monorepo. The system is built,
green (383 tests), and opinionated. Read this before editing anything. The
tool-neutral twin of this file is `docs/AGENTS.md`; keep them in sync when
you change one.

## What Vyaya is

A token-waste auditor for LLM APIs. A proxy observes LLM traffic, a worker
classifies wasted spend into five waste types, a web app shows dollars and
fixes. The tagline and the product stance: "See what your LLM spend is
actually buying."

## Commands

```sh
pnpm install        # install (Node >= 22.12.0, pnpm 10.17.1)
pnpm build          # turbo build, all 8 projects
pnpm test           # turbo test, 383 tests across 8 suites
pnpm audit          # must stay clean; exceptions documented in docs/ERRORS.md
scripts/e2e-local.sh   # full round trip without Docker (PG + Redis in user space)
```

Per-package: `pnpm --filter @vyaya/core test` and so on. The e2e script
supports `SKIP_BUILD=1` when you haven't touched source.

## Where things live

- `packages/core` — detectors, cost math, price table, envelope encryption,
  JWT verification, LogSink, prompt normalization. The sole place for
  cross-service logic.
- `packages/db` — Drizzle schemas, migrations (`drizzle/0000`-`0004`), RLS
  policies (`rls/policies.sql`, `rls/policies-worker.sql`), seed.
- `packages/config` — zod-validated env for every service.
- `apps/proxy` — the observe-only proxy (Hono, port 8787).
- `apps/worker` — batch jobs (classify, weekly report, retention sweep,
  DeskId reconcile), port 8790 health only.
- `apps/web` — Next.js 16.3.5 App Router dashboard + BFF routes, port 3000.
- `apps/mock-openai` (8788) and `apps/mock-deskid` (8091) — dev doubles.

Full tree with per-file notes: `docs/CODEMAP.md`.

## Architecture invariants (do not break)

1. **The proxy never fails a user request because of observability.**
   Logging is fire-and-forget through `RetryQueueLogSink`. Backpressure
   drops the oldest queued log rather than growing memory. Auth and the
   upstream itself are the only fail-closed paths.
2. **Costs come from the versioned price table in
   `packages/core/src/cost/price-table.ts`.** Never trust a client-supplied
   cost, token estimate, or price.
3. **Zero `process.env` reads outside `packages/config`.** Every service
   loads its env through a zod schema there. Adding a variable means:
   schema + `.env.example` + `docs/ENV.md`. Keep the two files in parity —
   it's verified by diff.
4. **RLS on every tenant table.** Queries go through `withWorkspace` (sets
   `app.workspace_id` with `SET LOCAL`) AND carry an explicit
   `workspace_id` filter. Both. The service role bypasses RLS, so the
   explicit filter is what saves you.
5. **Detectors are deterministic.** No wall-clock reads (the clock is
   injected via `DetectorContext.nowMs`), no randomness, no LLM calls.
   Every event pins `detector_version`. Same logs + same version = same
   events.
6. **Idempotent writes.** `request_logs` inserts use
   `ON CONFLICT (request_id) DO NOTHING`. Waste events carry a
   `dedupe_key` (sha256 of workspace, type, detector version, sorted
   request ids) behind a unique index. Re-runs must never duplicate.
7. **Postgres jsonb writes** use `sql.unsafe` with `prepare: false` and
   explicit `$n::jsonb` casts — prepared-statement re-execution
   double-encodes jsonb through postgres.js (see `docs/ASSUMPTIONS.md`
   #37). Timestamptz parameters are ISO strings with `::timestamptz` casts
   for the same reason.
8. **Zod at every boundary.** HTTP inputs, queue payloads, reconciliation
   events. No `any` escapes parsing. TypeScript strict +
   `noUncheckedIndexedAccess` everywhere.
9. **No banned copy.** The build spec's banned-word and banned-phrase
   list applies to UI strings, docs, emails, and error messages.
   Scan before committing.
10. **Zero references to the off-limits identity providers or vendors
    named in the build spec** — code, docs, env, comments. DeskId is the
    only identity provider.

## Common tasks

**Add a detector.** Implement `WasteDetector` in `packages/core/src/detectors/`
(name, semver version, `detect(ctx)`), register it in `registry.ts`, add
the enum value in `packages/db/src/schema/enums.ts` AND `waste_type` in a
new migration, add thresholds to `DetectorThresholds` + config + `.env.example`
+ `docs/ENV.md`. Tests: happy path, boundary, false-positive guard — at
least 5 cases. Detectors sit at 100% statement coverage; keep it there.

**Change a price.** Add a new row to `PRICE_TABLE` with a later
`effectiveFrom` date and bump `PRICE_TABLE_VERSION`. Don't edit existing
rows — historical costs must stay reproducible.

**Add a BFF route.** Logic in `apps/web/lib/bff/` (framework-free,
vitest-able), a thin handler in `app/api/`, zod schema in
`lib/schemas.ts`, session via `requireSession()`, mutations via
`requireWrite(session)`. Update `docs/API.md` and `docs/OPENAPI.yaml`.

**Add a migration.** `pnpm --filter @vyaya/db drizzle-kit generate`, then
check RLS coverage: new tenant tables need ENABLE + FORCE RLS and policies
in `rls/policies.sql` (or `policies-worker.sql` for service tables). The
migrations test asserts the exact table and policy inventory — update it
deliberately, not blindly.

**Tune a detector threshold.** Global default: env var in
`packages/config` + `.env.example` + `docs/ENV.md`. Per workspace:
`workspaces.detector_thresholds` (partial JSON override, merged by the
worker).

## Test expectations

- `pnpm test` must be green before you report done. 383 tests today.
- The proxy latency gate (p95 added latency < 10ms with the logging backend
  down) is load-sensitive. If it flakes under the full gate, re-run the
  proxy suite in isolation before concluding you broke it — and if you did
  add latency, that's a real regression, not a flake.
- `apps/worker` runs vitest with `maxWorkers=2` and `apps/web` with
  `maxWorkers=1`: embedded-Postgres clusters are heavy and concurrent
  suites starve the latency gate. Don't uncap them.

## When you're unsure

`docs/ASSUMPTIONS.md` records 60+ numbered build decisions with rationale.
Check it before "fixing" something that looks like a bug — the jsonb
handling, the mock port choices, and the session-cookie format all look
odd until you read why.
