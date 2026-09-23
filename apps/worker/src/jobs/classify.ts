import { createHash } from "node:crypto";
import {
  DEFAULT_DETECTOR_THRESHOLDS,
  DETECTOR_REGISTRY,
  EnvelopeCipher,
  wasteEventSchema,
  type DetectorThresholds,
  type WasteEvent,
} from "@vyaya/core";
import { listWorkspaceIds, schema, withWorkspace, type DbHandle } from "@vyaya/db";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { WorkerTracer } from "../otel.js";
import {
  formatCursor,
  loadLogBatch,
  readCheckpoint,
  type LogCursor,
} from "../request-logs.js";

/**
 * jobs/classify — the detector run.
 *
 * For each workspace (enumerated via the service-role path in @vyaya/db),
 * load unprocessed request_logs since the per-workspace checkpoint, run the
 * @vyaya/core detector registry, write waste_events, advance the checkpoint.
 *
 * Idempotency: every waste_event carries a deterministic dedupe_key —
 * sha256(workspace_id | waste_type | detector_version | sorted request_ids)
 * — anchored by a UNIQUE index (waste_events_workspace_dedupe_idx) and
 * written ON CONFLICT DO NOTHING. Re-running over the same logs can never
 * duplicate an event, even across process restarts.
 *
 * Resumability: each batch commits (events + detector_runs checkpoint row)
 * in ONE transaction. A crash mid-run rolls back only the in-flight batch;
 * the next run resumes from the last committed checkpoint. The
 * `hooks.afterBatch` crash-injection point exists to prove this in tests.
 */

export interface ClassifyHooks {
  /** Test-only crash injection: called after each committed batch. */
  afterBatch?: (workspaceId: string, batchIndex: number) => void;
}

export interface ClassifyJobDeps {
  db: DbHandle;
  thresholds: DetectorThresholds;
  batchSize: number;
  /** Master key for decrypting prompt bodies; null = metadata-only. */
  masterKeyHex: string | null;
  tracer: WorkerTracer;
  logger: Logger;
  nowMs?: () => number;
  hooks?: ClassifyHooks;
}

export interface WorkspaceClassifyResult {
  workspaceId: string;
  batches: number;
  logsProcessed: number;
  eventsEmitted: number;
  /** Events whose dedupe_key already existed (re-runs). */
  eventsDeduplicated: number;
}

export interface ClassifyResult {
  workspaces: WorkspaceClassifyResult[];
  totalEventsEmitted: number;
}

/** Deterministic idempotency key for one waste event. */
export function wasteEventDedupeKey(event: WasteEvent): string {
  const ids = [...event.requestIds].sort().join(",");
  return createHash("sha256")
    .update(
      `${event.workspaceId}|${event.wasteType}|${event.detectorVersion}|${ids}`,
      "utf8",
    )
    .digest("hex");
}

export async function runClassifyJob(deps: ClassifyJobDeps): Promise<ClassifyResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const cipher = deps.masterKeyHex
    ? new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(deps.masterKeyHex))
    : null;
  const workspaceIds = await listWorkspaceIds(deps.db);
  const result: ClassifyResult = { workspaces: [], totalEventsEmitted: 0 };

  for (const workspaceId of workspaceIds) {
    result.workspaces.push(await classifyWorkspace(deps, workspaceId, cipher, nowMs));
  }
  result.totalEventsEmitted = result.workspaces.reduce(
    (sum, w) => sum + w.eventsEmitted,
    0,
  );
  return result;
}

