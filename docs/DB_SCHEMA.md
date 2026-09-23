# DB_SCHEMA.md — database schema reference

Postgres 16 (dev/compose; Neon in prod). Schema is authored in
`packages/db/src/schema/*` (Drizzle ORM), migrated with the generated SQL in
`packages/db/drizzle/`, and isolated per tenant with row-level security from
`packages/db/rls/policies.sql`. Apply with
`pnpm --filter @vyaya/db migrate` (requires `DATABASE_URL`).

Money columns are `numeric(14, 8)` (8 decimals matches `roundUsd` in
@vyaya/core). All timestamps are `timestamptz`. `workspaces.id` and other
`id` columns are `uuid DEFAULT gen_random_uuid()`.

## Tenancy and RLS

Every tenant table carries `workspace_id uuid NOT NULL REFERENCES
workspaces(id) ON DELETE CASCADE`. RLS is `ENABLE` + `FORCE` on **all ten
tables** (the table owner is subject too; only superusers bypass).

| Table | Policy | Rule |
|---|---|---|
| `workspaces` | `workspace_self` (PUBLIC) | `id = app_current_workspace_id()` |
| `workspaces` | `service_enumerate_workspaces` (vyaya_service) | `true` (tenant discovery for the worker) |
| all 9 others | `workspace_isolation` (PUBLIC) | `workspace_id = app_current_workspace_id()` |

`app_current_workspace_id()` is
`NULLIF(current_setting('app.workspace_id', true), '')::uuid` — unset or
empty GUC means NULL, and NULL means default deny. The GUC is set per
transaction (`SET LOCAL`, via `set_config(..., true)`) by
`withWorkspace()` in `packages/db/src/client.ts`; it can never leak across
transactions.

Roles (created by migration `0001_rls_policies`, both `NOLOGIN NOSUPERUSER
NOBYPASSRLS`):

- `vyaya_app` — web/proxy hot path. Tenant policies only; cannot enumerate
  `workspaces`.
- `vyaya_service` — worker. Same tenant policies plus
  `service_enumerate_workspaces`: it may list tenants, then must still
  `SET LOCAL app.workspace_id` per workspace before touching tenant rows.

Deployments GRANT these roles to the connecting LOGIN role (the migration
grants them to the migration runner automatically). Connection pooling is
unaffected because the GUC is transaction-local.

## Tables

### workspaces
Tenant root.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| name | text | display name |
| slug | text UNIQUE | URL-safe handle |
| deskid_org_id | text NULL | DeskId `org_id` mapping |
| log_bodies_enabled | boolean NOT NULL DEFAULT false | per-workspace body-logging opt-in |
| report_email | text NULL | weekly-report recipient; NULL = all workspace member emails (added in 0004, honored by the worker) |
| detector_thresholds | jsonb NULL | partial `DetectorThresholds` overrides, merged by the worker |
| wrapped_dek | jsonb NULL | `WrappedDek` — workspace DEK wrapped by the master key (created on first body opt-in) |
| stripe_customer_id | text NULL | Stripe customer |
| created_at, updated_at | timestamptz NOT NULL | `DEFAULT now()` |

### users
Local mirror of DeskId users (claim `sub`).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| deskid_sub | text NOT NULL UNIQUE | DeskId `sub` |
| email | text NOT NULL | |
| role | workspace_role NOT NULL DEFAULT 'viewer' | enum: `admin` `operator` `viewer` |
| created_at | timestamptz NOT NULL | |

Index: `users_workspace_id_idx (workspace_id)`.

### api_keys
Proxy keys (`X-Vyaya-Key`). Plaintext shown once at creation; only the
argon2id hash is stored.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| created_by_user_id | uuid NULL FK→users | `ON DELETE SET NULL` |
| name | text NOT NULL | |
| key_prefix | text NOT NULL DEFAULT 'vy_live' | scanner-identifiable prefix |
| key_hash | text NOT NULL | argon2id encoded (`$argon2id$v=19$m=19456,t=2,p=1$…`) |
| last4 | text NOT NULL | last 4 chars, shown in UI |
| created_at | timestamptz NOT NULL | |
| last_used_at | timestamptz NULL | |
| revoked_at | timestamptz NULL | set = revoked; keys are never hard-deleted |

Indexes: `api_keys_workspace_id_idx (workspace_id)`,
`api_keys_active_workspace_idx (workspace_id) WHERE revoked_at IS NULL`.

