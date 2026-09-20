# Architecture

How Vyaya fits together, where the trust boundaries are, and what breaks
how. Read this before `docs/CODEMAP.md`.

## System diagram

```
                        ┌──────────────────────────────────────────────┐
                        │                 your app                      │
                        │   OpenAI SDK, base_url -> Vyaya proxy         │
                        └───────────────┬──────────────────────────────┘
                                        │ X-Vyaya-Key (+ Session/Tag/Retry-*)
                                        ▼
┌──────────┐   JWKS (cached)   ┌─────────────────┐    passthrough    ┌───────────────┐
│  DeskId  │◄──────────────────│   apps/proxy     │─────────────────►│   upstream     │
│ (or mock │   verify RS256    │   Hono, :8787    │  bytes untouched │ OpenAI / mock- │
│  deskid) │                   │                  │◄─────────────────│ openai /       │
└────┬─────┘                   │  observe-only:   │    tap stream    │ KubeMind router│
     │ OAuth redirect          │  log metadata +  │                  └───────────────┘
     │                         │  cost (price     │
     ▼                         │  table, server-  │
┌─────────────────┐            │  side)           │
│   apps/web       │           └───────┬──────────┘
│   Next.js :3000  │                   │ fire-and-forget (RetryQueueLogSink,
│   dashboard+BFF  │                   │ 10k queue, 1s flush, 3 attempts)
└───────┬─────────┘                    ▼
        │ RLS-scoped          ┌─────────────────┐        ┌──────────────────┐
        │ SQL (vyaya_app)     │  Postgres 16     │◄───────│  apps/worker      │
        └────────────────────►│  request_logs    │ read   │  :8790 health    │
                              │  request_bodies  │───────►│  classify        │
                              │  waste_events    │ write  │  weekly-report   │
                              │  + 10 more       │        │  retention-sweep │
                              └─────────────────┘        │  deskid-reconcile│
                                ▲                        └───────┬──────────┘
                                │ reports volume                 │ Resend / PDF
                                └────────────────────────────────┘
                              ┌─────────────────┐
                              │  Redis 7         │  rate-limit windows +
                              │  (optional dev)  │  job locks (in-memory
                              └─────────────────┘  fallback, same semantics)

Flag-gated, off by default: ClickHouse sink (CLICKHOUSE_URL), Stripe meter
events (STRIPE_ENABLED), Sentinel OTel (SENTINEL_*), DeskId reconciliation
(DESKID_RECONCILE_ENABLED), KubeMind upstream (UPSTREAM_MODE=kubemind).
```

## Request data flow

1. **Request arrives at the proxy.** Auth first: `X-Vyaya-Key` is looked
   up by last4 candidates, verified against the argon2id hash, cached 30s
   (positive) / 5s (negative). Fail-closed: no key, no attribution, no
   proxying.
2. **Rate limit.** Per-key sliding window, 600/min default. Redis when
   configured, in-memory otherwise. Redis errors fail open — the proxy
   prefers availability to perfect limiting.
3. **Passthrough.** Hop-by-hop headers stripped, client `Authorization`
   dropped, upstream credential injected, `Accept-Encoding: identity`
   forced. The response streams through a byte-faithful tap (bounded 4MB
   observability copy). The client gets upstream bytes with upstream
   status.
4. **After the client has the bytes**, the proxy finalizes: token usage
   (provider `usage` field, else deterministic estimate; zero on errored
   calls), cost from the versioned price table, schema validation result,
   prompt hash, retry metadata. The record goes into the retry queue and
   the request is done. Logging never touches the response path.
5. **Sink.** `PostgresLogSink` (default) writes `request_logs` with
   `ON CONFLICT (request_id) DO NOTHING`. `ClickHouseLogSink` when
   `CLICKHOUSE_URL` is set. Bodies, when opted in, are AES-256-GCM
   encrypted under the workspace DEK before leaving the proxy.
6. **Classify.** The worker (default every 24h) walks each workspace's
   unprocessed logs in batches of 5000, runs the five detectors, and
   writes `waste_events` with dedupe keys. Batch commit = events +
   checkpoint row in one transaction.
7. **Dashboard.** The web BFF reads through RLS-scoped transactions
   (`withWorkspace` + explicit `workspace_id` filters) and renders waste
   rate, trend, breakdown, top fixes, events.
8. **Weekly.** The report job renders a pdf-lib PDF per workspace, stores
   the row + file, emails via Resend when configured.

