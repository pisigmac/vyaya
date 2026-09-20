# ops/RATE_LIMITS.md — every limit in the system

## Proxy: per-key sliding window

- **What:** `RATE_LIMIT_REQUESTS_PER_MINUTE`, default **600**, per API key
  (`apikey:<keyId>`), trailing 60-second sliding window.
- **Semantics:** a request is allowed when fewer than `limit` requests for
  the key landed in the trailing window. On rejection: HTTP 429,
  OpenAI-shaped error body (`rate_limit_exceeded`), `Retry-After` header
  in seconds (time until the oldest in-window request ages out).
- **Backends:** Redis sorted sets when `REDIS_URL` is set (key prefix
  `vyaya:rl:`, keys expire after the window), in-memory otherwise. Both
  share one pure decision function — identical semantics.
- **Fail-open:** Redis errors allow the request and log a warning
  (`redis rate-limit error; allowing request`). Proxy availability beats
  perfect limiting. The failure counter lives in-process.
- **Change it:** set `RATE_LIMIT_REQUESTS_PER_MINUTE`, restart the proxy.
  Per-workspace limits aren't built; the bucket key already includes the
  key id, so this is a small change when needed.

## DeskId: per-process (upstream constraint)

DeskId's rate limiter is **per-process**. Scaling DeskId beyond one
replica multiplies the effective limit by the replica count and breaks the
point of the limiter. Pin 1 replica — the compose `deskid` profile sets
`deploy.replicas: 1` and its limiter uses our shared Redis on logical db 1
(`AUTH_RATE_LIMIT_*` env in `docker-compose.yml`). If you run DeskId
outside compose, keep the replica count at 1 or accept N x the limit.

## Worker: job locks and batch bounds

- **Job lock TTL:** 30 minutes per run (Redis `SET PX NX` +
  compare-delete, in-memory fallback). On expiry a second scheduler may
  overlap — safe, jobs are idempotent.
- **Classify batch:** `CLASSIFY_BATCH_SIZE`, default 5000 logs per
  transaction. Bounds memory and transaction time.
- **Cadences:** `CLASSIFY_INTERVAL_MS` 24h, `WEEKLY_REPORT_INTERVAL_MS`
  6h, `RETENTION_SWEEP_INTERVAL_MS` 1h, `DESKID_RECONCILE_INTERVAL_MS`
  60s. These are polling intervals, not limits, but they're the knobs for
  worker load.

## Proxy internals (hard-coded, change with code)

| Limit | Value | Where |
| --- | --- | --- |
| Retry queue capacity | 10,000 logs; oldest dropped under backpressure | `RetryQueueLogSink` defaults |
| Flush cadence / batch | 1s / 500 logs | same |
| Write attempts per log | 3, then dropped (counted) | same |
| Response tap copy | 4MB bounded observability copy | `apps/proxy/src/tap.ts` |
| Auth cache | 30s positive, 5s negative | `apps/proxy/src/auth.ts` |
| Stripe call timeout | 2s | `apps/proxy/src/stripe.ts` |
| `X-Vyaya-Retry-Attempt` | integer 0-10,000 | header parsing |
| Session id / tag / retry-of | 256 / 128 / 128 chars | header parsing |
| Feature tags per workspace | 50 (BFF schema) | `apps/web/lib/schemas.ts` |

## Mock services (dev only)

- mock-openai: `MOCK_OPENAI_FAILURE_RATE` (0-1) injects random failures;
  `X-Mock-Fail: timeout` holds connections up to a 30s ceiling.
- mock-deskid: no rate limiting. Dev only, refuses to boot unless
  `AUTH_MODE=dev`.

## Redis memory policy

Rate-limit keys self-expire (`pexpire` = window, 60s), so idle keys
disappear within a minute. Job locks expire with their TTL. No explicit
`maxmemory` policy is set in the compose Redis; at these key volumes
(hundreds of keys, KBs each) it doesn't matter. If you add caches to
Redis later, set `maxmemory` + `allkeys-lru` in the same change.

## Web BFF

No HTTP rate limiting on the BFF in v0.1.0. Session verification is local
HMAC (cheap), stats queries are indexed and RLS-scoped. If abuse appears,
put the limit at the edge (reverse proxy) rather than in Next.js.