### request_logs
One row per proxied LLM request; metadata only (bodies live in
`request_bodies`). Column names are contract-bound to `PostgresLogSink` in
@vyaya/core, which inserts by name with `ON CONFLICT (request_id) DO
NOTHING`.

| Column | Type | Notes |
|---|---|---|
| request_id | text PK | idempotency key for log writes |
| workspace_id | uuid NOT NULL FK | |
| occurred_at | timestamptz NOT NULL | request completion time |
| model | text NOT NULL | |
| endpoint | text NOT NULL | e.g. `/v1/chat/completions` |
| latency_ms | integer NOT NULL | |
| prompt_tokens, completion_tokens | integer NOT NULL | |
| max_tokens | integer NULL | requested cap; null when unset |
| cost_usd, input_cost_usd, output_cost_usd | numeric(14,8) NOT NULL | computed server-side from the versioned price table |
| prompt_hash | text NOT NULL | SHA-256 hex of normalized prompt; retry_storm grouping key |
| session_id | text NULL | `X-Vyaya-Session`; context_amnesia grouping key |
| feature_tag | text NULL | `X-Vyaya-Tag`, allowlist-validated |
| status | request_status NOT NULL | enum: `success` `error` `client_disconnect` |
| schema_validation | schema_validation_result NOT NULL | enum: `passed` `failed` `not_requested` |
| response_consumed | boolean NOT NULL DEFAULT true | ghost_output signal |
| retry_attempt | integer NOT NULL DEFAULT 0 | retry metadata; 0 = first attempt |
| retry_of | text NULL | request_id of first attempt in the chain |
| created_at | timestamptz NOT NULL | |

Indexes: `(workspace_id, occurred_at)` (checkpoint scans, dashboards),
`(workspace_id, prompt_hash, occurred_at)` (retry_storm),
`(workspace_id, session_id)` (context_amnesia),
`(workspace_id, feature_tag)` (dashboard breakdown).

### request_bodies
AES-256-GCM-encrypted prompt/response bodies; written only when the
workspace opted in. Retention: worker sweeper deletes rows past
`expires_at` (default 7 days, `BODY_RETENTION_DAYS`).

| Column | Type | Notes |
|---|---|---|
| request_id | text PK FK→request_logs | `ON DELETE CASCADE` |
| workspace_id | uuid NOT NULL FK | |
| prompt_envelope | jsonb NOT NULL | `EncryptedPayload` (base64 ciphertext + iv + authTag) |
| response_envelope | jsonb NULL | null when upstream errored pre-body |
| prompt_bytes | integer NOT NULL | plaintext size, for retention accounting |
| response_bytes | integer NULL | |
| expires_at | timestamptz NOT NULL | |
| created_at | timestamptz NOT NULL | |

Index: `request_bodies_workspace_expiry_idx (workspace_id, expires_at)`.

### waste_events
Detected waste. `dedupe_key` (worker-computed hash of workspace, type,
detector version, sorted request ids) makes re-runs idempotent.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| waste_type | waste_type NOT NULL | enum of the 5 taxonomy types |
| request_ids | jsonb NOT NULL | `string[]` of request_logs ids |
| dedupe_key | text NOT NULL | idempotency anchor |
| dollars_wasted | numeric(14,8) NOT NULL | |
| evidence | jsonb NOT NULL | detector-specific justification |
| detector_version | text NOT NULL | pinned by the registry |
| suggested_fix | text NOT NULL | |
| detected_at | timestamptz NOT NULL | |
| created_at | timestamptz NOT NULL | |

Indexes: UNIQUE `(workspace_id, dedupe_key)`,
`(workspace_id, waste_type, detected_at)`.

### detector_runs
Nightly classifier checkpointing (idempotent, resumable per workspace).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| started_at | timestamptz NOT NULL | |
| finished_at | timestamptz NULL | |
| last_processed_log_id | text NULL | request_logs cursor checkpoint |
| status | detector_run_status NOT NULL DEFAULT 'running' | enum: `running` `completed` `failed` |
| error | text NULL | |
| created_at | timestamptz NOT NULL | |

Index: `detector_runs_workspace_started_idx (workspace_id, started_at)`.

