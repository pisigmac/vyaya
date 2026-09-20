import { listWorkspaceIds, withWorkspace, type DbHandle } from "@vyaya/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";

/**
 * jobs/retention-sweeper — enforce the retention contract:
 *   * request_bodies older than BODY_RETENTION_DAYS (default 7) deleted
 *     (both created_at and the expires_at column are enforced, so rows
 *     written under an older policy are still swept),
 *   * request_logs older than METADATA_RETENTION_DAYS (default 400)
 *     deleted — after rolling them into daily_aggregates, which is kept
 *     forever,
 *   * daily_aggregates is never swept.
 *
 * The rollup happens in the SAME transaction as the delete, so a crashed
 * sweep can neither lose history nor double-count it (a retried sweep
 * finds no expired rows left to roll up). request_bodies rows cascade with
 * their request_logs row; the explicit body sweep keeps them bounded even
 * for logs well inside the metadata window.
 */

export interface RetentionSweepDeps {
  db: DbHandle;
  bodyRetentionDays: number;
  metadataRetentionDays: number;
  logger: Logger;
  nowMs?: () => number;
}

export interface WorkspaceSweepResult {
  workspaceId: string;
  bodiesDeleted: number;
  logsDeleted: number;
  daysRolledUp: number;
}

export interface RetentionSweepResult {
  workspaces: WorkspaceSweepResult[];
}

const DAY_MS = 86_400_000;

export async function runRetentionSweep(
  deps: RetentionSweepDeps,
): Promise<RetentionSweepResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  // ISO strings + explicit ::timestamptz casts: postgres.js re-execution of
  // prepared statements mishandles raw Date parameters (see
  // docs/ASSUMPTIONS.md #37 for the jsonb flavor of the same problem).
  const nowIso = new Date(nowMs).toISOString();
  const bodyCutoffIso = new Date(nowMs - deps.bodyRetentionDays * DAY_MS).toISOString();
  const metadataCutoffIso = new Date(nowMs - deps.metadataRetentionDays * DAY_MS).toISOString();
  const workspaceIds = await listWorkspaceIds(deps.db);

  const workspaces: WorkspaceSweepResult[] = [];
  for (const workspaceId of workspaceIds) {
    const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
      // 1. Bodies past retention (created_at policy OR stored expiry).
      const bodies = await tx.execute(
        sql`DELETE FROM request_bodies
            WHERE workspace_id = ${workspaceId}
              AND (created_at < ${bodyCutoffIso}::timestamptz OR expires_at < ${nowIso}::timestamptz)
            RETURNING request_id`,
      );
      const bodiesDeleted = bodies.length;

      // 2. Roll expired logs into daily_aggregates (kept forever), same tx.
      const rolled = await tx.execute(
        sql`INSERT INTO daily_aggregates
              (workspace_id, day, request_count, prompt_tokens, completion_tokens, cost_usd, updated_at)
            SELECT workspace_id,
                   (occurred_at AT TIME ZONE 'UTC')::date AS day,
                   count(*)::bigint,
                   sum(prompt_tokens)::bigint,
                   sum(completion_tokens)::bigint,
                   sum(cost_usd)::numeric(14,8),
                   now()
            FROM request_logs
            WHERE workspace_id = ${workspaceId} AND occurred_at < ${metadataCutoffIso}::timestamptz
            GROUP BY workspace_id, (occurred_at AT TIME ZONE 'UTC')::date
            ON CONFLICT (workspace_id, day) DO UPDATE SET
              request_count = daily_aggregates.request_count + EXCLUDED.request_count,
              prompt_tokens = daily_aggregates.prompt_tokens + EXCLUDED.prompt_tokens,
              completion_tokens = daily_aggregates.completion_tokens + EXCLUDED.completion_tokens,
              cost_usd = daily_aggregates.cost_usd + EXCLUDED.cost_usd,
              updated_at = now()
            RETURNING day`,
      );

      // 3. Delete the expired metadata rows.
      const logs = await tx.execute(
        sql`DELETE FROM request_logs
            WHERE workspace_id = ${workspaceId} AND occurred_at < ${metadataCutoffIso}::timestamptz
            RETURNING request_id`,
      );
      return {
        workspaceId,
        bodiesDeleted,
        daysRolledUp: rolled.length,
        logsDeleted: logs.length,
      };
    });
    deps.logger.info({ ...result }, "retention sweep workspace done");
    workspaces.push(result);
  }
  return { workspaces };
}
