# ASSUMPTIONS.md

Every assumption made during the build, with rationale. Updated per stage.

## Stage 1 (monorepo scaffold, @vyaya/config, @vyaya/core)

1. **Sandbox toolchain installed locally.** The environment notes said Node
   v24.8.0 would be at `~/.local/node24/bin`; it was absent, so Node v24.8.0
   was downloaded from nodejs.org and pnpm 10.17.1 activated via corepack,
   matching the documented layout exactly.
2. **Taxonomy-unspecified detector thresholds.** The spec pins thresholds
   for retry_storm (3 / 60s) and overprovisioned_max_tokens (50 / 0.30) only.
   Chosen defaults (all env-overridable): `GHOST_OUTPUT_MIN_AGE_MS=300000`
   (5 min — younger requests may still be in flight),
   `CONTEXT_AMNESIA_JACCARD_THRESHOLD=0.6`,
   `CONTEXT_AMNESIA_MIN_OVERLAP_TOKENS=64`,
   `CONTEXT_AMNESIA_SHINGLE_SIZE=3`,
   `OVERPROVISIONED_RESERVATION_OVERHEAD=0.10`.
3. **ghost_output signal.** Modeled as a `response_consumed` flag on the
   request log (set by downstream consumption signals / client discard
   headers) plus a minimum age. Full call cost is wasted; one event per
   qualifying request.
4. **retry_storm waste accounting.** Within a maximal in-window cluster of
   >= min attempts sharing a prompt_hash, the attempts before the first
   success are the wasted spend. A leading success followed by duplicates is
   NOT flagged (that is duplication, not a retry storm — taxonomy requires
   "a later attempt succeeded").
5. **overprovisioned_max_tokens dollars.** Per-token billing does not charge
   for unused max_tokens, so dollars_wasted is an explicit estimate: excess
   provisioned output tokens × inferred output price ×
   `OVERPROVISIONED_RESERVATION_OVERHEAD` (0.10). Calls with zero completions
   contribute 0 (no price signal). The rationale: reservation-style billing
   and capacity planning make overprovisioning a real but fractional cost.
6. **context_amnesia needs bodies.** The detector compares prompt text
   (Jaccard over word shingles, consecutive turns of a session). It skips
   metadata-only logs (`prompt_text` null) — the worker supplies decrypted
   bodies only for workspaces with body logging on. Wasted dollars =
   similarity × later turn's input cost. One event per session per run.
7. **"Consistently" = every call.** For overprovisioned_max_tokens, a
   rolling window qualifies only when ALL calls in it are strictly below the
   ratio; one healthy call breaks the run.
8. **Price table figures.** gpt-4o ($2.50/$10.00 per 1M), gpt-4o-mini
   ($0.15/$0.60), gpt-4.1 ($2.00/$8.00), o4-mini ($1.10/$4.40) — public list
   prices at build time, with a sample repricing for gpt-4o effective
   2026-01-01 ($2.00/$8.00) to exercise versioning. The table is data;
   review on provider price changes.
9. **vitest 5.0.1 pinned.** Initial pin vitest 3.2.7 had three audit
   findings (GHSA-82fw-gwwq-j7x9 ×2, GHSA-5j98-mcp5-4vw2 via glob). vitest
   5.0.1 + @vitest/coverage-v8 5.0.1 audit clean; all 136 tests pass.
   TypeScript pinned to 5.9.3 (7.0.2 exists but toolchain support is newer).
10. **zod 4.6.5.** Current major; v4 API used (`z.url()`, record key/value
    schemas).
11. **Postgres sink idempotency.** `INSERT ... ON CONFLICT (request_id) DO
    NOTHING` so retry-queue replays cannot double-log.
12. **Retry queue drop policy.** Drop-oldest under backpressure (proxy sheds
    load rather than growing memory); failed writes retry up to
    `maxWriteAttempts` (3) then drop. A failed entry is never retried within
    the same flush pass. Queue `healthy()` is always true by contract —
    proxy health is independent of logging; observability is via metrics.
13. **Repo relocation.** The original repo path (/mnt/agents/work/vyaya)
    became a noexec mount mid-stage; work moved to ~/vyaya with a fresh git
    init (the original .git was lost with the mount). Handoff to the
    orchestrator is a filesystem sync, not a push.
