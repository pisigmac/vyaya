import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvelopeCipher, type WrappedDek } from "@vyaya/core";
import { createDb, runMigrations } from "@vyaya/db";
import { startEmbeddedPostgres } from "@vyaya/db/test-support/embedded-pg";
import { pino } from "pino";
import type postgres from "postgres";
import { PostgresBodyStore } from "./bodies.js";
import { silentLogger } from "./test-utils.js";

/**
 * PostgresBodyStore against embedded Postgres: write success, FK-race
 * retry, bounded retry drop, and queue-cap eviction.
 */

const MASTER = "ab".repeat(32);
const WS = "00000000-0000-4000-a000-00000000e010";

describe("PostgresBodyStore", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
  let sql: postgres.Sql;
  let wrapped: WrappedDek;

  const insertLogRow = (requestId: string) =>
    sql`INSERT INTO request_logs (request_id, workspace_id, occurred_at, model, endpoint, latency_ms, prompt_tokens, completion_tokens, cost_usd, input_cost_usd, output_cost_usd, prompt_hash, status, schema_validation)
        VALUES (${requestId}, ${WS}, now(), 'm', 'e', 1, 1, 1, 0.1, 0.1, 0, ${"a".repeat(64)}, 'success', 'not_requested')`;

  beforeAll(async () => {
    pg = await startEmbeddedPostgres();
    await runMigrations(pg.url);
    ({ client: sql } = createDb({ databaseUrl: pg.url, maxConnections: 2 }));
    const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER));
    wrapped = cipher.wrapDek(EnvelopeCipher.generateDek());
    await sql.unsafe(
      `INSERT INTO workspaces (id, name, slug, log_bodies_enabled, wrapped_dek)
       VALUES ($1, 'bodies', 'bodies', true, $2::jsonb)`,
      [WS, JSON.stringify(wrapped)],
      { prepare: false },
    );
  }, 120_000);

  afterAll(async () => {
    await sql.end();
    await pg.stop();
  }, 60_000);

  it("encrypts and writes a body row (decryptable round-trip)", async () => {
    await insertLogRow("req-bodies-1");
    const store = new PostgresBodyStore(sql, MASTER, silentLogger);
    store.store({
      requestId: "req-bodies-1",
      workspaceId: WS,
      promptBody: "the prompt",
      responseBody: "the response",
      wrappedDek: wrapped,
    });
    await store.flush();
    expect(store.metrics().written).toBe(1);
    const rows = await sql`
      SELECT prompt_envelope, response_envelope, prompt_bytes
      FROM request_bodies WHERE request_id = 'req-bodies-1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["prompt_bytes"]).toBe(10);
    const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER));
    const dek = cipher.unwrapDek(wrapped);
    const aad = Buffer.from(WS, "utf8");
    const prompt = cipher.decryptText(
      dek,
      rows[0]!["prompt_envelope"] as never,
      aad,
    );
    expect(prompt).toBe("the prompt");
  }, 30_000);

  it("retries past FK races: body queued before the log row still lands", async () => {
    const store = new PostgresBodyStore(sql, MASTER, silentLogger, {
      flushIntervalMs: 50,
    });
    // No request_logs row yet for req-bodies-2: first flush fails the FK.
    store.store({
      requestId: "req-bodies-2",
      workspaceId: WS,
      promptBody: "p",
      responseBody: null,
      wrappedDek: wrapped,
    });
    await store.flush();
    expect(store.metrics().written).toBe(0);
    expect(store.metrics().failures).toBe(1);
    await insertLogRow("req-bodies-2");
    await store.flush();
    expect(store.metrics().written).toBe(1);
    const rows = await sql`
      SELECT response_envelope FROM request_bodies WHERE request_id = 'req-bodies-2'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["response_envelope"]).toBeNull();
  }, 30_000);

  it("drops after maxAttempts when the log row never appears", async () => {
    const store = new PostgresBodyStore(sql, MASTER, silentLogger, {
      maxAttempts: 2,
    });
    store.store({
      requestId: "req-bodies-missing",
      workspaceId: WS,
      promptBody: "p",
      responseBody: null,
      wrappedDek: wrapped,
    });
    await store.flush();
    await store.flush();
    const m = store.metrics();
    expect(m.dropped).toBe(1);
    expect(m.written).toBe(0);
    expect(m.queueDepth).toBe(0);
  }, 30_000);

  it("evicts oldest when the queue is full (backpressure)", async () => {
    const store = new PostgresBodyStore(sql, MASTER, silentLogger, {
      maxQueueSize: 2,
    });
    for (let i = 0; i < 5; i++) {
      store.store({
        requestId: `req-bodies-evict-${i}`,
        workspaceId: WS,
        promptBody: "p",
        responseBody: null,
        wrappedDek: wrapped,
      });
    }
    expect(store.metrics().queueDepth).toBe(2);
    expect(store.metrics().dropped).toBe(3);
  }, 30_000);

  it("start/stop control the flush timer", async () => {
    const store = new PostgresBodyStore(sql, MASTER, silentLogger, {
      flushIntervalMs: 30,
    });
    store.start();
    store.stop();
    store.stop(); // idempotent
    store.start();
    store.stop();
    expect(store.metrics().queueDepth).toBe(0);
    void pino; // keep import used if logger config changes
  }, 30_000);
});