async function classifyWorkspace(
  deps: ClassifyJobDeps,
  workspaceId: string,
  cipher: EnvelopeCipher | null,
  nowMs: () => number,
): Promise<WorkspaceClassifyResult> {
  const summary: WorkspaceClassifyResult = {
    workspaceId,
    batches: 0,
    logsProcessed: 0,
    eventsEmitted: 0,
    eventsDeduplicated: 0,
  };

  // Workspace settings: threshold overrides + body-logging key material.
  // Read outside the batch loop; a mid-run settings change applies next run.
  const workspace = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const rows = await tx
      .select({
        detectorThresholds: schema.workspaces.detectorThresholds,
        wrappedDek: schema.workspaces.wrappedDek,
        logBodiesEnabled: schema.workspaces.logBodiesEnabled,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return rows[0] ?? null;
  });
  if (workspace === null) return summary; // deleted between list and read

  const thresholds: DetectorThresholds = {
    ...DEFAULT_DETECTOR_THRESHOLDS,
    ...deps.thresholds,
    ...(workspace.detectorThresholds ?? {}),
  };
  const wrappedDek = workspace.logBodiesEnabled ? workspace.wrappedDek : null;

  // Resume after the last committed checkpoint.
  let cursor: LogCursor | null = await withWorkspace(deps.db, workspaceId, (tx) =>
    readCheckpoint(tx, workspaceId),
  );

  for (;;) {
    const startedAt = new Date(nowMs());
    // One transaction per batch: events + checkpoint commit atomically.
    const batch = await withWorkspace(deps.db, workspaceId, async (tx) => {
      const logs = await loadLogBatch({
        tx,
        workspaceId,
        cursor,
        batchSize: deps.batchSize,
        cipher,
        wrappedDek,
      });
      if (logs.length === 0) return { logs, inserted: 0, deduplicated: 0, emitted: [] as WasteEvent[] };

      const events = DETECTOR_REGISTRY.flatMap((detector) =>
        detector.detect({ workspaceId, logs, thresholds, nowMs: nowMs() }),
      );

      let inserted = 0;
      let emitted: WasteEvent[] = [];
      if (events.length > 0) {
        const rows = events.map((event) => {
          // Boundary validation before the write (zod schema from core).
          wasteEventSchema.parse(event);
          return {
            workspaceId: event.workspaceId,
            wasteType: event.wasteType,
            requestIds: event.requestIds,
            dedupeKey: wasteEventDedupeKey(event),
            dollarsWasted: event.dollarsWasted,
            evidence: event.evidence,
            detectorVersion: event.detectorVersion,
            suggestedFix: event.suggestedFix,
            detectedAt: new Date(event.detectedAtMs),
          };
        });
        const written = await tx
          .insert(schema.wasteEvents)
          .values(rows)
          .onConflictDoNothing({
            target: [schema.wasteEvents.workspaceId, schema.wasteEvents.dedupeKey],
          })
          .returning({ dedupeKey: schema.wasteEvents.dedupeKey });
        inserted = written.length;
        const writtenKeys = new Set(written.map((w) => w.dedupeKey));
        emitted = events.filter((e) => writtenKeys.has(wasteEventDedupeKey(e)));
      }

      // Advance the checkpoint to the last log of this batch, same tx.
      const last = logs[logs.length - 1];
      if (last !== undefined) {
        await tx.insert(schema.detectorRuns).values({
          workspaceId,
          startedAt,
          finishedAt: new Date(nowMs()),
          lastProcessedLogId: formatCursor({
            occurredAtMs: last.occurredAtMs,
            requestId: last.requestId,
          }),
          status: "completed",
        });
      }
      return { logs, inserted, deduplicated: events.length - inserted, emitted };
    });

    if (batch.logs.length === 0) break;

    summary.batches += 1;
    summary.logsProcessed += batch.logs.length;
    summary.eventsEmitted += batch.inserted;
    summary.eventsDeduplicated += batch.deduplicated;

    // OTel: one span per emitted waste_event (post-commit), off unless
    // SENTINEL_ENABLED. No-op spans make this free in the default config.
    for (const event of batch.emitted) {
      const span = deps.tracer.startSpan("waste_event.emitted", {
        "waste.type": event.wasteType,
        "waste.dollars_wasted": event.dollarsWasted,
        "waste.detector_version": event.detectorVersion,
        "workspace.id": event.workspaceId,
      });
      span.end();
    }
    const lastLog = batch.logs[batch.logs.length - 1];
    if (lastLog !== undefined) {
      cursor = { occurredAtMs: lastLog.occurredAtMs, requestId: lastLog.requestId };
    }
    deps.hooks?.afterBatch?.(workspaceId, summary.batches - 1);
  }

  deps.logger.info(
    {
      workspaceId,
      batches: summary.batches,
      logsProcessed: summary.logsProcessed,
      eventsEmitted: summary.eventsEmitted,
      eventsDeduplicated: summary.eventsDeduplicated,
    },
    "classify workspace done",
  );
  return summary;
}
