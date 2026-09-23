import { randomUUID } from "node:crypto";
import { PostgresLogSink, type RequestLog } from "@vyaya/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDb,
  listWorkspaceIds,
  scopedQueryFn,
  withWorkspace,
} from "./client.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";
import {
  startEmbeddedPostgres,
  type EmbeddedPg,
} from "./test-support/embedded-pg.js";

/**
 * Cross-workspace RLS rejection tests. The cluster superuser bypasses RLS,
 * so enforcement is verified through dedicated single-connection clients
 * with SET ROLE vyaya_app / vyaya_service (the exact roles production
 * services connect as).
 */

const WS_A = randomUUID();
const WS_B = randomUUID();

function makeLog(requestId: string, workspaceId: string): RequestLog {
  return {
    requestId,
    workspaceId,
    occurredAtMs: 1_700_000_000_000,
    model: "gpt-4o-mini",
    endpoint: "/v1/chat/completions",
    latencyMs: 120,
    promptTokens: 100,
    completionTokens: 50,
    maxTokens: null,
    costUsd: 0.000045,
    inputCostUsd: 0.000015,
    outputCostUsd: 0.00003,
    promptHash: "a".repeat(64),
    sessionId: null,
    featureTag: null,
    status: "success",
    schemaValidation: "not_requested",
    retryAttempt: 0,
    retryOf: null,
    responseConsumed: true,
    promptText: null,
  };
}

