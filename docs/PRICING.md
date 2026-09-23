# Pricing

The Stripe design as plumbed in v0.1.0 (test mode only — no live checkout)
and the proposed tiers with the math behind them.

## What's built

- **Meter events.** When `STRIPE_ENABLED=true`, the proxy records one
  usage record per request: event name `vyaya.llm_tokens`
  (`STRIPE_METER_EVENT_NAME`), payload `{ request_id, workspace_id,
  tokens }`, timestamp in Unix seconds. Posted to Stripe's
  `POST /v2/billing/meter_events` with a 2s timeout.
- **Fire-and-forget.** Billing never blocks or fails a user request. Two
  side effects per record, both best-effort: the direct Stripe call and an
  outbox row.
- **Outbox.** `stripe_meter_events` (workspace_id, request_id, event_name,
  idempotency_key = request id, payload, status pending/sent/failed,
  stripe_event_id, timestamps). The idempotency key makes both the outbox
  write and the Stripe API call retry-safe; a worker flush reconciles.
- **Test mode only.** `STRIPE_SECRET_KEY` takes a test key. There is no
  checkout, no customer portal, no live charging in v0.1.0.

Operations detail (setup, reconciliation, failure handling):
`ops/PAYMENTS.md`.

## The cost model (why the tiers are what they are)

What it costs us to serve one proxied request:

| Component | Per-request cost driver | Notes |
| --- | --- | --- |
| Proxy compute | ~2-5ms CPU | Hono on Node; measured p95 added latency 3.7-6.9ms including tap + logging continuation. |
| Log storage (Postgres) | ~300-500 bytes/row in `request_logs` + indexes | 400-day retention; the retention sweeper rolls old rows into `daily_aggregates`. |
| Body storage (opt-in) | ~2-20KB/row, 7 days only | Encrypted; bounded by `BODY_RETENTION_DAYS=7`. |
| Worker classify | One batch scan per workspace per day | Detectors are pure CPU; a 100k-request workspace classifies in minutes. |
| Redis | ~1 sorted-set member per request, 60s TTL | Bounded by rate-limit window. |

A team doing 2M requests/month produces roughly 1GB of metadata per year
after rollups — single-digit dollars of storage. The real costs are
compute at the proxy edge and support. That argues for request-volume
limits rather than token-volume limits: our meter is requests logged, with
tokens reported to Stripe for usage visibility.

## Proposed tiers

| | Free | Team | Business |
| --- | --- | --- | --- |
| Price | $0 | $49/workspace/mo | $249/workspace/mo |
| Requests logged / mo | 100,000 | 2,000,000 | 25,000,000 |
| Workspaces | 1 | 5 | unlimited |
| Dashboard window | 30d | 90d | 90d |
| Body logging | off (metadata only) | opt-in | opt-in |
| Weekly report | email, 1 recipient | email + PDF | email + PDF |
| Detector threshold overrides | — | yes | yes |
| Per-workspace upstreams (KubeMind) | — | — | yes |
| Support | community | email | email + SLA |

**Overage thinking (not built):** soft-cap at 110% of the tier with an
email, hard-cap at 150% — the hard-cap path already exists as the 429
machinery, just keyed on monthly volume instead of per-minute rate.

## The math

Assumptions from the codebase and measured numbers:

- **Value anchor.** The seed/e2e demo data shows a 63% waste rate on
  synthetic traffic; real fleets we modeled sit lower, so price against a
  conservative 10-20% waste rate. A Team-tier customer spending
  $2,000/month on LLM tokens at 15% waste has $300/month of recoverable
  spend. $49 is 16% of one month's recoverable waste — the tool pays for
  itself if it kills one-sixth of the waste once.
- **Cost floor.** 2M requests/month at ~4ms added CPU each is ~2.2 CPU-
  hours — noise. Storage ~90MB/month pre-rollup. Support dominates COGS,
  which is why Business is priced on support and multi-workspace
  management, not on compute.
- **Free tier sizing.** 100k requests/month is enough for a real
  evaluation (a side project or one staging environment) and small enough
  that free users can't meaningfully load the fleet. Free is a trial with
  no time limit, not a hobby tier we plan to grow.
- **Business jump (5x).** Buys: 12.5x the volume, unlimited workspaces,
  per-workspace upstream routing, and an SLA. The multiple is priced
  against the value of fleet-wide waste visibility for a platform team,
  not against our cost, which barely moves.

## What needs building before this is real

1. Stripe customer <-> workspace mapping (the
   `workspaces.stripe_customer_id` column exists, unused).
2. Checkout + portal (test-mode plumbing only today).
3. Monthly volume metering per workspace (the outbox table has the raw
   material; needs a rollup query and the soft/hard cap path).
4. Entitlement checks in the BFF (viewer/operator/admin exist; plan
   gating does not).

Until those ship, `STRIPE_ENABLED` is plumbing verification, not billing.