### reports
Weekly report metadata; one row per workspace per week.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| week_start, week_end | date NOT NULL | ISO week bounds (Monday start) |
| total_spend_usd, dollars_wasted | numeric(14,8) NOT NULL | snapshot for the week |
| waste_rate | numeric(8,6) NOT NULL | dollars_wasted / total_spend |
| top_waste_type | waste_type NULL | |
| biggest_event_id | uuid NULL FK→waste_events | `ON DELETE SET NULL` |
| top_fix | text NULL | |
| pdf_path | text NULL | worker-local path of the generated PDF (REPORT_OUTPUT_DIR) |
| status | report_status NOT NULL DEFAULT 'generated' | enum: `generated` `emailed` `failed` |
| email_sent_at | timestamptz NULL | |
| created_at | timestamptz NOT NULL | |

Index: UNIQUE `reports_workspace_week_idx (workspace_id, week_start)`.

### feature_tag_allowlist
Per-workspace allowlist for `X-Vyaya-Tag` (empty = allow all).

| Column | Type | Notes |
|---|---|---|
| workspace_id | uuid FK | composite PK |
| tag | text | composite PK |
| created_at | timestamptz NOT NULL | |

### stripe_meter_events
Stripe meter-event outbox (`STRIPE_ENABLED`, test-mode only in v1).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NOT NULL FK | |
| request_id | text NULL | originating LLM request |
| event_name | text NOT NULL | |
| idempotency_key | text NOT NULL UNIQUE | retry-safe outbox + Stripe call |
| payload | jsonb NOT NULL | meter event payload |
| status | stripe_meter_event_status NOT NULL DEFAULT 'pending' | enum: `pending` `sent` `failed` |
| stripe_event_id | text NULL | Stripe-side id once accepted |
| error | text NULL | |
| created_at | timestamptz NOT NULL | |
| sent_at | timestamptz NULL | |

Index: `stripe_meter_events_workspace_status_idx (workspace_id, status)`.

### daily_aggregates
Per-workspace per-UTC-day rollup of request_logs. The retention sweeper
upserts rows before deleting expired metadata; kept forever (bodies 7
days, metadata 400 days, aggregates forever).

| Column | Type | Notes |
|---|---|---|
| workspace_id | uuid FK | composite PK, `ON DELETE CASCADE` |
| day | date | composite PK |
| request_count | bigint NOT NULL DEFAULT 0 | |
| prompt_tokens, completion_tokens | bigint NOT NULL DEFAULT 0 | |
| cost_usd | numeric(14,8) NOT NULL DEFAULT 0 | |
| updated_at | timestamptz NOT NULL | |

### reconciliation_cursor
Service-global singleton cursor over the DeskId reconciliation feed
(worker, `DESKID_RECONCILE_ENABLED`). Not a tenant table; RLS policy is
vyaya_service-only (see `rls/policies-worker.sql`).

| Column | Type | Notes |
|---|---|---|
| id | text PK | always `deskid` |
| last_event_id | bigint NOT NULL DEFAULT 0 | greatest applied feed event id |
| updated_at | timestamptz NOT NULL | |

### user_grants_cache
Local mirror of DeskId audience grants, applied from reconciliation
events. Service-global (grants precede any workspace mapping); world-SELECT
RLS policy for the app role, vyaya_service-only writes.

| Column | Type | Notes |
|---|---|---|
| deskid_sub | text | composite PK; DeskId `sub` |
| audience | text | composite PK |
| role | workspace_role NOT NULL | enum: `admin` `operator` `viewer` |
| email | text NULL | filled from user.created events |
| updated_at | timestamptz NOT NULL | |

## Migrations

| File | Contents |
|---|---|
| `drizzle/0000_init.sql` | enums, all 10 tables, FKs, indexes (generated by drizzle-kit) |
| `drizzle/0001_rls_policies.sql` | custom: roles, GUC helper function, ENABLE/FORCE RLS + policies on every tenant table (mirror of `rls/policies.sql`; a test asserts the two stay in sync) |
| `drizzle/0002_worker_tables.sql` | daily_aggregates, reconciliation_cursor, user_grants_cache, reports.pdf_path (generated by drizzle-kit) |
| `drizzle/0003_worker_service_rls.sql` | custom: ENABLE/FORCE RLS + policies for the Stage-4b tables (mirror of `rls/policies-worker.sql`; same sync test) |
| `drizzle/0004_cheerful_red_ghost.sql` | workspaces.report_email (generated by drizzle-kit; settings "report email recipient", honored by the worker's weekly report) |

Drift guard: `src/migrations.test.ts` runs `drizzle-kit generate` and fails
if the schema and `drizzle/` disagree.
