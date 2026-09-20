# @vyaya/proxy

The observe-only LLM traffic proxy (Hono on plain Node, port 8787).

## What it does

Clients point their OpenAI-compatible SDK at the proxy instead of the
upstream and authenticate with `X-Vyaya-Key` (a `vy_live_...` key minted by
the web app). The proxy streams requests and responses end-to-end
(including SSE for `stream: true`) and records one `request_logs` row per
call: model, endpoint, latency, token usage, cost (computed from the
versioned price table in `@vyaya/core` — never trusted from the client),
prompt hash, session, feature tag, retry metadata, schema-validation
result, and the consumption signal.

Hard contract: logging is fire-and-forget through the core
`RetryQueueLogSink` (bounded queue, drop-oldest backpressure). Postgres,
Redis, ClickHouse, Stripe, or the OTel collector being down never affects
proxied requests. The only fail-closed dependencies are the API-key store
on a cold cache (503 `auth_unavailable`) and the upstream itself (502
`upstream_unavailable`).

## Endpoints

- `POST /v1/chat/completions` — buffered + SSE passthrough.
- `POST /v1/embeddings` — passthrough.
- `GET /healthz` — liveness + retry-queue metrics (always 200).

## Vyaya headers (all optional except the key)

| Header | Purpose |
|---|---|
| `X-Vyaya-Key` | API key (required, 401 otherwise). |
| `X-Vyaya-Request-Id` | Client correlation id (echoed back; generated when absent/invalid). |
| `X-Vyaya-Session` | Session grouping. |
| `X-Vyaya-Tag` | Feature tag; validated against the workspace allowlist, dropped (never fatal) when rejected. |
| `X-Vyaya-Retry-Attempt` / `X-Vyaya-Retry-Of` | Retry metadata, logged as `retry_attempt` / `retry_of`. |
| `X-Vyaya-Consumed` | `false`/`0`/`no` marks the response unconsumed (ghost_output signal). |

## Upstream

`UPSTREAM_MODE=openai` forwards to `OPENAI_BASE_URL` (apps/mock-openai in
dev); `kubemind` forwards to `KUBEMIND_ROUTER_URL`. v1 is env-only (no
per-workspace upstream column yet — see docs/ASSUMPTIONS.md #32). Client
`Authorization` never crosses the proxy boundary; the proxy attaches
`OPENAI_API_KEY` itself when set.

## Rate limiting

Per-API-key sliding window (`RATE_LIMIT_REQUESTS_PER_MINUTE`, default
600). Redis sorted sets when `REDIS_URL` is set, identical in-memory
semantics otherwise. Redis failures fail open. Rejections return 429 with
`Retry-After`.

## Bodies

Stored (AES-256-GCM envelope per workspace DEK) only when env
`LOG_BODIES=true` AND the workspace opted in (`log_bodies_enabled` +
`wrapped_dek`). Bodies land in `request_bodies` through a bounded
fire-and-forget retry; plaintext never reaches logs.

## Dev

```bash
pnpm install && pnpm -r build
pnpm --filter @vyaya/proxy test            # boots mock-openai + embedded PG
pnpm --filter @vyaya/proxy test:coverage
```

Run live: `DATABASE_URL=... DESKID_ISSUER=... DESKID_JWKS_URL=...
MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32) pnpm --filter @vyaya/proxy start`
