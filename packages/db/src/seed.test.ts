import { DETECTOR_REGISTRY, DEFAULT_DETECTOR_THRESHOLDS, EnvelopeCipher, WASTE_TYPES, type RequestLog, type WasteType } from "@vyaya/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyApiKey } from "./api-keys.js";
import { createDb, withWorkspace } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  runSeed,
  SEED_WORKSPACE_A_ID,
  SEED_WORKSPACE_B_ID,
  type SeedSummary,
} from "./seed.js";
import * as schema from "./schema/index.js";
import {
  startEmbeddedPostgres,
  type EmbeddedPg,
} from "./test-support/embedded-pg.js";

// Deterministic 32-byte dev key (all-zero pattern from .env.example).
const MASTER_KEY_HEX = "00".repeat(32);
// Fixed reference clock: seed data and the detector run share it.
const NOW_MS = Date.UTC(2026, 8, 20, 12, 0, 0);

const EXPECTED_LOGS_A = 3 * 4 + 8 + 6 + 2 * 6 + 55 + 12; // 105
const EXPECTED_LOGS_B = 2 * 4 + 6 + 5 + 55 + 15; // 89
const EXPECTED_TOTAL = EXPECTED_LOGS_A + EXPECTED_LOGS_B; // 194

describe("seed", () => {
  let cluster: EmbeddedPg;
  let sql: postgres.Sql;
  let first: SeedSummary;

  beforeAll(async () => {
    cluster = await startEmbeddedPostgres();
    await runMigrations(cluster.url);
    sql = postgres(cluster.url, { max: 2, onnotice: () => {} });
    first = await runSeed({
      databaseUrl: cluster.url,
      masterKeyHex: MASTER_KEY_HEX,
      nowMs: NOW_MS,
    });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await cluster?.stop();
  });

  it("creates 2 workspaces, 2 users, 2 API keys and ~200 request logs", () => {
    expect(first.workspacesCreated).toBe(2);
    expect(first.usersCreated).toBe(2);
    expect(first.newApiKeys).toHaveLength(2);
    expect(first.requestLogsInserted).toBe(EXPECTED_TOTAL);
    expect(first.requestBodiesInserted).toBe(12); // 2 amnesia sessions x 6 turns
    expect(first.bodiesSkippedNoMasterKey).toBe(false);
  });

  it("prints each API key plaintext exactly once, and the stored hash verifies", async () => {
    for (const key of first.newApiKeys) {
      expect(key.plaintext).toMatch(/^vy_live_[0-9a-f]{64}$/);
      const rows = await sql<{ key_hash: string; last4: string }[]>`
        SELECT k.key_hash, k.last4 FROM api_keys k
        JOIN workspaces w ON w.id = k.workspace_id
        WHERE w.slug = ${key.workspaceSlug}`;
      const stored = rows[0];
      expect(stored).toBeDefined();
      expect(stored?.last4).toBe(key.plaintext.slice(-4));
      expect(await verifyApiKey(stored?.key_hash ?? "", key.plaintext)).toBe(true);
      const wrong = key.plaintext[8] === "a"
        ? `${key.plaintext.slice(0, 8)}b${key.plaintext.slice(9)}`
        : `${key.plaintext.slice(0, 8)}a${key.plaintext.slice(9)}`;
      expect(await verifyApiKey(stored?.key_hash ?? "", wrong)).toBe(false);
      // The plaintext itself is nowhere in the row.
      expect(stored?.key_hash).not.toContain(key.plaintext);
    }
  });

  it("runs idempotently: a second run inserts nothing and prints no keys", async () => {
    const countBefore = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM request_logs`;
    const second = await runSeed({
      databaseUrl: cluster.url,
      masterKeyHex: MASTER_KEY_HEX,
      nowMs: NOW_MS + 86_400_000, // even a day later: still no duplicates
    });
    expect(second.workspacesCreated).toBe(0);
    expect(second.usersCreated).toBe(0);
    expect(second.requestLogsInserted).toBe(0);
    expect(second.requestBodiesInserted).toBe(0);
    expect(second.newApiKeys).toHaveLength(0);
    const countAfter = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM request_logs`;
    expect(countAfter[0]?.count).toBe(countBefore[0]?.count);
    expect(countAfter[0]?.count).toBe(String(EXPECTED_TOTAL));
  });

  it("gives the detectors something to find: all 5 waste types fire", async () => {
    // max:1 + SET ROLE: this handle goes through RLS like production code,
    // so withWorkspace scoping is what filters each workspace's rows.
    const handle = createDb({ databaseUrl: cluster.url, maxConnections: 1 });
    await handle.client`SET ROLE vyaya_app`;
    try {
      // Workspace A opted into body logging: decrypt amnesia prompts the
      // same way the worker will (unwrap DEK with the master key).
      const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER_KEY_HEX));
      const promptByRequestId = new Map<string, string>();
      await withWorkspace(handle, SEED_WORKSPACE_A_ID, async (tx) => {
        const [ws] = await tx
          .select({ wrappedDek: schema.workspaces.wrappedDek })
          .from(schema.workspaces);
        expect(ws?.wrappedDek).toBeTruthy();
        const dek = cipher.unwrapDek(ws?.wrappedDek ?? (() => { throw new Error("no DEK"); })());
        const bodies = await tx.select().from(schema.requestBodies);
        for (const body of bodies) {
          promptByRequestId.set(
            body.requestId,
            cipher.decryptText(dek, body.promptEnvelope, Buffer.from(SEED_WORKSPACE_A_ID, "utf8")),
          );
        }
      });

      const loadLogs = async (workspaceId: string): Promise<RequestLog[]> =>
        withWorkspace(handle, workspaceId, async (tx) => {
          const rows = await tx.select().from(schema.requestLogs);
          // RLS, not a WHERE clause, is doing this filtering.
          expect(rows.every((r) => r.workspaceId === workspaceId)).toBe(true);
          return rows.map((row) => ({
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
            responseConsumed: row.responseConsumed,
            promptText: promptByRequestId.get(row.requestId) ?? null,
          }));
        });

      const runDetectors = (workspaceId: string, logs: RequestLog[]) =>
        DETECTOR_REGISTRY.flatMap((detector) =>
          detector.detect({
            workspaceId,
            logs,
            thresholds: DEFAULT_DETECTOR_THRESHOLDS,
            nowMs: NOW_MS,
          }),
        );

      const eventsA = runDetectors(SEED_WORKSPACE_A_ID, await loadLogs(SEED_WORKSPACE_A_ID));
      expect((await loadLogs(SEED_WORKSPACE_A_ID)).length).toBe(EXPECTED_LOGS_A);
      const typesA = new Set<WasteType>(eventsA.map((e) => e.wasteType));
      for (const type of WASTE_TYPES) {
        expect(typesA.has(type), `workspace A should produce ${type}`).toBe(true);
      }
      const countByType = (type: WasteType) =>
        eventsA.filter((e) => e.wasteType === type).length;
      expect(countByType("ghost_output")).toBe(8);
      expect(countByType("retry_storm")).toBe(3);
      expect(countByType("schema_failure_burn")).toBe(6);
      expect(countByType("context_amnesia")).toBe(2); // one per session
      expect(countByType("overprovisioned_max_tokens")).toBe(1); // one 55-call run

      // Workspace B is metadata-only: context_amnesia needs prompt bodies,
      // the other four detectors still fire.
      const eventsB = runDetectors(SEED_WORKSPACE_B_ID, await loadLogs(SEED_WORKSPACE_B_ID));
      const typesB = new Set<WasteType>(eventsB.map((e) => e.wasteType));
      expect(typesB.has("context_amnesia")).toBe(false);
      for (const type of WASTE_TYPES.filter((t) => t !== "context_amnesia")) {
        expect(typesB.has(type), `workspace B should produce ${type}`).toBe(true);
      }

      // Every event carries the pinned detector version and a fix.
      for (const event of [...eventsA, ...eventsB]) {
        expect(event.detectorVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(event.suggestedFix.length).toBeGreaterThan(0);
        expect(event.dollarsWasted).toBeGreaterThan(0);
        expect(event.requestIds.length).toBeGreaterThan(0);
      }
    } finally {
      await handle.client.end({ timeout: 5 });
    }
  });

  it("skips encrypted bodies cleanly when MASTER_ENCRYPTION_KEY is unset", async () => {
    await cluster.pg.createDatabase("vyaya_nobodies");
    const url = `postgres://vyaya:vyaya@127.0.0.1:${cluster.port}/vyaya_nobodies`;
    await runMigrations(url);
    const summary = await runSeed({ databaseUrl: url, nowMs: NOW_MS });
    expect(summary.bodiesSkippedNoMasterKey).toBe(true);
    expect(summary.requestBodiesInserted).toBe(0);
    expect(summary.requestLogsInserted).toBe(EXPECTED_TOTAL);
    const bare = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await bare<{ log_bodies_enabled: boolean }[]>`
        SELECT log_bodies_enabled FROM workspaces WHERE id = ${SEED_WORKSPACE_A_ID}`;
      expect(rows[0]?.log_bodies_enabled).toBe(false);
    } finally {
      await bare.end({ timeout: 5 });
    }
  }, 120_000);
});
