# Tests

How Vyaya is tested, what the numbers are, and the parts that need care.

## Suite inventory (383 tests, all green)

Counted at the Stage 6 gate on Node v24.8.0, pnpm 10.17.1, turbo 2.11.2.

| Package | Tests | What it covers |
| --- | --- | --- |
| `@vyaya/config` | 17 | Every env schema: defaults, parsing, validation failures, aliases (`MOCK_LATENCY_MS`, `MOCK_FAIL_RATE`), the mock-deskid `AUTH_MODE` guard. |
| `@vyaya/core` | 132 | All five detectors (happy + boundary + false-positive guard, >=5 cases each), cost math, price-table versioning, envelope encryption round-trips, JWT verification (valid, wrong aud, wrong iss, expired, unknown kid -> JWKS refresh, tampered), prompt normalization, LogSink retry queue. |
| `@vyaya/db` | 28 | Migrations on fresh Postgres 16 (apply, re-apply idempotency, drift check), RLS cross-workspace rejection for SELECT/INSERT/UPDATE/DELETE, policy inventory, seed idempotency, API key hashing. |
| `@vyaya/mock-openai` | 23 | Determinism (same input, same tokens), streaming/buffered parity, latency knobs, failure injection, schema-failure injection. |
| `@vyaya/mock-deskid` | 17 | RS256 mint/verify through the real `verifyDeskIdJwt` + `JwksCache`, key rotation with overlap, wrong-issuer and stranger-key rejection, dev-mode boot guard. |
| `@vyaya/proxy` | 91 | Passthrough byte-identity (buffered + SSE), resilience with the logging backend down, auth, rate limits (in-memory + ioredis-mock), schema validation, feature tags, encrypted body storage on real Postgres, Stripe outbox, OTel no-op. |
| `@vyaya/web` | 34 | Session crypto, auth callback against real mock-deskid keyrings, key lifecycle, exact stats math on seeded Postgres, tenant isolation, settings. |
| `@vyaya/worker` | 41 | Classify idempotency (run twice -> 0 new events), crash-resume (events identical to an uninterrupted reference run), retention sweep rollup atomicity, weekly report + PDF, DeskId reconciliation against a live mock-deskid. |

Total: 383. The build spec's floors hold: detectors at 100% statement
coverage, proxy above 90% statements.

## Coverage

vitest v8 provider.

- `@vyaya/core` detectors: 100% statements / 98.57% branches / 100%
  functions / 100% lines.
- `@vyaya/core` all files: 95.04% statements / 90.4% branches.
- `@vyaya/proxy` (src only, `index.ts` excluded): 90.87% statements /
  83.75% branches / 92.8% lines.

Coverage is a floor, not a target. The suites that matter (detectors,
proxy resilience, worker idempotency, RLS) are assertion-dense by design.

## How to run

```sh
pnpm test                          # everything, via turbo
pnpm --filter @vyaya/core test     # one package
scripts/e2e-local.sh               # full round trip, no Docker needed
scripts/e2e-local.sh               # SKIP_BUILD=1 to reuse built dist
```

Integration and e2e tests use `embedded-postgres` (user-space Postgres 16
binaries — no Docker, no sudo) and either in-memory fallbacks or
`ioredis-mock` for Redis. The e2e script builds a real Redis 7.4.5 from
source and runs every service from its compiled `dist`, including the
web app's standalone output.

The e2e round trip (11 assertions): mint a dev token via mock-deskid ->
web auth callback sets the session cookie -> create an API key -> proxy a
chat completion -> assert the `request_logs` row -> run the classifier
once -> assert 20 `waste_events` rows across all five types -> the
dashboard stats API reflects them -> anonymous stats calls get 401.
Reference run output: spend $0.1492, wasted $0.0942, waste rate 63.11%
over 106 seeded requests.

## The latency gate (the important one)

**Contract:** the proxy adds less than 10ms at p95, even with the logging
backend down.

**Methodology** (`apps/proxy/src/resilience.test.ts`): the inner log sink
is replaced with one that always throws, wrapped in the real
`RetryQueueLogSink` so retries and backpressure run as they would in
production. 200 requests go through the proxy interleaved with 200 direct
requests to the same mock upstream (50ms fixed latency, concurrency 8).
Added latency is the p95 of the per-pair deltas (proxy minus direct) — a
pair-delta estimator that cancels machine-speed drift instead of comparing
raw p95s.

**Measured:** 6.92ms and 6.53ms under full-suite coverage load;
3.7-4.4ms isolated across three consecutive runs. Raw p95s under load:
baseline 56.1ms, proxied 61.3-62.6ms.

**Why pair-delta:** absolute p95s move with machine load; the delta
between twin requests doesn't. Asserting raw proxy p95 < 10ms would flake
on any shared CI box. Asserting the delta asserts what we control.

## Known load sensitivity

Two knobs exist because of it:

- `apps/worker` runs vitest with `maxWorkers=2`.
- `apps/web` runs vitest with `maxWorkers=1`.

The full gate runs every package's suite concurrently. Embedded-Postgres
clusters are heavy; uncapped fan-out starved the proxy latency gate and
flaked it (observed: 17ms and 30ms deltas under contention vs <7ms
uncontended). With the caps, the gate passed three consecutive full runs.

If the latency test fails under the full gate, re-run the proxy suite in
isolation (`pnpm --filter @vyaya/proxy test`) before assuming a
regression. If it fails isolated too, that's real — go read
`ops/PERF_BUDGET.md`.

## Fixed flake, documented for history

The proxy byte-identity test had a second-boundary race: mock-openai's
`created` field came from `Date.now()`, so a request pair straddling a
second boundary could differ by one digit. Fixed in Stage 5 by deriving
`created` from the deterministic hash. If you see a byte-diff on
`created`, that fix regressed.

## What is NOT tested here

- Docker image builds and `docker compose up` (no daemon in the build
  sandbox; Dockerfiles follow the statically validated shared pattern).
- Real DeskId OAuth round trip (mock-deskid path is verified end-to-end;
  real DeskId wiring is compose-level and statically checked).
- Redis against a live server in unit tests (`ioredis-mock`; the e2e
  script does run real Redis).
