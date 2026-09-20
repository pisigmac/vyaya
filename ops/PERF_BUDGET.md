# ops/PERF_BUDGET.md — the proxy latency budget

## The budget

**The proxy adds less than 10ms at p95 to any proxied request, even when
the logging backend is down.**

This is a hard contract, not an aspiration. It's enforced by
`apps/proxy/src/resilience.test.ts` on every `pnpm test`.

## Measured numbers

From the Stage 4A gate (200 proxied + 200 direct requests, 50ms upstream
latency, concurrency 8):

| Condition | p95 added latency |
| --- | --- |
| Full-suite coverage load, run 1 | 6.92ms |
| Full-suite coverage load, run 2 | 6.53ms |
| Isolated (3 consecutive runs) | 3.7-4.4ms |

Raw p95s under load: direct baseline 56.1ms, proxied 61.3-62.6ms. The
upstream dominates; we own the delta.

## Methodology (why pair-delta)

The test doesn't assert raw proxy p95. It interleaves proxied and direct
requests against the same mock upstream and computes the p95 of the
per-pair deltas (proxy minus direct). Machine speed, GC pauses, and CI
contention move both legs of the pair, so the delta isolates what the
proxy actually adds. A raw-threshold test would flake on any shared box —
and did, before this estimator (see `docs/TESTS.md`).

## Per-component budget (informal split of the 10ms)

| Component | Budget share | What it does |
| --- | --- | --- |
| Auth (cache hit) | ~1ms | Map lookup. Cache miss adds an argon2id verify (~50-100ms) on ONE request per 30s per key — p95 is unaffected. |
| Rate limit (in-memory) | <0.5ms | Pure function over an array of timestamps. Redis path adds a network RTT (~1ms LAN). |
| Header parse + body read | ~1ms | Text read of the request body; zod-free, regex-validated. |
| Upstream fetch setup | ~1ms | Header copy, `fetch` dispatch. |
| Response tap | ~1-2ms | Per-chunk pass-through with a bounded 4MB copy. |
| Finalize (post-response) | 0ms to the client | Logging runs after the client has the bytes. Never on the response path. |

The finalize step — token extraction, cost computation, sink enqueue,
Stripe record — is deliberately outside the budget because it happens
after the response is delivered. If you move any of it before the
response, you're spending the budget. Don't.

## When the budget is exceeded

1. **Reproduce isolated first.** `pnpm --filter @vyaya/proxy test`. The
   full gate runs every package concurrently and embedded-Postgres
   clusters are CPU-heavy; a full-gate failure with a green isolated run
   is the known load flake, not a regression (worker and web suites are
   worker-capped for this reason).
2. **Profile the delta, not the service.** Log per-request elapsed time
   in the handler; look for a new await on the request path. Common
   suspects: a new DB call in auth, a synchronous JSON.parse of a large
   body, header copying done per-chunk instead of once.
3. **Check the tap.** Anything that buffers the full response before
   streaming breaks the byte-flow model and will blow the budget on large
   completions. The tap must forward chunks as they arrive.
4. **Never "fix" it by weakening the test.** The 10ms number is the
   product's answer to "won't a proxy slow us down". If the code can't
   meet it, the code changes.
