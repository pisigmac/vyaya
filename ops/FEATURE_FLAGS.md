# ops/FEATURE_FLAGS.md

Every flag, its default, who owns it, and what breaks if you flip it
casually. All flags are env vars validated by `@vyaya/config`; all default
to off except `AUTH_MODE` and `UPSTREAM_MODE` which are mode selectors.

## Flag table

| Flag | Default | Owner | Blast radius | How to flip |
| --- | --- | --- | --- | --- |
| `AUTH_MODE` | `dev` (web/proxy), `deskid` (mock guard) | identity | Everything user-facing. `dev` swaps in the mock issuer — never in prod. | Set `deskid`, point `DESKID_*` at a real DeskId, restart web+proxy+worker. |
| `STRIPE_ENABLED` | `false` | billing | None when off. When on: one outbox row + one Stripe call per request, both fire-and-forget. | Set `true` + `STRIPE_SECRET_KEY` (test key), restart proxy. |
| `SENTINEL_ENABLED` | `false` | observability | None when off (no-op tracer, OTel packages never imported). When on: span export per request/job. | Set `true` + `SENTINEL_OTEL_URL`, restart proxy+worker. |
| `DESKID_RECONCILE_ENABLED` | `false` | identity | Off: grants sync only at login. On: worker polls DeskId every `DESKID_RECONCILE_INTERVAL_MS` (60s). | Set `true`, restart worker. Requires `DESKID_BASE_URL` + (real DeskId) `DESKID_ADMIN_TOKEN`. |
| `LOG_BODIES` | `false` | privacy | Deployment-level master switch. Even `true`, bodies are stored only for workspaces with `log_bodies_enabled`. | Set `true` + a real `MASTER_ENCRYPTION_KEY`, restart proxy. |
| `CLICKHOUSE_URL` | unset | data | Unset: Postgres sink (default, fully working). Set: request logs go to ClickHouse. | Set the URL, start the `clickhouse` compose profile, restart proxy. No backfill — see below. |
| `UPSTREAM_MODE` | `openai` | routing | Where proxied traffic goes. `kubemind` requires `KUBEMIND_ROUTER_URL`. | Set + router URL, restart proxy. Applies globally per deployment. |
| `RESEND_API_KEY` | unset | reporting | Unset: recording stub; reports still generated and stored. | Set the key + `EMAIL_FROM`, restart worker. |

## Dependencies and interactions

- `LOG_BODIES=true` without a valid `MASTER_ENCRYPTION_KEY` fails config
  validation at boot — the proxy won't start with a half-configured
  privacy story. Bodies also require the per-workspace opt-in; the flag
  alone stores nothing.
- `CLICKHOUSE_URL` and the Postgres sink are mutually exclusive per
  deployment. Switching sinks does not migrate history. Plan a dual-write
  window for a live switch (`docs/FUTURE_PLAN.md` Q2).
- `STRIPE_ENABLED=true` without `STRIPE_SECRET_KEY` uses the stub API —
  outbox rows are written, nothing leaves the building. Useful for
  testing the outbox itself.
- `DESKID_RECONCILE_ENABLED=true` against mock-deskid works (the mock
  serves a real reconciliation feed) and needs no admin token.
- `SENTINEL_ENABLED=true` without `SENTINEL_OTEL_URL` is a graceful no-op.
- `AUTH_MODE=dev` also enables the web's `POST /api/onboarding/classify`
  button (403 otherwise). The mock-deskid service itself refuses to boot
  in any other mode.

## Rules for new flags

1. Default off. The system must build, boot, and pass all 383 tests with
   every flag off.
2. Interfaces compile with the flag off (no conditional imports breaking
   the build; use the dynamic-import no-op pattern from `otel.ts`).
3. Register in `@vyaya/config` with a zod default, add to `.env.example`
   and `docs/ENV.md`, and add a row here with an owner and blast radius.
