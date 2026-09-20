# Analytics

Metric definitions. When a number on the dashboard looks wrong, this doc
is the arbiter — then `apps/web/lib/bff/stats.ts`, which is the
implementation.

## Core metrics

### waste_rate

```
waste_rate = dollars_wasted(30d) / total_spend(30d)
```

- `total_spend`: sum of `request_logs.cost_usd` for the workspace where
  `occurred_at >= now() - 30 days`.
- `dollars_wasted`: sum of `waste_events.dollars_wasted` where
  `detected_at >= now() - 30 days`.
- 0 when there's no spend (division guard, not a claim of zero waste).

**Why detection time for waste, occurrence time for spend.** Detectors run
over recent logs in batches; an event's honest timestamp is when the
detector found it. Spikes in waste rate right after enabling Vyaya are
expected — the first classify run finds the backlog.

### dollars_wasted per event

Computed by the detector, rounded to 8 decimal places:

| Waste type | Formula |
| --- | --- |
| `ghost_output` | Full call cost (`cost_usd`). |
| `retry_storm` | Sum of `cost_usd` over every attempt before the first success in the cluster. |
| `schema_failure_burn` | Full call cost. |
| `context_amnesia` | `similarity x input_cost_usd` of the later turn, summed over wasted turns. |
| `overprovisioned_max_tokens` | `(max_tokens - completion_tokens) x inferred output price x 0.10` per call, summed over the run. Zero-completion calls contribute nothing (no price signal). |

Costs themselves come from the versioned price table
(`packages/core/src/cost/price-table.ts`, version `2026-01-01.v1`), never
from client claims. Unknown models log cost 0 with a warning — they never
block the request and never get guessed at.

### projected_annual_savings

```
projected_annual_savings = (dollars_wasted(30d) / 30) * 365        (dashboard fixes)
projected_annual_savings = weekly_waste * 52                        (weekly report)
```

Both are run-rate extrapolations. The dashboard divides the trailing 30
days evenly; the weekly report multiplies the completed week by 52. They
assume the current rate holds — the UI says so next to the number. The two
conventions can disagree by a few percent on bursty traffic; that's
expected, not a bug.

## Event taxonomy

`waste_events` rows. Every event: `workspace_id`, `waste_type`,
`request_ids` (implicated logs), `dedupe_key`, `dollars_wasted`,
`evidence` (detector-specific JSON), `detector_version`, `suggested_fix`,
`detected_at`.

| waste_type | Unit of waste | Key evidence fields |
| --- | --- | --- |
| `ghost_output` | One event per unconsumed response | `promptTokens`, `completionTokens`, `ageMs`, `minAgeMs` |
| `retry_storm` | One event per identical-prompt cluster | `promptHash`, `attemptCount`, `windowMs`, `wastedAttemptIds`, `succeededRequestId` |
| `schema_failure_burn` | One event per failed-validation response | `model`, `endpoint`, token counts |
| `context_amnesia` | One event per session per run | `sessionId`, `turnCount`, `wastedTurnCount`, per-turn `similarity`/`overlapTokens`/`wastedUsd` |
| `overprovisioned_max_tokens` | One event per consecutive low-ratio run | `model`, run length, `avgRatio`, excess tokens |

Full catalog with the pino/OTel side: `ops/EVENTS.md`.

## Dashboard query semantics

| Query | Source | Window | Semantics |
| --- | --- | --- | --- |
| Summary | request_logs + waste_events | 30d | As above. |
| Trend | both, grouped by UTC day | `days` 7-90 | Spend by `occurred_at::date`; waste by `detected_at::date`; zero-filled days via `generate_series`. |
| Breakdown by waste_type | waste_events | `days` 1-90 | Straight sum + count per type. |
| Breakdown by endpoint / feature_tag | waste_events JOIN request_logs | `days` 1-90 | Each event's dollars split evenly across its implicated request ids, then grouped. Untagged logs group under `(untagged)`. |
| Waste events | waste_events | none | Paginated (page >=1, pageSize <=100), sorted by dollars or recency, optional type filter. |
| Top fixes | waste_events | 30d | Per-type totals, top 3, fix text from the most recent event of each type. |

**Attribution rule (documented, deliberate).** An event's dollars are
shared evenly by the requests that caused it. A retry storm that wasted 3
attempts attributes a third of its dollars to each. This means
endpoint/tag breakdowns are allocation views, not ledger-exact — the
waste_type breakdown is always exact.

**Tenant isolation.** Every stats query runs inside `withWorkspace`
(RLS-scoped transaction) AND carries an explicit `workspace_id` filter.
Both, always. Cross-tenant reads are tested (`rls.test.ts`, web stats
tests).

## Reference numbers (e2e seed data)

The e2e assertion run classifies the seeded workspace to: spend $0.1492,
wasted $0.0942, waste rate 63.11%, 106 requests, 20 events
(ghost_output x8 $0.0650, schema_failure_burn x6 $0.0035, retry_storm x3
$0.0008, context_amnesia x2 $0.0118, overprovisioned_max_tokens x1
$0.0131). Synthetic data engineered to trip every detector — 63% is a
demo number, not a market claim.

## Known limitations

- **Detection lag.** Classify runs every 24h by default, so "30d waste"
  excludes traffic newer than the last run. The dev-only "Run the
  classifier now" button exists for demos.
- **Batch scope.** Detectors see one batch (5000 logs default) at a time.
  Patterns straddling a boundary are scored per batch.
- **Bodies gate one detector.** `context_amnesia` needs prompt text;
  metadata-only workspaces get zero events of that type.
- **Estimates.** Streams without `include_usage` and unparseable bodies
  fall back to deterministic token estimates
  (`packages/core/src/prompt/`). The price table only prices models it
  knows; everything else is 0 with a warn log.