14. **No process.env outside @vyaya/config.** @vyaya/core receives
    thresholds/keys via constructor/context injection and never reads env,
    which also keeps detectors deterministic under test.

## Stage 2 (packages/db — schema, migrations, RLS, seed)

15. **embedded-postgres needs ICU 60 on this sandbox.** The zonky linux-x64
    Postgres 16 binaries (embedded-postgres 16.14.0-beta.17 → PostgreSQL
    16.14) link `libicuuc.so.60`; Debian 12 here ships ICU 72. Fix: the
    three required ICU 60 libraries (from Ubuntu 18.04's
    `libicu60_60.2-3ubuntu3.2_amd64.deb`, security.ubuntu.com) are fetched
    on demand into `packages/db/test-support/icu60/` by `fetch.mjs`
    (checksum-pinned; invoked automatically by the test harness) and
    prepended to
    `LD_LIBRARY_PATH` by the test harness only when the host cannot already
    resolve `libicuuc.so.60`. Production/compose Postgres images are
    unaffected. `embedded-postgres` has no stable (non-beta) release line;
    the newest 16.x tag was pinned exactly.
16. **Policies are TO PUBLIC, roles differentiate capability.** RLS
    isolation comes from the `app.workspace_id` GUC check, not from role
    membership, because FORCE RLS also binds the table owner (migrations,
    seed). Two NOLOGIN non-BYPASSRLS roles exist: `vyaya_app` (tenant
    policies only) and `vyaya_service` (adds a workspaces-enumeration
    policy for the worker's tenant discovery; it must still SET LOCAL the
    GUC per workspace to touch tenant rows). The migration GRANTs both
    roles to the migration runner so owners can SET ROLE immediately;
    production login mapping is deployment documentation (docs/DEPLOY.md,
    later stage).
17. **workspaces uses id-based RLS.** The tenant root has no workspace_id
    column; its policy matches `id` against the GUC. Bootstrap inserts
    (signup, seed) set the GUC to the new workspace's own id first —
    `withWorkspace()` supports this chicken-and-egg case.
18. **request_logs column names follow the Stage 1 sink contract.**
    PostgresLogSink already INSERTs `schema_validation` (not
    `schema_validation_result`; that name is kept for the enum type) and
    `response_consumed` (the ghost_output "consumed flag"), plus
    `occurred_at`, `input_cost_usd`, `output_cost_usd`. The schema matches
    the sink rather than renaming either side. Retry metadata
    (`retry_attempt`, `retry_of`) was added with column defaults so the
    sink's insert (which omits them) keeps working; detectors primarily
    use prompt_hash + status + timing.
19. **waste_events.dedupe_key.** Not in the spec's column list, added for
    the worker idempotency requirement ("run twice, same result"): unique
    `(workspace_id, dedupe_key)` lets re-runs upsert instead of duplicate.
    The worker computes it as a hash of workspace, type, detector version,
    and sorted request ids (Stage 4).
20. **@vyaya/config gained optional MASTER_ENCRYPTION_KEY in loadDbEnv.**
    Strictly-necessary config change: the dev seed encrypts demo bodies
    (context_amnesia needs prompt text) and all env reads live in
    @vyaya/config. Optional there; the proxy/worker schemas already require
    it. Seed skips body rows when it is unset.
21. **API key format `vy_live_<64 hex>`** (32 random bytes), argon2id via
    @node-rs/argon2 defaults (`$argon2id$v=19$m=19456,t=2,p=1` — RFC 9106
    memory-constrained profile). Key utilities live in @vyaya/db (they only
    concern the api_keys table); @node-rs/argon2 chosen over `argon2` for
    prebuilt napi binaries (no build toolchain needed).
22. **Seed idempotency via deterministic ids.** Fixed workspace/user/key
    UUIDs and `seed-req-<slug>-<n>` request ids with ON CONFLICT DO
    NOTHING; API key plaintext is printed only when the key row is first
    created. ~194 logs: workspace A (body logging on) gets 3 retry-storm
    clusters, 8 ghosts, 6 schema failures, 2 amnesia sessions x 6 turns
    with encrypted bodies, 55 overprovisioned calls, 12 clean; workspace B
    (metadata-only) gets the same minus bodies. Clean traffic has
    max_tokens null so it never breaks the overprovisioned detector's
    consecutive-run grouping.
