# Future plan

A roadmap grounded in extension points that exist in the code today. Every
item below names the seam it builds on. Dates are quarters, not promises.
Risks are stated plainly — a roadmap that hides them is a sales deck.

## The extension points that already exist

| Seam | Where | What it enables |
| --- | --- | --- |
| `WasteDetector` interface | `packages/core/src/detectors/interface.ts` | New detectors, including LLM-judged ones, without touching the worker loop. |
| Detector registry + pinned versions | `detectors/registry.ts` | Side-by-side detector versions; reproducible re-runs. |
| `LogSink` interface | `packages/core/src/logsink/interface.ts` | ClickHouse sink already written (`CLICKHOUSE_URL`); other sinks slot in. |
| `EnvelopeCipher` (master key from env) | `packages/core/src/crypto/envelope.ts` | KMS adapter: fetch the master key from a KMS at boot; the cipher only depends on key material. |
| `UPSTREAM_MODE` | `apps/proxy` config | `openai` today, `kubemind` router URL plumbed. |
| `SENTINEL_ENABLED` + `SENTINEL_OTEL_URL` | proxy + worker `otel.ts` | OTel export, currently dynamic-import no-op. |
| `workspaces.detector_thresholds` | DB column | Per-workspace threshold overrides (worker already merges them). |
| `stripe_meter_events` outbox | DB + `apps/proxy/src/stripe.ts` | Durable usage records, retry-safe via idempotency keys. |
| `DESKID_RECONCILE_ENABLED` | worker job | Identity sync without per-request DeskId calls. |

## Q1 — prove the core loop

**Theme: from "detected" to "fixed".**

- **Fix tracking.** A waste event can be marked addressed; the dashboard
  shows dollars recovered week over week. Requires a small schema addition
  (`waste_events.resolved_at` or a side table) — no new infrastructure.
- **Alert on new waste.** A fifth worker job: waste rate jumps >X points
  week over week, email the workspace. Reuses the `EmailSender` interface.
- **Second upstream.** Anthropic-shaped passthrough behind another
  `UPSTREAM_MODE` value. The proxy's tap/extract layer is
  OpenAI-specific today; this is the real cost of the work, and it's why
  it's Q1 and not next week.
- **Live Stripe checkout.** The meter-event plumbing is done (test mode);
  what's missing is the entitlement mapping from Stripe customer to
  workspace (`workspaces.stripe_customer_id` column already exists) and
  the checkout flow itself.

**Risks.** Fix tracking changes what the product promises — "we show
waste" becomes "we prove recovery". That raises the bar on detector
precision. False positives become expensive.

## Q2 — judgment where heuristics stop

- **LLM-judged detectors.** The interface already allows it:
  `WasteDetector.detect(ctx)` returns events; nothing says the
  implementation must be deterministic string math. A judged detector
  (e.g. "was this completion actually usable?") slots into the registry
  with its own version, its own evidence shape, and — critically — its own
  cost accounting, because judging costs tokens. Ship it off by default,
  per-workspace opt-in, like body logging.
- **Per-workspace upstream URLs.** Today the upstream is global
  (`OPENAI_BASE_URL`). Moving it onto the workspace row lets one
  deployment serve teams on different providers or KubeMind routers.
  Proxy auth already resolves the workspace before forwarding, so the seam
  is clean; the work is caching and config surface.
- **ClickHouse in anger.** The sink exists and is config-gated. Q2 is
  when a real workload justifies turning it on: migration tooling for
  historical logs, and the dashboard reads abstracted behind a query
  interface instead of hard-wired Postgres SQL.

**Risks.** LLM-judged detectors break the "deterministic, zero LLM cost"
promise that's in our marketing. Mitigation: judged detectors are additive
and labeled; heuristic v1 results never change. The ClickHouse migration
is a data move — plan for a dual-write window, not a flag day.

## Q3 — platform shape

- **KMS adapter.** `EnvelopeCipher` takes key material, not a source.
  Q3 ships a KMS-backed master key (AWS KMS or GCP KMS at boot, cached in
  process), key rotation procedure, and the ops doc update. The envelope
  format doesn't change — wrapped DEKs stay valid.
- **Multi-region proxy.** The proxy is stateless except the auth cache and
  the in-memory rate limiter. Redis-backed rate limiting already exists;
  the auth cache needs a shared invalidation path (short TTLs mostly cover
  it today — revocation propagates in 30s).
- **Audit log UI.** `detector_runs`, key revocations, settings changes are
  all recorded; they need a screen. Read-only, exportable.

**Risks.** Multi-region turns the per-workspace Postgres RLS model into a
latency question. Don't start it before the query patterns are measured.

## Q4 — the honest maybe

- **Automatic remediation.** The strongest version of the product: Vyaya
  doesn't just suggest the idempotency key fix, it opens the PR. This is
  speculative on purpose. It depends on Q1 fix tracking proving that users
  act on suggestions at all.
- **Waste benchmarks.** Aggregate, anonymized, opt-in only: "your retry
  rate vs. the fleet". Requires enough tenants to anonymize honestly — a
  chicken-and-egg problem we won't fake.

## What we're not doing

- **A model router.** KubeMind exists; we integrate with it
  (`UPSTREAM_MODE=kubemind`), we don't rebuild it.
- **Evals.** LangSmith and friends own that. We judge spend, not quality.
- **A free-forever hosted tier at scale.** The proxy's cost model
  (`docs/PRICING.md`) is fine at team volume; an unlimited free tier is a
  support and abuse problem, not a growth strategy.
