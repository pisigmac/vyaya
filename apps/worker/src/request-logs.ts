import { EnvelopeCipher, requestLogSchema, type RequestLog } from "@vyaya/core";
import { schema, type VyayaTx } from "@vyaya/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

/**
 * Checkpointed request_log loading for the classifier.
 *
 * Cursor format: `${occurredAtMs}:${requestId}` — self-contained, so it
 * keeps working after the retention sweeper deletes the referenced log row
 * (400-day metadata retention). Ordering is (occurred_at, request_id), the
 * same total order the detectors sort by.
 */

export interface LogCursor {
  occurredAtMs: number;
  requestId: string;
}

export function formatCursor(cursor: LogCursor): string {
  return `${cursor.occurredAtMs}:${cursor.requestId}`;
}

export function parseCursor(raw: string): LogCursor | null {
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const occurredAtMs = Number.parseInt(raw.slice(0, sep), 10);
  const requestId = raw.slice(sep + 1);
  if (!Number.isFinite(occurredAtMs) || occurredAtMs < 0 || requestId.length === 0) {
    return null;
  }
  return { occurredAtMs, requestId };
}

/** Latest completed-run checkpoint for a workspace, or null (never run). */
export async function readCheckpoint(
  tx: VyayaTx,
  workspaceId: string,
): Promise<LogCursor | null> {
  const rows = await tx
    .select({ cursor: schema.detectorRuns.lastProcessedLogId })
    .from(schema.detectorRuns)
    .where(
      sql`${schema.detectorRuns.workspaceId} = ${workspaceId}
          AND ${schema.detectorRuns.status} = 'completed'
          AND ${schema.detectorRuns.lastProcessedLogId} IS NOT NULL`,
    )
    .orderBy(
      sql`${schema.detectorRuns.finishedAt} DESC NULLS LAST`,
      sql`${schema.detectorRuns.createdAt} DESC`,
    )
    .limit(1);
  const raw = rows[0]?.cursor;
  if (raw === null || raw === undefined) return null;
  return parseCursor(raw);
}

/**
 * Load up to `batchSize` request_logs strictly after the cursor, plus
 * decrypted prompt text for any row with a stored body (workspaces that
 * opted into body logging). Decryption failures are treated as
 * metadata-only (promptText null) so one bad envelope can never block a
 * run; context_amnesia simply skips textless turns.
 */
export async function loadLogBatch(options: {
  tx: VyayaTx;
  workspaceId: string;
  cursor: LogCursor | null;
  batchSize: number;
  cipher: EnvelopeCipher | null;
  wrappedDek: unknown;
}): Promise<RequestLog[]> {
  const { tx, workspaceId, cursor, batchSize, cipher } = options;
  // ISO string + explicit cast: postgres.js prepared-statement re-execution
  // mishandles Date parameters (docs/ASSUMPTIONS.md #37 pattern).
  const after = cursor
    ? sql`(${schema.requestLogs.occurredAt}, ${schema.requestLogs.requestId})
          > (${new Date(cursor.occurredAtMs).toISOString()}::timestamptz, ${cursor.requestId})`
    : undefined;
  // Explicit workspace filter IN ADDITION to RLS: the service role (and a
  // dev superuser) can read every tenant, so scoping must be in the query.
  const where = and(
    eq(schema.requestLogs.workspaceId, workspaceId),
    after,
  );
  const rows = await tx
    .select()
    .from(schema.requestLogs)
    .where(where)
    .orderBy(asc(schema.requestLogs.occurredAt), asc(schema.requestLogs.requestId))
    .limit(batchSize);

  // Decrypt prompt envelopes for this batch (context_amnesia needs text).
  const promptByRequestId = new Map<string, string>();
  if (cipher !== null && options.wrappedDek !== null && rows.length > 0) {
    let dek: Buffer | null = null;
    try {
      // jsonb readback is normalized defensively: some driver paths return
      // the raw string instead of a parsed object.
      const wrapped =
        typeof options.wrappedDek === "string"
          ? (JSON.parse(options.wrappedDek) as Parameters<EnvelopeCipher["unwrapDek"]>[0])
          : (options.wrappedDek as Parameters<EnvelopeCipher["unwrapDek"]>[0]);
      dek = cipher.unwrapDek(wrapped);
    } catch {
      dek = null; // wrong master key: treat the workspace as metadata-only.
    }
    if (dek !== null) {
      const bodies = await tx
        .select({
          requestId: schema.requestBodies.requestId,
          promptEnvelope: schema.requestBodies.promptEnvelope,
        })
        .from(schema.requestBodies)
        .where(
          and(
            eq(schema.requestBodies.workspaceId, workspaceId),
            inArray(
              schema.requestBodies.requestId,
              rows.map((r) => r.requestId),
            ),
          ),
        );
      const aad = Buffer.from(workspaceId, "utf8");
      for (const body of bodies) {
        try {
          promptByRequestId.set(
            body.requestId,
            cipher.decryptText(dek, body.promptEnvelope, aad),
          );
        } catch {
          // Corrupt envelope for one row: metadata-only for that row.
        }
      }
    }
  }

  // Boundary validation: DB rows -> RequestLog (zod), never trust blindly.
  return rows.map((row) =>
    requestLogSchema.parse({
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      occurredAtMs: row.occurredAt.getTime(),
      model: row.model,
      endpoint: row.endpoint,
      latencyMs: row.latencyMs,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      maxTokens: row.maxTokens,
      costUsd: row.costUsd,
      inputCostUsd: row.inputCostUsd,
      outputCostUsd: row.outputCostUsd,
      promptHash: row.promptHash,
      sessionId: row.sessionId,
      featureTag: row.featureTag,
      status: row.status,
      schemaValidation: row.schemaValidation,
      retryAttempt: row.retryAttempt,
      retryOf: row.retryOf,
      responseConsumed: row.responseConsumed,
      promptText: promptByRequestId.get(row.requestId) ?? null,
    }),
  );
}
