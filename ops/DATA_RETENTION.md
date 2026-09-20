# ops/DATA_RETENTION.md

The retention contract, the sweeper that enforces it, and how to prove
deletion happened.

## The policy

| Data | Retention | Where it lives | Then |
| --- | --- | --- | --- |
| Prompt/response bodies | **7 days** (`BODY_RETENTION_DAYS`) | `request_bodies`, AES-256-GCM encrypted | Hard-deleted. |
| Request metadata | **400 days** (`METADATA_RETENTION_DAYS`) | `request_logs` | Rolled into aggregates, then hard-deleted. |
| Daily aggregates | **forever** | `daily_aggregates` (workspace, day, request count, token sums, cost) | Never swept. |
| Waste events | not time-limited | `waste_events` | Deleted only with their workspace (cascade). |
| Reports + PDFs | not time-limited | `reports` + `REPORT_OUTPUT_DIR` | Manual cleanup if ever needed. |
| API keys | forever, soft | `api_keys.revoked_at` | Revoked, never hard-deleted (audit). |

## Sweeper mechanics

Job: `retention-sweeper`, every `RETENTION_SWEEP_INTERVAL_MS` (default
1h), per workspace, inside RLS-scoped transactions.

1. **Bodies.** `DELETE FROM request_bodies WHERE created_at < body_cutoff
   OR expires_at < now`. Both conditions are enforced, so rows written
   under an older policy (longer window) still get swept when their
   stored `expires_at` passes.
2. **Metadata rollup + delete, one transaction.** Expired `request_logs`
   are summed per UTC day into `daily_aggregates`
   (`ON CONFLICT (workspace_id, day) DO UPDATE` adds to the existing row)
   and deleted in the SAME transaction. A crashed sweep neither loses
   history nor double-counts it: the retry finds no expired rows left to
   roll up.
3. **Aggregates.** Never touched.

`request_bodies` also cascade-deletes with their `request_logs` row; the
explicit body sweep keeps bodies bounded even for logs well inside the
metadata window.

## Configuration

```
BODY_RETENTION_DAYS=7        # bodies
METADATA_RETENTION_DAYS=400  # request metadata
RETENTION_SWEEP_INTERVAL_MS=3600000
```

Shorter windows are always safe (more deletion). Longer windows change
the promise you made to users — treat that as a policy change, not a
config tweak, and update this file.

## Legal / compliance notes

- **Bodies are opt-in.** A workspace that never enables body logging has
  nothing but metadata on our disks. The 7-day window starts at write,
  not at opt-out.
- **Encryption at rest** means a database dump without
  `MASTER_ENCRYPTION_KEY` yields no body content. Rotation re-wraps DEKs
  without re-encrypting bodies (see `docs/ARCHITECTURE.md`).
- **Workspace deletion** cascades: request logs, bodies, waste events,
  keys, reports, aggregates all carry `ON DELETE CASCADE` from
  `workspaces`. Deleting the workspace row is the full-erasure path.
- **Aggregates contain no content** — counts, token sums, cost. They
  survive metadata deletion deliberately; they can't reconstruct a
  prompt.
- Nothing here is legal advice. It's the system's actual behavior, written
  down so your lawyer reviews facts, not vibes.

## Deletion proof

To demonstrate the sweeper ran and deleted:

```sql
-- Bodies: zero rows older than the window.
SELECT count(*) FROM request_bodies
WHERE created_at < now() - interval '7 days' OR expires_at < now();

-- Metadata: zero rows older than 400 days.
SELECT count(*) FROM request_logs
WHERE occurred_at < now() - interval '400 days';

-- History preserved: aggregates cover the deleted window.
SELECT day, request_count, cost_usd FROM daily_aggregates
WHERE workspace_id = $1 ORDER BY day DESC LIMIT 10;
```

All three checks are exercised against real Postgres in the worker's
retention-sweeper tests (rollup-then-delete atomicity included). For an
audit, run the queries, screenshot, attach the worker health payload
showing the last `retention-sweeper` run (`GET :8790/healthz`).
