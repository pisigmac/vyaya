import {
  DEFAULT_DETECTOR_THRESHOLDS,
  WASTE_TYPES,
  type WasteType,
} from "@vyaya/core";
import { schema, SEED_WORKSPACE_A_ID, SEED_WORKSPACE_B_ID } from "@vyaya/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runClassifyJob, wasteEventDedupeKey } from "./classify.js";
import { createNoopTracer } from "../otel.js";
import { formatCursor, parseCursor } from "../request-logs.js";
import {
  MASTER_KEY_HEX,
  SEED_NOW_MS,
  addSeededDatabase,
  setupBareDb,
  setupSeededDb,
  silentLogger,
  type SeededDb,
} from "../test-utils.js";

/**
 * classify job: detector run over seeded traffic, idempotency under
 * re-runs, checkpoint advance, and crash-resume.
 */

const EXPECTED_EVENTS_A: Record<WasteType, number> = {
  ghost_output: 8,
  retry_storm: 3,
  schema_failure_burn: 6,
  context_amnesia: 2,
  overprovisioned_max_tokens: 1,
};
const EXPECTED_EVENTS_B: Record<WasteType, number> = {
  ghost_output: 6,
  retry_storm: 2,
  schema_failure_burn: 5,
  context_amnesia: 0, // metadata-only workspace: no prompt bodies
  overprovisioned_max_tokens: 1,
};

function classifyDeps(db: SeededDb["db"], batchSize = 5_000) {
  return {
    db,
    thresholds: DEFAULT_DETECTOR_THRESHOLDS,
    batchSize,
    masterKeyHex: MASTER_KEY_HEX,
    tracer: createNoopTracer(),
    logger: silentLogger,
    nowMs: () => SEED_NOW_MS,
  };
}

async function eventRows(db: SeededDb["db"], workspaceId: string) {
  const rows = await db.db
    .select({
      wasteType: schema.wasteEvents.wasteType,
      dedupeKey: schema.wasteEvents.dedupeKey,
      dollarsWasted: schema.wasteEvents.dollarsWasted,
      requestIds: schema.wasteEvents.requestIds,
      detectorVersion: schema.wasteEvents.detectorVersion,
    })
    .from(schema.wasteEvents)
    .where(eq(schema.wasteEvents.workspaceId, workspaceId))
    .orderBy(schema.wasteEvents.dedupeKey);
  return rows;
}

describe("classify job", () => {
  let seeded: SeededDb;

  beforeAll(async () => {
    seeded = await setupSeededDb();
  }, 180_000);

  afterAll(async () => {
    await seeded?.close();
  });

  it("runs all 5 detectors on seeded data and writes waste_events", async () => {
    const result = await runClassifyJob(classifyDeps(seeded.db));
    expect(result.workspaces).toHaveLength(2);

    const eventsA = await eventRows(seeded.db, SEED_WORKSPACE_A_ID);
    const eventsB = await eventRows(seeded.db, SEED_WORKSPACE_B_ID);

    const countByType = (rows: { wasteType: WasteType }[], type: WasteType) =>
      rows.filter((r) => r.wasteType === type).length;
    for (const type of WASTE_TYPES) {
      expect(countByType(eventsA, type), `A/${type}`).toBe(EXPECTED_EVENTS_A[type]);
      expect(countByType(eventsB, type), `B/${type}`).toBe(EXPECTED_EVENTS_B[type]);
    }
    expect(result.totalEventsEmitted).toBe(
      eventsA.length + eventsB.length,
    );
    for (const row of [...eventsA, ...eventsB]) {
      expect(row.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
      expect(row.dollarsWasted).toBeGreaterThan(0);
      expect(row.detectorVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(row.requestIds.length).toBeGreaterThan(0);
    }
  });

  it("advances the checkpoint to the newest processed log per workspace", async () => {
    for (const wsId of [SEED_WORKSPACE_A_ID, SEED_WORKSPACE_B_ID]) {
      const runs = await seeded.db.db
        .select()
        .from(schema.detectorRuns)
        .where(eq(schema.detectorRuns.workspaceId, wsId));
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.status === "completed")).toBe(true);
      const cursor = runs[runs.length - 1]?.lastProcessedLogId;
      expect(cursor).toBeTruthy();
      const parsed = parseCursor(cursor ?? "");
      expect(parsed).not.toBeNull();
      expect(parsed?.occurredAtMs).toBeLessThanOrEqual(SEED_NOW_MS);
    }
  });

  it("is idempotent: a second run emits zero events and changes nothing", async () => {
    const before = await eventRows(seeded.db, SEED_WORKSPACE_A_ID);
    const beforeB = await eventRows(seeded.db, SEED_WORKSPACE_B_ID);
    const second = await runClassifyJob(classifyDeps(seeded.db));
    expect(second.totalEventsEmitted).toBe(0);
    expect(second.workspaces.every((w) => w.logsProcessed === 0)).toBe(true);
    expect(await eventRows(seeded.db, SEED_WORKSPACE_A_ID)).toEqual(before);
    expect(await eventRows(seeded.db, SEED_WORKSPACE_B_ID)).toEqual(beforeB);
  });

  it("dedupe keys are deterministic: re-processing the same logs conflicts, never duplicates", async () => {
    // Simulate a replay by deleting checkpoints: the run reprocesses every
    // log, but ON CONFLICT on dedupe_key means zero new rows.
    await seeded.db.db.delete(schema.detectorRuns);
    const before = await eventRows(seeded.db, SEED_WORKSPACE_A_ID);
    const replay = await runClassifyJob(classifyDeps(seeded.db));
    expect(replay.totalEventsEmitted).toBe(0);
    const deduped = replay.workspaces.reduce((s, w) => s + w.eventsDeduplicated, 0);
    expect(deduped).toBe(before.length + EXPECTED_EVENTS_BTotal());
    expect(await eventRows(seeded.db, SEED_WORKSPACE_A_ID)).toEqual(before);
  });

  function EXPECTED_EVENTS_BTotal(): number {
    return Object.values(EXPECTED_EVENTS_B).reduce((a, b) => a + b, 0);
  }
});

