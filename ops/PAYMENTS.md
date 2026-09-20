# ops/PAYMENTS.md — Stripe operations

v0.1.0 status: test-mode plumbing only. `STRIPE_ENABLED=true` records
usage; nothing charges anyone. No checkout, no portal, no live keys.

## How meter events flow

```
proxied request completes
  -> proxy finalize() calls UsageRecorder.record()
       (fire-and-forget; user response already sent)
  -> two best-effort side effects:
     1. POST https://api.stripe.com/v2/billing/meter_events
        event_name = STRIPE_METER_EVENT_NAME (default vyaya.llm_tokens)
        payload    = { request_id, workspace_id, tokens }
        timestamp  = request time, unix seconds
        timeout    = 2s
     2. outbox row in stripe_meter_events
        idempotency_key = request_id   (retries are safe)
        status = pending
  -> worker/ops flush reconciles pending rows
     (status -> sent with stripe_event_id, or failed with error)
```

The idempotency key is the request id, so replays of the same request
can't double-count in Stripe or in the outbox.

## Test-mode setup

1. Create a Stripe account, stay in test mode.
2. Create a meter: event name must equal `STRIPE_METER_EVENT_NAME`
   (`vyaya.llm_tokens`), aggregation `sum` over the `tokens` payload
   field.
3. Set in `.env`:
   ```
   STRIPE_ENABLED=true
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_METER_EVENT_NAME=vyaya.llm_tokens
   ```
4. Restart the proxy. Send one request through it, then check:
   `SELECT status, stripe_event_id, error FROM stripe_meter_events
    ORDER BY created_at DESC LIMIT 5;`

## Keys

- Only test keys (`sk_test_...`) until live billing is designed and
  reviewed. The config schema doesn't enforce the prefix — ops policy
  does. This file is the policy.
- Keys live in env, never in the repo. Rotate like any secret; the proxy
  reads the key at boot, so rotation means a restart.

## Reconciliation

Weekly, or after any Stripe API incident:

1. `SELECT count(*) FROM stripe_meter_events WHERE status = 'pending';`
   — should trend to zero. A growing backlog means the flush path or the
   API is unhealthy.
2. `SELECT count(*), status FROM stripe_meter_events GROUP BY status;`
   next to Stripe's meter event stream in the dashboard. Counts won't
   match one-to-one during backpressure; the request-id idempotency keys
   are the join.
3. `status = 'failed'` rows carry the Stripe error message in `error`.
   Permanent failures (bad payload shape) need a code fix, not a retry.

## Failure handling

| Failure | Effect | Action |
| --- | --- | --- |
| Stripe API down / slow | Meter call times out (2s) or errors; outbox row stays `pending`. User requests unaffected — always. | Watch `stripe usage record failed` warnings. No page; reconcile later. |
| Postgres down | Outbox insert fails; the direct Stripe call may still land (that's why the idempotency key matters). | Nothing immediate; dedupe on reconcile. |
| Proxy restart mid-flight | In-process counter resets; outbox is the durable record. | Reconcile from the outbox, not the logs. |

## When live billing ships

The tier design and math are in `docs/PRICING.md`. Before flipping any
live key: customer<->workspace mapping (`workspaces.stripe_customer_id`
exists), checkout flow, entitlement checks, and a second review of this
runbook.