describe("RLS cross-workspace isolation", () => {
  let cluster: EmbeddedPg;
  // Single-connection clients with a fixed role each.
  let appSql: postgres.Sql;
  let serviceSql: postgres.Sql;
  let suSql: postgres.Sql;
  const appDb = () => drizzle(appSql, { schema });

  beforeAll(async () => {
    cluster = await startEmbeddedPostgres();
    await runMigrations(cluster.url);

    // Seed one workspace + one request_log each, via the scoped helper
    // (also proves the helper works for bootstrap: the workspaces row is
    // inserted while the GUC names its own new id).
    const handle = createDb({ databaseUrl: cluster.url, maxConnections: 2 });
    try {
      for (const [id, slug] of [
        [WS_A, "ws-a"],
        [WS_B, "ws-b"],
      ] as const) {
        await withWorkspace(handle, id, async (tx) => {
          await tx
            .insert(schema.workspaces)
            .values({ id, name: slug, slug });
          await tx.insert(schema.requestLogs).values({
            requestId: `rls-${slug}`,
            workspaceId: id,
            occurredAt: new Date(1_700_000_000_000),
            model: "gpt-4o-mini",
            endpoint: "/v1/chat/completions",
            latencyMs: 100,
            promptTokens: 10,
            completionTokens: 5,
            costUsd: 0.000001,
            inputCostUsd: 0.000001,
            outputCostUsd: 0.000001,
            promptHash: "b".repeat(64),
            status: "success",
            schemaValidation: "not_requested",
          });
        });
      }
    } finally {
      await closeDb(handle);
    }

    appSql = postgres(cluster.url, { max: 1, onnotice: () => {} });
    await appSql`SET ROLE vyaya_app`;
    serviceSql = postgres(cluster.url, { max: 1, onnotice: () => {} });
    await serviceSql`SET ROLE vyaya_service`;
    suSql = postgres(cluster.url, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await appSql?.end({ timeout: 5 });
    await serviceSql?.end({ timeout: 5 });
    await suSql?.end({ timeout: 5 });
    await cluster?.stop();
  });

  it("workspace A can read its own rows through withWorkspace", async () => {
    const rows = await withWorkspace(appDb(), WS_A, (tx) =>
      tx.select().from(schema.requestLogs),
    );
    expect(rows.map((r) => r.requestId)).toEqual(["rls-ws-a"]);
  });

  it("workspace A cannot SELECT workspace B rows", async () => {
    const visible = await withWorkspace(appDb(), WS_A, (tx) =>
      tx.select({ requestId: schema.requestLogs.requestId }).from(schema.requestLogs),
    );
    expect(visible.some((r) => r.requestId === "rls-ws-b")).toBe(false);

    // Direct SQL, explicit SET LOCAL — the raw policy behavior.
    const count = await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WS_A}, true)`;
      const rows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM request_logs WHERE workspace_id = ${WS_B}`;
      return rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("workspace A cannot INSERT workspace B rows (WITH CHECK violation)", async () => {
    const attempt = appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WS_A}, true)`;
      await tx`
        INSERT INTO request_logs (
          request_id, workspace_id, occurred_at, model, endpoint, latency_ms,
          prompt_tokens, completion_tokens, cost_usd, input_cost_usd,
          output_cost_usd, prompt_hash, status, schema_validation
        ) VALUES (
          'rls-evil', ${WS_B}, now(), 'gpt-4o-mini', '/v1/chat/completions', 1,
          1, 1, 0.1, 0.05, 0.05, ${"c".repeat(64)}, 'success', 'not_requested'
        )`;
    });
    await expect(attempt).rejects.toThrow(/row-level security/i);
  });

  it("workspace A cannot UPDATE or DELETE workspace B rows", async () => {
    const [updated, deleted] = await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WS_A}, true)`;
      const u = await tx`
        UPDATE request_logs SET feature_tag = 'tampered'
        WHERE workspace_id = ${WS_B}`;
      const d = await tx`DELETE FROM request_logs WHERE workspace_id = ${WS_B}`;
      return [u.count, d.count] as const;
    });
    expect(updated).toBe(0);
    expect(deleted).toBe(0);

    // And B's row is intact (checked as the bypassing superuser).
    const check = await suSql`
      SELECT feature_tag FROM request_logs WHERE request_id = 'rls-ws-b'`;
    expect(check[0]?.feature_tag).toBeNull();
  });

  it("sees nothing at all when app.workspace_id is unset (default deny)", async () => {
    const rows = await appSql`SELECT count(*)::text AS count FROM request_logs`;
    expect(rows[0]?.count).toBe("0");
  });

  it("vyaya_app cannot enumerate the workspaces table", async () => {
    const rows = await appSql`SELECT count(*)::text AS count FROM workspaces`;
    expect(rows[0]?.count).toBe("0");
  });

  it("vyaya_service enumerates workspaces but tenant rows still need the GUC", async () => {
    // The worker's discovery path: list tenants, then scope per workspace.
    const serviceDb = drizzle(serviceSql, { schema });
    const ids = await listWorkspaceIds(serviceDb);
    expect(ids.sort()).toEqual([WS_A, WS_B].sort());

    const unscoped = await serviceSql`
      SELECT count(*)::text AS count FROM request_logs`;
    expect(unscoped[0]?.count).toBe("0");

    const scopedB = await withWorkspace(serviceDb, WS_B, (tx) =>
      tx.select({ requestId: schema.requestLogs.requestId }).from(schema.requestLogs),
    );
    expect(scopedB.map((r) => r.requestId)).toEqual(["rls-ws-b"]);
  });

  it("PostgresLogSink writes through the scoped query fn, idempotently", async () => {
    const sink = new PostgresLogSink({ query: scopedQueryFn(appSql, WS_A) });
    const log = makeLog("rls-sink-1", WS_A);
    await sink.write(log);
    await sink.write(log); // replay — ON CONFLICT (request_id) DO NOTHING
    expect(sink.healthy()).toBe(true);

    const rows = await withWorkspace(appDb(), WS_A, (tx) =>
      tx
        .select({ requestId: schema.requestLogs.requestId })
        .from(schema.requestLogs),
    );
    expect(rows.filter((r) => r.requestId === "rls-sink-1")).toHaveLength(1);
  });

  it("PostgresLogSink cannot write into another workspace", async () => {
    const sink = new PostgresLogSink({ query: scopedQueryFn(appSql, WS_A) });
    await expect(sink.write(makeLog("rls-sink-evil", WS_B))).rejects.toThrow(
      /row-level security|insert failed/i,
    );
    expect(sink.healthy()).toBe(true); // one failure stays below the threshold
  });
});