23. **RLS policies file duplicated into the migration.** rls/policies.sql
    is the source of truth; drizzle/0001_rls_policies.sql is a verbatim
    copy (migrations must be self-contained SQL). A test asserts every
    migration statement appears in the source file with matching statement
    counts, so the two cannot drift silently.
24. **esbuild override for GHSA-67mh-4wv8-2f99.** drizzle-kit's deprecated
    @esbuild-kit/core-utils chain pins esbuild ~0.18.20 (moderate, dev
    server origin check — drizzle-kit only uses esbuild's transform API at
    CLI time, but the override is free): pnpm-workspace.yaml pins
    `@esbuild-kit/core-utils>esbuild` to 0.25.12. `pnpm audit` is clean.
    Also added `onlyBuiltDependencies` for @embedded-postgres/linux-x64 and
    esbuild (pnpm blocks postinstall scripts by default; the Postgres
    binaries' symlinks are created by that postinstall).

## Stage 3 (apps/mock-openai, apps/mock-deskid)

25. **mock-openai stays on port 8788.** The Stage 3 delegation suggested a
    8790 default, but Stage 1 had already shipped `WORKER_PORT=8790` and
    `MOCK_OPENAI_PORT=8788` across config, `.env.example`, and docs; the lead
    confirmed 8788 stands (8790 would collide with apps/worker).
26. **Deterministic token counts are pure functions.** `prompt_tokens = 3 +
    Σ(4 + ceil(chars/4)) + fnv1a(normalized_prompt, seed) % 5`;
    `completion_tokens` = `X-Mock-Completion-Tokens` header, else
    `16 + fnv1a("completion|" + prompt, seed) % 48`, capped by
    `max_completion_tokens ?? max_tokens` (finish_reason `"length"` when
    capped). One mock token = one generated word, so streamed and buffered
    responses report identical usage for identical input. Embeddings use an
    xorshift32 PRNG seeded per input string. No wall-clock or RNG state
    feeds the counts.
27. **Failure injection runs after request validation, before latency.**
    `X-Mock-Fail: timeout` holds the connection until the client aborts
    (30s ceiling, timer unref'd) instead of fabricating an error response,
    matching how a hung upstream actually looks to the proxy.
28. **mock-deskid AUTH_MODE guard inverted on purpose.** Web/proxy default
    `AUTH_MODE=dev` for convenience; the mock's own schema defaults to
    `"deskid"` and `assertDevMode` throws at boot otherwise, so a missing
    env var can never silently activate a mock identity provider.
29. **mock-deskid keys.** RSA-2048, `kid` = first 16 base64url chars of
    SHA-256(SPKI DER). Persisted under `MOCK_DESKID_KEYS_DIR` (default
    `keys/`, gitignored, private key 0600); env PEM pair overrides and is
    never written to disk. `POST /v1/admin/rotate-keys` promotes a fresh key
    and keeps the previous one in the JWKS, which exercises @vyaya/core's
    unknown-kid refresh path. `POST /v1/dev/token` (direct mint, not part of
    the DeskId contract) exists so tests/e2e can mint tokens without parsing
    OAuth redirects. Reconciliation feed is in-memory and resets on restart;
    consumers resync from `since_id=0`.
30. **@vyaya/config changes (strictly necessary).** `mocks.ts` only: added
    `MOCK_LATENCY_MS`/`MOCK_FAIL_RATE` aliases (canonical names win),
    `AUTH_MODE`/`DESKID_ISSUER`/`AUTH_SPA_CALLBACK_URL`/
    `MOCK_DESKID_KEYS_DIR`/`MOCK_DESKID_TOKEN_TTL_SEC` to the mock-deskid
    schema. @vyaya/core untouched; no schema changes anywhere else.
31. **Dockerfiles statically validated only.** No docker daemon in this
    sandbox, so both app Dockerfiles (node:24-alpine, non-root `node` user,
    `pnpm deploy --prod` for a self-contained runtime dir) are reviewed by
    inspection; compose wiring + image builds land in a later stage.

## Stage 4a (apps/proxy — observe-only traffic proxy)

32. **Env-only upstream base URL (v1).** The workspaces table has no
    per-workspace upstream override column, so the proxy resolves the
    upstream from env only (`UPSTREAM_MODE=openai` -> `OPENAI_BASE_URL`,
    `kubemind` -> `KUBEMIND_ROUTER_URL`). The schema hook remains a later
    migration; when it lands, only `resolveUpstreamBaseUrl` in
    `apps/proxy/src/deps.ts` changes.
33. **Key revocation propagation <= 30s.** `X-Vyaya-Key` lookups
    (argon2id verify against candidates matched by the stored `last4`
    hint) are cached in memory: positives 30s, negatives 5s. Revoking a
    key takes up to the positive TTL to take effect. Cold cache + DB down
    fails closed with 503 `auth_unavailable` (we cannot attribute or
    meter the request); warm cache keeps serving through DB outages.
34. **response_consumed semantics (v1).** `true` unless either (a) the
    client sent `X-Vyaya-Consumed: false|0|no`, or (b) the client
    disconnected before the response stream completed (logged as
    `client_disconnect`, consumed=false). Downstream retrieval tracking
    beyond the header is a later-stage signal.
35. **Token accounting.** Usage comes from the upstream response. When a
    stream runs without `stream_options.include_usage` (or usage is
    otherwise absent) on a *successful* response, tokens are estimated
    deterministically (~4 chars/token, mock-compatible priming) and
    documented as estimates. On *errored* upstream responses tokens are
    logged as 0 (not billable upstream, and never estimated). Cost is
    always computed from the versioned price table in @vyaya/core;
    unknown models log cost 0 with a warn line.
36. **Body logging needs both switches.** Bodies are stored only when
    env `LOG_BODIES=true` AND the workspace has `log_bodies_enabled` AND
    a `wrapped_dek`. Encryption happens in the proxy (envelope, workspace
    DEK cached after first unwrap); plaintext never reaches pino/stdout.
    Body rows reference request_logs by FK and flush through their own
    bounded retry (500ms x 5 attempts) to ride out the FK race with the
    async log flush; drops are counted, never fatal.
37. **jsonb writes use `unsafe` + `prepare:false` + `::jsonb` casts.**
    postgres.js re-applies the server-reported jsonb serializer on
    prepared-statement re-execution (double-encoding string payloads),
    and `sql.json` Parameter objects break when the client module
    instance differs from the query module (vite-node workspace
    inlining). Text + server-side cast is unambiguous on every path.
    jsonb readback is normalized defensively (`JSON.parse` if string).
38. **Rate limiter fails open on Redis errors.** Proxy health is
    independent of Redis: a Redis failure allows the request and
    increments an error counter (pino warn). The Redis and in-memory
    limiters share one sliding-window decision function; the Redis path
    is tested against ioredis-mock (sorted-set commands), not a real
    Redis server (not available in this sandbox).
39. **Latency benchmark methodology.** The <10ms p95 gate is measured as
    the p95 of per-pair deltas (proxied minus direct) over 200
    interleaved request pairs against the mock with 50ms latency;
    interleaving makes the estimator immune to CPU contention from
    sibling test workers. Measured: p95 added 6.5-6.9ms under full-suite
    load, 3.7-4.4ms isolated.
40. **Core changes (strictly necessary).** (a) `RequestLog` gained
    `retryAttempt`/`retryOf` and both LogSink inserts gained the
    `retry_attempt`/`retry_of` columns — retry metadata logging is a
    hard spec rule and the sink contract owns the write path;
    (b) price table gained `text-embedding-3-small`/`3-large` —
    embeddings cost must be computable; (c) new `core/prompt`
    normalization+hashing module so the worker can recompute identical
    prompt hashes from bodies; (d) @vyaya/db exports its embedded-pg
    test harness (`./test-support/embedded-pg`) so downstream apps don't
    duplicate it, and its tsconfig now compiles that directory.
41. **Classify batching is the unit of detector context (v1).** Each
    batch (CLASSIFY_BATCH_SIZE, default 5000 logs) is detector input AND
    commit unit: events + detector_runs checkpoint commit in one
    transaction, so a crash rolls back only the in-flight batch and the
    next run resumes from the last committed checkpoint. Cross-batch
    patterns (a retry storm straddling a batch boundary, an
    overprovisioned run split across batches) are detected per batch, not
    globally — acceptable at the default batch size, documented for v2
    streaming windows. Checkpoints are stored as a self-contained
    `occurredAtMs:requestId` cursor so they survive the retention sweeper
    deleting the referenced log row.
42. **Worker queries carry explicit workspace_id filters in addition to
    RLS.** The service role (and the dev superuser) can read every tenant;
    RLS is defense in depth, not the scoping mechanism, for service-role
    paths.
43. **Waste-event idempotency is content-derived.** dedupe_key =
    sha256(workspace_id | waste_type | detector_version | sorted
    request_ids), unique index + ON CONFLICT DO NOTHING. Re-running the
    classifier over the same logs (checkpoint reset, replay, crash retry)
    can never duplicate an event; proven by the replay test.
44. **Weekly reports cover the previous completed ISO week** (Mon-Sun,
    UTC), one row per (workspace_id, week_start) via the existing unique
    index; a same-week rerun is a no-op (no duplicate PDF, no duplicate
    email). projected_annual_savings = the fix's weekly wasted dollars x
    52. `reports.pdf_path` (new nullable column, 0002 migration) stores
    the worker-local PDF location regardless of email delivery; object
    storage is a deployment concern (documented upgrade path).
45. **Email delivery: Resend when RESEND_API_KEY is set, recording stub
    otherwise** — the report row + PDF are stored either way (spec:
    "store report row + PDF bytes location regardless"). A failed send
    marks the row `failed` but does not delete it; the same week is not
    regenerated on the next run.
46. **daily_aggregates rollup table (new, 0002 migration).** The
    retention sweeper rolls expired request_logs (> METADATA_RETENTION_DAYS)
    into per-(workspace, UTC day) sums in the SAME transaction as the
    delete, so a crashed sweep can neither lose nor double-count history.
    Aggregates are never swept (bodies 7 days, metadata 400 days,
    aggregates forever).
47. **DeskId reconciliation cache is service-global, not tenant.**
    reconciliation_cursor (singleton row, id 'deskid') and
    user_grants_cache (PK deskid_sub+audience) carry no workspace_id —
    grant events arrive before any workspace mapping exists. RLS is still
    ENABLEd+FORCEd: cursor is vyaya_service-only; the cache is world-SELECT
    (the app role reads grants for authorization) with vyaya_service-only
    writes (rls/policies-worker.sql, migration 0003). Malformed events are
    skipped WITHOUT blocking the cursor (no poison pills).
48. **Job locking.** Redis (SET PX NX + compare-del release) when
    REDIS_URL is set, in-memory otherwise. Lock TTL 30 min; all jobs are
    idempotent, so an expired-lock overlap is safe. A lock acquisition
    ERROR skips the run (fail closed) rather than risking duplicate work.
49. **packages/* changes in Stage 4b (all strictly necessary):** (a)
    @vyaya/db — three new tables (daily_aggregates, reconciliation_cursor,
    user_grants_cache) + reports.pdf_path, migrations 0002/0003, and the
    migrations.test expectations updated for them; (b) @vyaya/config —
    worker env gained CLASSIFY_INTERVAL_MS, CLASSIFY_BATCH_SIZE,
    WEEKLY_REPORT_INTERVAL_MS, RETENTION_SWEEP_INTERVAL_MS,
    REPORT_OUTPUT_DIR (job cadence is a spec requirement).
50. **Session cookie = signed JWT-in-cookie (HS256-style HMAC-SHA256), not
    encrypted.** The payload carries only identity claims (sub, email, local
    workspace/user ids, role, exp) — no secrets — so integrity + HttpOnly +
    SameSite=Lax (+Secure in production) is sufficient; documented per the
    build spec's "encrypted or JWT-in-cookie" choice. Implemented on Web
    Crypto so the same code runs in proxy.ts, route handlers, and vitest.
    Sessions live 12h (SESSION_TTL_SEC) and outlive the 1h DeskId token —
    re-login refreshes role/workspace mappings (staleness accepted for v1;
    the worker's reconciliation feed is the upgrade path).
51. **Claims -> workspace mapping (web provisioning, lib/provision.ts).**
    Order: (1) users.deskid_sub hit -> returning user, email/role synced
    from claims; (2) workspaces.deskid_org_id == claims.org_id -> new user
    joins the org's workspace; (3) otherwise auto-create workspace + user
    (first login onboarding). The lookups in (1)/(2) are cross-tenant by
    globally-unique keys and run as the web DB role — the dev superuser
    bypasses RLS; production needs a login role permitted to resolve
    deskid_sub globally (a provisioning policy), noted for docs/DEPLOY.md.
    Workspace INSERT runs inside withWorkspace(newId) so the RLS WITH CHECK
    passes. deskid_sub is globally unique, making first login idempotent.
52. **Audience auto-grant is best-effort at first login.** POST
    /v1/admin/grants with DESKID_ADMIN_TOKEN right after workspace creation
    (mock-deskid already issues aud ["vyaya"], so this matters only for real
    DeskId). Failure never blocks onboarding. The alternative deployment
    path — AUTH_DEFAULT_AUDIENCES=vyaya at DeskId bootstrap — is equally
    valid; both are documented here and in docs/ENV.md.
53. **Test-request endpoint takes the plaintext key from the client.** Web
    stores only argon2id hashes, so the server cannot reconstruct a key to
    send through the proxy. The onboarding page posts the just-created
    plaintext (in-memory only) to /api/onboarding/test-request, which fires
    one real gpt-4o-mini chat completion at PROXY_BASE_URL with X-Vyaya-Key.
    The key transits once, server-to-server; it is never persisted.
54. **"Run the classifier now" is a dev-only spawn.** POST
    /api/onboarding/classify (AUTH_MODE=dev only, 403 otherwise) execs
    `node $WORKER_CLI_PATH --job classify --once` with the inherited env.
    Chosen over importing @vyaya/worker into the web bundle (keeps pdf-lib,
    ioredis, OTel out of the web image) and over an HTTP admin API on the
    worker (no extra attack surface). Unset WORKER_CLI_PATH -> 503 with the
    manual command. The dashboard "first waste found" state polls
    /api/onboarding/workspace every 5s regardless.
55. **Breakdown attribution for endpoint/feature_tag splits event dollars
    evenly** across the event's implicated request_ids
    (dollars_wasted / jsonb_array_length). An event's cost is shared by the
    requests that caused it; sums stay exact (no double counting).
    projected_annual_savings = (30d dollars / 30) * 365 — same convention as
    the worker's weekly report (weekly x 52).
56. **workspaces.report_email (migration 0004) + worker recipient rule.**
    The settings "report email recipient" needed a column; the weekly-report
    job now prefers workspaces.report_email over the all-members fallback
    (empty/null preserves Stage 4b behavior exactly). migrations.test.ts
    count updated 4 -> 5; policy inventory unchanged (no new table).
57. **@vyaya/db gained ./client and ./api-keys subpath exports** because
    Turbopack cannot trace the barrel's migrate.js
    (`new URL("../drizzle", import.meta.url)`). Web imports narrow subpaths
    only; the barrel is unchanged for other consumers.
58. **next/font/google downloads Inter at build time.** Verified reachable
    in the sandbox; in air-gapped builds, vendor Inter woff2 under
    apps/web/public/fonts and switch to next/font/local (noted, not done).
    Web vitest runs with maxWorkers=1: the full-gate runs every package
    concurrently and the proxy's p95<10ms latency gate flakes when extra
    embedded-PG clusters compete for CPU (observed once at 30ms; green after
    the cap, matching Stage 4b's maxWorkers=2 precedent for the worker).

## Stage 6 (docker-compose wiring, e2e scripts, deploy runbook)

59. **DeskId pinned to upstream commit 77c0f056b7dd088fbe66963fa6904978098e9044**
    (main @ 2026-09-06, the latest commit returned by the GitHub API at build
    time). The compose `build.context` is the git URL + `#<sha>`; Docker
    clones and checks out that commit. Bump deliberately, not by floating
    `main`.
60. **DeskId database topology: dedicated `deskid-db` container, shared
    redis.** Upstream's own docker-compose.yml gives DeskId its own postgres
    (user/db `auth`) and its own redis. We mirror the postgres half exactly
    (DeskId's schema, migrations and role expectations stay untouched), and
    deviate on redis: the DeskId rate limiter uses our shared redis service
    on logical database 1 (`redis://redis:6379/1`) instead of a second redis
    container. Both choices are commented in docker-compose.yml. DeskId
    applies its schema at boot (`init_db` in its app lifespan), so no
    separate migration step is needed for it.
61. **Compose identity is opt-in via profiles; default profile has no IdP.**
    `docker compose up` starts postgres, redis, mock-openai, proxy, worker,
    web. `COMPOSE_PROFILES=mock-deskid` adds the dev issuer;
    `COMPOSE_PROFILES=deskid` adds real DeskId + deskid-db. The web login
    page links 404 without one of them — by design, since the two identity
    modes need different `DESKID_ISSUER` values in .env anyway.
62. **Two-address problem for DeskId URLs.** Browsers reach DeskId via
    localhost (`DESKID_BASE_URL`, used by the login page's OAuth links);
    containers reach it via the compose network (`DESKID_JWKS_URL_INTERNAL`,
    `DESKID_BASE_URL_INTERNAL`, mapped to `DESKID_JWKS_URL`/`DESKID_BASE_URL`
    in the container environment). The web app's post-onboarding
    audience-grant call uses the browser-facing `DESKID_BASE_URL` — from
    inside the web container that fails, but the grant call is best-effort
    by contract (never throws; provision.ts) and mock-deskid tokens always
    carry the `vyaya` audience, so dev onboarding is unaffected. With the
    real DeskId profile, `AUTH_DEFAULT_AUDIENCES=vyaya` covers the grant at
    the IdP side. If the server-side grant path ever becomes load-bearing in
    compose, point web's `DESKID_BASE_URL` override at the internal address
    and render login links from a separate public var.
63. **mock-deskid keyring persistence.** The compose service mounts the
    `mock-deskid-keys` volume at /app/keys (the Dockerfile pre-creates it
    node-owned, so a fresh named volume inherits the ownership). Restart
    keeps keys; `down -v` rotates the keyring and invalidates every
    outstanding token and session cookie.
64. **Worker/web reports volume.** `REPORT_OUTPUT_DIR=/app/reports` for both
    containers, sharing the `reports` named volume (web read-only). The
    worker Dockerfile gained `RUN mkdir -p /app/reports && chown node:node`
    so a fresh named volume is writable by the non-root user (apps/* change,
    one line, no behavior change for non-compose runs).
65. **e2e assertion strategy: seeded-creds login + BFF-created key.** Both
    scripts log in as the seeded Acme admin (mock-deskid `/v1/dev/token`
    with the seed user's `sub`, real `/auth/callback` exchange — the
    returning-user provisioning path), then create a fresh API key through
    the web BFF and use it for the proxied request. This exercises token
    verification, session issuance, RBAC'd key creation, proxy auth, the
    LogSink write path, the classifier, and the dashboard APIs in one
    workspace, without standing up a second signup fixture. The fresh-signup
    auto-provisioning path is covered by apps/web's auth-callback tests.
66. **e2e-local is the executable spec for the dockerless dev path.** It
    builds Redis 7.4.5 from source only when `$REDIS_SERVER_BIN`
    (default `$HOME/vendor/redis-7.4.5/src/redis-server`) is missing, runs
    Postgres via packages/db's embedded-postgres harness
    (`scripts/dev-pg.mjs`), serves web from the standalone output with
    static assets copied in (same layout as the Dockerfile), and keeps all
    state in a mktemp run dir. The repo checkout must sit on an exec-able
    filesystem (embedded Postgres runs binaries out of node_modules).
67. **scripts/e2e-sql.mjs resolves the `postgres` driver through
    @vyaya/db's node_modules** (createRequire anchored at
    packages/db/package.json) so the e2e scripts add zero dependencies and
    no psql requirement.
68. **Web has no /healthz route.** Its compose healthcheck GETs `/` (the
    public landing page); Next's proxy.ts only gates /dashboard, /settings,
    /onboarding, so `/` is a stable liveness signal. A dedicated route can
    be added later without changing the check.
69. **Compose file is statically validated only in this stage's sandbox**
    (no docker daemon): YAML parse, profile/dependency/volume/network
    reference checks, port-collision scan, healthcheck and restart-policy
    presence. Image builds and `docker compose config` remain unexecuted —
    same caveat as Stages 3-5. scripts/e2e.sh is written to the same
    assertion library as the (passing) dockerless e2e-local.sh but has not
    been run here.
