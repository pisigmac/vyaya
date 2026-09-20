# Errors

Every error the system returns on purpose, what causes it, and how to
clear it. Proxy errors are OpenAI-shaped
(`{ error: { message, type, param, code } }`); web BFF errors are
`{ error: "message" }`.

## Proxy (`apps/proxy`, port 8787)

| HTTP | code | message | Cause | Remediation |
| --- | --- | --- | --- | --- |
| 401 | `missing_api_key` | `missing X-Vyaya-Key header` | No key header on the request. | Add `X-Vyaya-Key: vy_live_...` to the client. |
| 401 | `invalid_api_key` | `invalid or revoked API key` | Key unknown, malformed, or revoked. | Check the last4 in Settings; rotate if leaked; create a fresh key. Revocation propagates within 30s (proxy auth cache TTL). |
| 503 | `auth_unavailable` | `authentication backend unavailable` | Postgres unreachable AND the key isn't in the proxy's in-memory cache. Fail-closed by design — an unattributable request can't be metered. | Restore the database. Keys used in the last 30s keep working from cache. |
| 429 | `rate_limit_exceeded` | `rate limit exceeded` | Per-key sliding window (default 600/min) exceeded. `Retry-After` header gives seconds. | Back off per `Retry-After`. Raise `RATE_LIMIT_REQUESTS_PER_MINUTE` if the workload is legitimate. Note: Redis errors fail OPEN — a 429 means the limiter itself is healthy. |
| 502 | `upstream_unavailable` | `upstream unavailable` | The fetch to `OPENAI_BASE_URL` / KubeMind router failed (DNS, connect, TLS). | Check the upstream: in dev that's mock-openai on 8788. The attempt is logged with status `error` and zero tokens. |

Non-2xx statuses FROM the upstream pass through untouched with their
original bodies — a 400 from OpenAI is OpenAI's 400, not ours.

The proxy also logs warnings that never surface to clients:
`no price table entry for model ... cost logged as 0` (add the model to
`packages/core/src/cost/price-table.ts`), `feature tag rejected by
allowlist`, and sink/Stripe/OTel fire-and-forget failures.

## Web BFF (`apps/web`, port 3000)

| HTTP | error | Where | Cause / remediation |
| --- | --- | --- | --- |
| 401 | `not signed in` | every authed route | No/expired `vyaya_session` cookie. Sign in again. TTL: `SESSION_TTL_SEC` (12h default). |
| 403 | `viewers are read-only` | all mutations | Role `viewer` attempted a write. Have an admin change the role in DeskId (`roles.vyaya`). |
| 403 | `the classifier runs on a schedule in production` | `POST /api/onboarding/classify` | `AUTH_MODE != dev`. Run `node dist/index.js --job classify --once` on the worker instead. |
| 400 | zod issue list (`field: message; ...`) | routes with bodies/query | Input failed validation; the message names the field. |
| 400 | `request body must be JSON` | POST/PATCH routes | Unparseable body. |
| 404 | `key not found or already revoked` | keys revoke/rotate | Wrong id, other tenant, or already revoked. |
| 404 | `report has no PDF` / `report PDF file is missing on disk` / `report PDF path is outside the report directory` | `GET /api/reports/{id}` | Report predates PDFs, the shared volume is missing the file, or a bad path was stored. Check that web and worker share `REPORT_OUTPUT_DIR`. |
| 500 | `internal error` | any route | Unhandled. The server logs `unhandled route error` without internals; correlate by time. |
| 502 | `could not reach the proxy at ...` | `POST /api/onboarding/test-request` | `PROXY_BASE_URL` unreachable from the web service. In compose, the proxy service name must resolve. |
| 503 | `WORKER_CLI_PATH is not set...` | `POST /api/onboarding/classify` (dev) | The error message includes the manual command; follow it, or set `WORKER_CLI_PATH`. |

Auth-callback failures redirect to `/login?error=...` (e.g.
`missing_token`, `invalid_token`) rather than returning JSON.

## Worker

The worker has one HTTP surface: `GET /healthz` (404 elsewhere). Job
failures don't produce HTTP errors — they surface as
`lastOutcome: "failed"` + `lastError` in the health payload and as
`detector_runs` rows with `status = 'failed'`. Malformed DeskId
reconciliation events are skipped without blocking the cursor (logged, not
fatal).

## Mock services

- **mock-deskid refuses to boot** unless `AUTH_MODE=dev` (exit 1 with a
  clear error). This is intentional — never override it for production.
- **mock-openai `X-Mock-Fail: timeout`** holds the connection until the
  client aborts (30s ceiling). If your client hangs forever, that's your
  client missing a timeout — the mock is telling you something.

## npm-audit policy

1. `pnpm audit --registry=https://registry.npmjs.org` runs at every stage
   gate (the sandbox mirror has no audit endpoint — always pass the
   registry explicitly).
2. Every finding is either fixed (prefer `pnpm audit fix` when safe) or
   documented here with rationale. No silent exceptions.
3. **Current status: clean.** Zero vulnerabilities as of v0.1.0.
4. History: one finding during the build — GHSA-67mh-4wv8-2f99
   (`esbuild` via drizzle-kit's deprecated `@esbuild-kit/core-utils`
   chain). Resolved with a `pnpm-workspace.yaml` override pinning esbuild
   to 0.25.12. Re-check on any drizzle-kit upgrade; the override can be
   removed once drizzle-kit drops the deprecated dependency.