describe("classify crash-resume", () => {
  it("a crash mid-run leaves committed batches; restart finishes with the identical end state", async () => {
    // One cluster, two seeded databases: a clean reference run and a
    // crashed-then-resumed run (cheaper than two Postgres clusters).
    const host = await setupBareDb();
    const clean = await addSeededDatabase(host.cluster, "crash_clean");
    const crashed = await addSeededDatabase(host.cluster, "crash_resumed");
    try {
      const batchSize = 40; // several batches per workspace
      let crashFired = false;
      await expect(
        runClassifyJob({
          ...classifyDeps(crashed, batchSize),
          hooks: {
            afterBatch: (workspaceId, batchIndex) => {
              if (workspaceId === SEED_WORKSPACE_A_ID && batchIndex === 0 && !crashFired) {
                crashFired = true;
                throw new Error("injected crash after batch 0");
              }
            },
          },
        }),
      ).rejects.toThrow("injected crash");
      expect(crashFired).toBe(true);

      // The committed batch survived: checkpoint + its events exist.
      const runsAfterCrash = await crashed.db
        .select()
        .from(schema.detectorRuns)
        .where(eq(schema.detectorRuns.workspaceId, SEED_WORKSPACE_A_ID));
      expect(runsAfterCrash).toHaveLength(1);
      expect(runsAfterCrash[0]?.status).toBe("completed");

      // Restart (new run, no crash hook) finishes the job.
      const resumed = await runClassifyJob(classifyDeps(crashed, batchSize));
      const cleanResult = await runClassifyJob(classifyDeps(clean, batchSize));

      for (const wsId of [SEED_WORKSPACE_A_ID, SEED_WORKSPACE_B_ID]) {
        const crashedEvents = await eventRows(crashed, wsId);
        const cleanEvents = await eventRows(clean, wsId);
        expect(crashedEvents).toEqual(cleanEvents);
      }
      expect(resumed.totalEventsEmitted).toBeGreaterThan(0);
      expect(resumed.totalEventsEmitted).toBeLessThanOrEqual(cleanResult.totalEventsEmitted);
    } finally {
      await host.close();
    }
  }, 240_000);
});

describe("cursor helpers", () => {
  it("format/parse round-trips", () => {
    const cursor = { occurredAtMs: 1_758_638_400_000, requestId: "req-abc:123" };
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("abc")).toBeNull();
    expect(parseCursor(":req")).toBeNull();
    expect(parseCursor("-1:req")).toBeNull();
    expect(parseCursor("123:")).toBeNull();
  });

  it("dedupe key is stable regardless of request id order", () => {
    const base = {
      workspaceId: "w",
      wasteType: "ghost_output" as const,
      dollarsWasted: 1,
      evidence: {},
      detectorVersion: "1.0.0",
      suggestedFix: "fix",
      detectedAtMs: 1,
    };
    const a = wasteEventDedupeKey({ ...base, requestIds: ["r1", "r2", "r3"] });
    const b = wasteEventDedupeKey({ ...base, requestIds: ["r3", "r1", "r2"] });
    expect(a).toBe(b);
  });
});
