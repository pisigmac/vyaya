# Vyaya documentation hub

Every doc in this repo, what it's for, and the order to read it in. If a doc
and the code disagree, the code wins — then file a fix for the doc.

## Index

### docs/

| File | Purpose |
| --- | --- |
| `README.md` | This file. The map. |
| `FEATURES.md` | Every shipped feature: what it does, how to use it, limits. |
| `ARCHITECTURE.md` | System diagram, data flow, trust boundaries, encryption, failure modes. |
| `API.md` | HTTP reference: proxy endpoints, web BFF routes, worker health, mock services. |
| `OPENAPI.yaml` | OpenAPI 3.1 spec covering proxy, web BFF, and worker health. |
| `DB_SCHEMA.md` | Tables, columns, enums, indexes, RLS policies, migrations. |
| `ENV.md` | Every environment variable, validated by `@vyaya/config`. Kept in lockstep with `.env.example`. |
| `CODEMAP.md` | Where things live in the monorepo, package by package. |
| `TECH_STACK.md` | Pinned versions and why they were chosen. |
| `TESTS.md` | Suite inventory, coverage numbers, the latency gate, known flakes. |
| `DEPLOY.md` | Runbook: compose profiles, first-run checklist, production notes. |
| `INTEGRATIONS.md` | DeskId, KubeMind, Sentinel, Resend, Stripe contracts and failure behavior. |
| `PRICING.md` | Stripe meter-event design and proposed tiers with the math behind them. |
| `ANALYTICS.md` | Metric definitions: waste rate, projected savings, event taxonomy, query semantics. |
| `ERRORS.md` | Error catalog with remediation, plus the npm-audit policy. |
| `MARKETING.md` | Positioning, ICP, messaging pillars, landing-copy rationale. |
| `SOCIAL.md` | Ready-to-post social copy and the launch checklist. |
| `FUTURE_PLAN.md` | Roadmap grounded in the extension points that exist in the code today. |
| `CHANGELOG.md` | Release history. v0.1.0 is the initial build. |
| `ASSUMPTIONS.md` | Every assumption made during the build, numbered and dated. |
| `CLAUDE.md` | Rules for AI coding assistants (Claude) working in this repo. |
| `AGENTS.md` | Same rules, tool-neutral, for any coding agent. |

### ops/

| File | Purpose |
| --- | --- |
| `MONITORING.md` | Health endpoints, what to alert on, log fields, OTel spans. |
| `PERF_BUDGET.md` | The <10ms p95 proxy budget: measured numbers and what to do when exceeded. |
| `RATE_LIMITS.md` | Every limit in the system and how to change it. |
| `FEATURE_FLAGS.md` | Every flag: default, owner, blast radius, how to flip. |
| `DATA_RETENTION.md` | The 7d / 400d / forever policy and the sweeper that enforces it. |
| `EVENTS.md` | Event and telemetry catalog: waste events, meter events, spans, logs. |
| `PAYMENTS.md` | Stripe operations: meter-event flow, test-mode setup, reconciliation. |
| `EMAIL.md` | Resend setup, weekly report content, deliverability, failure behavior. |
| `STAGING.md` | Standing up a staging environment and promoting to prod. |
| `EMPTY_STATES.md` | Every empty state in the UI: copy, CTA, recovery path. |

## Reading order

### New engineer (first day)

1. Root `README.md` — what Vyaya is, the layout, the quick start.
2. `docs/ARCHITECTURE.md` — the shape of the system and the hard rules.
3. `docs/CODEMAP.md` — where the code lives.
4. `docs/ENV.md` + `.env.example` — get a local stack booting.
5. `docs/TESTS.md` — how to prove a change didn't break anything.
6. `docs/CLAUDE.md` or `docs/AGENTS.md` if an AI assistant writes code with you.

### New engineer (first week)

7. `docs/DB_SCHEMA.md` — the tables and the RLS model.
8. `docs/API.md` — the surfaces you'll touch.
9. `docs/INTEGRATIONS.md` — DeskId first; the rest are flag-gated.
10. `docs/ANALYTICS.md` — the metric definitions behind the dashboard.
11. `docs/ASSUMPTIONS.md` — read it before you "fix" something that looks odd.

### Operator / on-call

1. `docs/DEPLOY.md` — how the stack comes up.
2. `ops/MONITORING.md` — what to watch and what to alert on.
3. `ops/PERF_BUDGET.md` — the proxy latency contract.
4. `ops/RATE_LIMITS.md` and `ops/FEATURE_FLAGS.md` — the knobs.
5. `ops/DATA_RETENTION.md` — the deletion guarantees you've promised users.
6. `docs/ERRORS.md` — what each error means and how to clear it.

### Founder / go-to-market

1. `docs/MARKETING.md` — positioning and pillars.
2. `docs/PRICING.md` — tiers and the math.
3. `docs/SOCIAL.md` — launch copy and checklist.
4. `docs/FUTURE_PLAN.md` — what ships next and why.
