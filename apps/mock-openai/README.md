# @vyaya/mock-openai

Deterministic OpenAI-compatible upstream for local development. The proxy
points here by default (`OPENAI_BASE_URL=http://localhost:8788`), so the
whole platform runs with no OpenAI key and no network egress.

## Endpoints

- `POST /v1/chat/completions` — OpenAI response shape, streaming included.
- `POST /v1/embeddings` — deterministic vectors (default 1536 dimensions,
  `dimensions` honored up to 1536).
- `GET /healthz` — liveness probe.

## Determinism

Same request body plus same `MOCK_OPENAI_SEED` always yields the same
`usage` numbers, the same completion text, and the same response `id`.

Formulas (implemented in `src/deterministic.ts`, pure functions):

- `prompt_tokens = 3 + Σ_messages (4 + ceil(content_length / 4)) + (fnv1a(normalized_prompt, seed) % 5)`
- `completion_tokens = min(desired, max_completion_tokens ?? max_tokens)`,
  where `desired` is the `X-Mock-Completion-Tokens` header when present,
  else `16 + (fnv1a("completion|" + normalized_prompt, seed) % 48)`
- `finish_reason` is `"length"` when capped, otherwise `"stop"`
- completion text is exactly `completion_tokens` words drawn from a fixed
  word list by hash (one word = one mock token)
- embeddings come from an xorshift32 PRNG seeded by `fnv1a("embed|" + input, seed)`

Nothing about the counts depends on wall-clock time or RNG state.

## Knobs

Headers win over env vars. Env vars are validated by `@vyaya/config`.

| Knob | Header | Env |
| --- | --- | --- |
| Fixed latency per request (ms) | `X-Mock-Latency-Ms` | `MOCK_OPENAI_LATENCY_MS` (alias `MOCK_LATENCY_MS`) |
| Latency jitter (ms, 0..value) | — | `MOCK_OPENAI_LATENCY_JITTER_MS` |
| Force failure | `X-Mock-Fail` | `MOCK_OPENAI_FAILURE_RATE` (alias `MOCK_FAIL_RATE`, probability 0..1) |
| Force completion_tokens | `X-Mock-Completion-Tokens` | — |
| Break schema responses | `X-Mock-Invalid-Schema-Response` | — |

`X-Mock-Fail` values: any HTTP status in 400..599 (e.g. `"429"`, `"500"`),
`timeout` (holds the connection until the client aborts), or `invalid-json`
(200 with a malformed JSON body). Unknown values are ignored.

## Schema-failure simulation

Send `response_format: { type: "json_schema", json_schema: { name, schema } }`
and the mock returns a stub value that satisfies the declared schema. Add the
`X-Mock-Invalid-Schema-Response: 1` header and the returned JSON violates the
schema (wrong top-level type) — this is how Vyaya exercises the
`schema_failure_burn` detector without burning real tokens.

## Streaming

`"stream": true` returns `text/event-stream` with OpenAI's chunk shape:
a role delta, content deltas, a finish chunk, then `data: [DONE]`.
`stream_options.include_usage: true` adds a final chunk with
`choices: []` and the full `usage` object, matching OpenAI.

## Run

```sh
pnpm --filter @vyaya/mock-openai build
MOCK_OPENAI_PORT=8788 node apps/mock-openai/dist/index.js
```

Example:

```sh
curl -X POST localhost:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'X-Mock-Completion-Tokens: 12' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