## Trust boundaries

| Boundary | Crossed by | Controls |
| --- | --- | --- |
| Internet -> proxy | Untrusted client traffic | API key auth (argon2id at rest), per-key rate limit, zod on headers, no client cost claims ever trusted. |
| Internet -> web | Browsers | DeskId RS256 JWT verified statelessly (JWKS cached, kid refresh), HMAC session cookie (HttpOnly, SameSite=Lax, Secure in prod), CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy on every response. |
| Apps -> Postgres | All services | RLS ENABLE + FORCE on all 13 tables. App role `vyaya_app` is NOLOGIN and non-BYPASSRLS; tenant queries run under `SET LOCAL app.workspace_id` plus explicit filters. |
| Proxy/worker -> bodies | Prompt/response text | AES-256-GCM envelope encryption; bodies exist only for opted-in workspaces; 7-day retention enforced by the sweeper. |
| Services -> DeskId | Login, grants, reconcile | Never per-request; JWKS cached with kid-triggered refresh; reconciliation feed is zod-validated and malformed events are skipped. |
| Services -> Stripe/Resend | Meter events, email | Fire-and-forget with outbox rows; failures never block user traffic or report storage. |

## Encryption design

Envelope encryption, AES-256-GCM throughout
(`packages/core/src/crypto/envelope.ts`).

- **Master key (KEK).** 32 bytes from `MASTER_ENCRYPTION_KEY` (64 hex
  chars in env). Wraps and unwraps workspace DEKs.
- **Workspace DEK.** Random 256-bit key per workspace, generated on first
  body-logging opt-in. Stored in `workspaces.wrapped_dek` as base64
  ciphertext + 12-byte IV + 16-byte GCM tag. A database leak without the
  master key yields nothing readable.
- **Body payloads.** Each prompt/response body is encrypted under the
  workspace DEK: base64 ciphertext + IV + auth tag in
  `request_bodies.prompt_envelope` / `response_envelope`. Fresh IV per
  payload.
- **KMS upgrade path.** `EnvelopeCipher` depends on 32 bytes of key
  material, not on where it came from. The upgrade is a boot-time fetch:
  pull the master key from a KMS instead of env. No format change, no
  re-wrapping, no migration. Scheduled in `docs/FUTURE_PLAN.md` Q3.
- **Rotation.** Master key rotation means re-wrapping every DEK (cheap,
  one UPDATE per workspace) — bodies don't need re-encryption because the
  DEKs don't change.

## Failure modes

| Failure | Behavior | Signal |
| --- | --- | --- |
| Postgres down | Proxy keeps serving; logs queue in memory (10k cap), oldest dropped under backpressure. Auth fails closed only for keys not in the 30s cache (503 `auth_unavailable`). | `/healthz` queue metrics: `queueDepth`, `droppedBackpressure`. |
| Redis down | Rate limiting fails open (requests allowed, errors counted); worker job locks fall back to in-memory. | `redis rate-limit error; allowing request` warnings. |
| ClickHouse down | Same as Postgres-down for the sink (retry queue). Proxy unaffected. | Queue metrics. |
| DeskId down | Existing sessions keep working (HMAC cookie, no callback). New logins fail. JWKS cached; unknown kid triggers one refresh attempt. | Web 401s at callback; JWKS fetch warnings. |
| Stripe down | Meter events fail fire-and-forget; outbox rows stay `pending` for the flush path. | `stripe usage record failed` warnings; outbox row status. |
| Resend down / unset | Report row + PDF stored regardless; status `generated` (not `emailed`). | Report row, stub-send log line. |
| Worker crash mid-classify | In-flight batch rolls back; next run resumes at the last committed checkpoint. Proven by crash-injection test: final rows identical to an uninterrupted run. | `detector_runs` row with status `failed`. |
| Retention sweeper crash | Rollup and delete are one transaction; a retry finds no expired rows to re-roll. No lost history, no double counting. | Sweeper logs. |
| Upstream (OpenAI) down | 502 `upstream_unavailable` to the client; the attempt is logged as `error` with zero tokens. | Client-visible. |

## Concurrency and locking

Worker jobs take a `JobLock` (Redis `SET PX NX` + compare-and-delete, or
in-memory) with a 30-minute TTL. If the TTL expires while a run continues,
a second scheduler may start an overlapping run — safe because every job
is idempotent (dedupe keys, upserts, checkpoint transactions). Overlap is
documented behavior, not a bug.
