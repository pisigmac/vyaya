import { randomUUID } from "node:crypto";
import { computeCost } from "@vyaya/core";
import { schema, withWorkspace } from "@vyaya/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetentionSweep } from "./retention-sweeper.js";
import { setupBareDb, silentLogger, type SeededDb } from "../test-utils.js";

/**
 * retention-sweeper: expired bodies and metadata are deleted (metadata only
 * after rollup into daily_aggregates); fresh rows are untouched; a second
 * sweep is a no-op.
 */

const NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0);
const DAY = 86_400_000;
const WS = randomUUID();

function logRow(
  requestId: string,
  workspaceId: string,
  occurredAtMs: number,
  promptTokens = 100,
  completionTokens = 50,
) {
  const cost = computeCost({
    model: "gpt-4o-mini",
    promptTokens,
    completionTokens,
    at: new Date(occurredAtMs),
  });
  return {
    requestId,
    workspaceId,
    occurredAt: new Date(occurredAtMs),
    model: "gpt-4o-mini",
    endpoint: "/v1/chat/completions",
    latencyMs: 100,
    promptTokens,
    completionTokens,
    maxTokens: null,
    costUsd: cost.totalCostUsd,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    promptHash: "a".repeat(64),
    sessionId: null,
    featureTag: null,
    status: "success" as const,
    schemaValidation: "not_requested" as const,
    responseConsumed: true,
    retryAttempt: 0,
    retryOf: null,
  };
}

describe("retention-sweeper", () => {
  let seeded: SeededDb;
  // 401 and 402 days old (expired), 10 days old (fresh).
  const OLD_1 = NOW_MS - 401 * DAY;
  const OLD_2 = NOW_MS - 402 * DAY;
  const FRESH = NOW_MS - 10 * DAY;

  beforeAll(async () => {
    seeded = await setupBareDb();
    await withWorkspace(seeded.db, WS, async (tx) => {
      await tx.insert(schema.workspaces).values({ id: WS, name: "Sweep Co", slug: "sweep-co" });
      await tx.insert(schema.requestLogs).values([
        logRow("sweep-old-1", WS, OLD_1, 100, 50),
        logRow("sweep-old-2", WS, OLD_2, 200, 100),
        logRow("sweep-fresh-1", WS, FRESH),
        logRow("sweep-fresh-2", WS, FRESH),
      ]);
      // Bodies: one expired (created + expiry both past), one fresh.
      const envelope = { ciphertext: "AA==", iv: "AA==", authTag: "AA==" };
      await tx.insert(schema.requestBodies).values([
        {
          requestId: "sweep-fresh-1",
          workspaceId: WS,
          promptEnvelope: envelope,
          promptBytes: 10,
          // created_at forced old via explicit value below (defaultNow
          // otherwise); expires_at is the enforced contract.
          expiresAt: new Date(NOW_MS - 8 * DAY),
          createdAt: new Date(NOW_MS - 8 * DAY),
        },
        {
          requestId: "sweep-fresh-2",
          workspaceId: WS,
          promptEnvelope: envelope,
          promptBytes: 10,
          expiresAt: new Date(NOW_MS + 6 * DAY),
          createdAt: new Date(NOW_MS - 1 * DAY),
        },
      ]);
    });
  }, 180_000);

  afterAll(async () => {
    await seeded?.close();
  });

  it("deletes expired bodies and logs, rolls logs into daily_aggregates first", async () => {
    const result = await runRetentionSweep({
      db: seeded.db,
      bodyRetentionDays: 7,
      metadataRetentionDays: 400,
      logger: silentLogger,
      nowMs: () => NOW_MS,
    });
    expect(result.workspaces).toHaveLength(1);
    const sweep = result.workspaces[0];
    expect(sweep?.bodiesDeleted).toBe(1); // only the expired body
    expect(sweep?.logsDeleted).toBe(2); // the two >400d logs
    expect(sweep?.daysRolledUp).toBe(2); // two distinct UTC days

    const logs = await seeded.db.db
      .select({ requestId: schema.requestLogs.requestId })
      .from(schema.requestLogs)
      .orderBy(schema.requestLogs.requestId);
    expect(logs.map((l) => l.requestId)).toEqual(["sweep-fresh-1", "sweep-fresh-2"]);

    const bodies = await seeded.db.db
      .select({ requestId: schema.requestBodies.requestId })
      .from(schema.requestBodies);
    expect(bodies.map((b) => b.requestId)).toEqual(["sweep-fresh-2"]);

    // Aggregates kept forever: sums match the deleted logs exactly.
    const aggregates = await seeded.db.db
      .select()
      .from(schema.dailyAggregates)
      .orderBy(schema.dailyAggregates.day);
    expect(aggregates).toHaveLength(2);
    const byDay = new Map(aggregates.map((a) => [a.day, a]));
    const day1 = new Date(OLD_1).toISOString().slice(0, 10);
    const day2 = new Date(OLD_2).toISOString().slice(0, 10);
    expect(byDay.get(day1)?.requestCount).toBe(1);
    expect(byDay.get(day1)?.promptTokens).toBe(100);
    expect(byDay.get(day2)?.requestCount).toBe(1);
    expect(byDay.get(day2)?.promptTokens).toBe(200);
    expect(byDay.get(day1)?.costUsd ?? 0).toBeGreaterThan(0);
  });

  it("is a no-op when run again (nothing left to sweep or roll up)", async () => {
    const before = await seeded.db.db
      .select({ n: sql<string>`count(*)::text` })
      .from(schema.dailyAggregates);
    const result = await runRetentionSweep({
      db: seeded.db,
      bodyRetentionDays: 7,
      metadataRetentionDays: 400,
      logger: silentLogger,
      nowMs: () => NOW_MS + DAY,
    });
    expect(result.workspaces[0]?.logsDeleted).toBe(0);
    expect(result.workspaces[0]?.bodiesDeleted).toBe(0);
    expect(result.workspaces[0]?.daysRolledUp).toBe(0);
    const after = await seeded.db.db
      .select({ n: sql<string>`count(*)::text` })
      .from(schema.dailyAggregates);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("respects config-gated retention intervals (longer retention keeps everything)", async () => {
    const result = await runRetentionSweep({
      db: seeded.db,
      bodyRetentionDays: 3650,
      metadataRetentionDays: 3650,
      logger: silentLogger,
      nowMs: () => NOW_MS,
    });
    expect(result.workspaces[0]?.logsDeleted).toBe(0);
    expect(result.workspaces[0]?.bodiesDeleted).toBe(0);
    const logs = await seeded.db.db
      .select({ requestId: schema.requestLogs.requestId })
      .from(schema.requestLogs);
    expect(logs).toHaveLength(2); // the two fresh logs from earlier sweeps
  });
});
