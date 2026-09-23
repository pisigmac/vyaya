import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProxyEnv } from "@vyaya/config";
import { EnvelopeCipher } from "@vyaya/core";
import {
  generateApiKey,
  hashApiKey,
  runMigrations,
} from "@vyaya/db";
import { startEmbeddedPostgres } from "@vyaya/db/test-support/embedded-pg";
import postgres from "postgres";
import { createProxyApp } from "./app.js";
import { buildProxyRuntime, type ProxyRuntime } from "./deps.js";
import {
  chatRequestBody,
  startMockUpstream,
  type RunningServer,
} from "./test-utils.js";

/**
 * End-to-end write path against a real (embedded, user-space) Postgres 16:
 * migrations -> workspace/key rows -> proxy request -> request_logs row,
 * plus the encrypted request_bodies path under LOG_BODIES opt-in.
 */

const MASTER_KEY_HEX = "ab".repeat(32);
const WS_A = "00000000-0000-4000-a000-00000000e001";
const WS_B = "00000000-0000-4000-a000-00000000e002"; // body-logging opt-in

describe("proxy <-> postgres integration", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
  let upstream: RunningServer;
  let runtime: ProxyRuntime;
  let proxyUrl: string;
  let closeProxy: () => Promise<void>;
  let keyA: string;
  let keyB: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    pg = await startEmbeddedPostgres();
    await runMigrations(pg.url);
    sql = postgres(pg.url, { max: 4 });

    const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER_KEY_HEX));
    const dek = EnvelopeCipher.generateDek();
    const wrapped = cipher.wrapDek(dek);

    keyA = generateApiKey().plaintext;
    keyB = generateApiKey().plaintext;
    await sql`INSERT INTO workspaces (id, name, slug) VALUES
      (${WS_A}, 'Integration A', 'integration-a')`;
    await sql.unsafe(
      `INSERT INTO workspaces (id, name, slug, log_bodies_enabled, wrapped_dek)
       VALUES ($1, 'Integration B', 'integration-b', true, $2::jsonb)`,
      [WS_B, JSON.stringify(wrapped)],
      { prepare: false },
    );
    await sql`INSERT INTO api_keys (workspace_id, name, key_hash, last4) VALUES
      (${WS_A}, 'main', ${await hashApiKey(keyA)}, ${keyA.slice(-4)})`;
    await sql`INSERT INTO api_keys (workspace_id, name, key_hash, last4) VALUES
      (${WS_B}, 'main', ${await hashApiKey(keyB)}, ${keyB.slice(-4)})`;
    await sql`INSERT INTO feature_tag_allowlist (workspace_id, tag) VALUES
      (${WS_A}, 'chat')`;

    upstream = await startMockUpstream();
    const env = loadProxyEnv({
      NODE_ENV: "test",
      DATABASE_URL: pg.url,
      DESKID_ISSUER: "http://localhost:8091",
      DESKID_JWKS_URL: "http://localhost:8091/.well-known/jwks.json",
      MASTER_ENCRYPTION_KEY: MASTER_KEY_HEX,
      LOG_BODIES: "true",
      OPENAI_BASE_URL: upstream.url,
      RATE_LIMIT_REQUESTS_PER_MINUTE: "10000",
    });
    runtime = await buildProxyRuntime(env);
    const app = createProxyApp(runtime.deps);
    const { startHttpServer } = await import("./test-utils.js");
    const server = await startHttpServer(app.fetch);
    proxyUrl = server.url;
    closeProxy = server.close;
  }, 120_000);

  afterAll(async () => {
    await closeProxy();
    await runtime.close();
    await upstream.close();
    await sql.end();
    await pg.stop();
  }, 60_000);

  it("writes a full request_logs row through the retry queue", async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vyaya-key": keyA,
        "x-vyaya-session": "sess-pg",
        "x-vyaya-tag": "chat",
        "x-vyaya-retry-attempt": "1",
        "x-vyaya-retry-of": "req-first-attempt",
        "x-vyaya-request-id": "req-pg-1",
      },
      body: JSON.stringify(chatRequestBody()),
    });
    expect(res.status).toBe(200);
    await res.text();

    await eventuallySync(async () => {
      const rows = await sql`
        SELECT * FROM request_logs WHERE request_id = 'req-pg-1'`;
      return rows.length === 1;
    });
    const rows = await sql`SELECT * FROM request_logs WHERE request_id = 'req-pg-1'`;
    const row = rows[0]!;
    expect(row["workspace_id"]).toBe(WS_A);
    expect(row["model"]).toBe("gpt-4o-mini");
    expect(row["session_id"]).toBe("sess-pg");
    expect(row["feature_tag"]).toBe("chat");
    expect(row["retry_attempt"]).toBe(1);
    expect(row["retry_of"]).toBe("req-first-attempt");
    expect(Number(row["prompt_tokens"])).toBeGreaterThan(0);
    expect(Number(row["cost_usd"])).toBeGreaterThan(0);
    expect(row["status"]).toBe("success");
    // No body opt-in on workspace A: no request_bodies row.
    const bodies = await sql`
      SELECT * FROM request_bodies WHERE request_id = 'req-pg-1'`;
    expect(bodies).toHaveLength(0);
  }, 30_000);

  it("rejected feature tag is logged as null", async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vyaya-key": keyA,
        "x-vyaya-tag": "nope",
        "x-vyaya-request-id": "req-pg-2",
      },
      body: JSON.stringify(chatRequestBody()),
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventuallySync(async () => {
      const rows = await sql`
        SELECT feature_tag FROM request_logs WHERE request_id = 'req-pg-2'`;
      return rows.length === 1 && rows[0]!["feature_tag"] === null;
    });
  }, 30_000);

  it("encrypted bodies land for opt-in workspaces and decrypt", async () => {
    const promptBody = JSON.stringify(chatRequestBody());
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vyaya-key": keyB,
        "x-vyaya-request-id": "req-pg-3",
      },
      body: promptBody,
    });
    expect(res.status).toBe(200);
    const responseText = await res.text();

    await eventuallySync(async () => {
      const rows = await sql`
        SELECT * FROM request_bodies WHERE request_id = 'req-pg-3'`;
      return rows.length === 1;
    }, 15_000);
    const rows = await sql`
      SELECT * FROM request_bodies WHERE request_id = 'req-pg-3'`;
    const row = rows[0]!;
    expect(row["workspace_id"]).toBe(WS_B);
    expect(row["prompt_bytes"]).toBe(Buffer.byteLength(promptBody));

    // Round-trip: unwrap the workspace DEK, decrypt the envelopes.
    const wsRows = await sql`
      SELECT wrapped_dek FROM workspaces WHERE id = ${WS_B}`;
    const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER_KEY_HEX));
    const dek = cipher.unwrapDek(asJson<import("@vyaya/core").WrappedDek>(wsRows[0]!["wrapped_dek"]));
    const aad = Buffer.from(WS_B, "utf8");
    const prompt = cipher.decryptText(
      dek,
      asJson<import("@vyaya/core").EncryptedPayload>(row["prompt_envelope"]),
      aad,
    );
    expect(prompt).toBe(promptBody);
    const response = cipher.decryptText(
      dek,
      asJson<import("@vyaya/core").EncryptedPayload>(row["response_envelope"]),
      aad,
    );
    expect(response).toBe(responseText);
    expect(response).not.toContain(MASTER_KEY_HEX);
  }, 30_000);

  it("drizzle-typed readback: retry_attempt column matches", async () => {
    const rows = await sql`
      SELECT retry_attempt, retry_of FROM request_logs WHERE request_id = 'req-pg-1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["retry_attempt"]).toBe(1);
    expect(rows[0]!["retry_of"]).toBe("req-first-attempt");
  }, 30_000);
});

/** jsonb readback can be text depending on the write path; normalize. */
function asJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** eventually() variant taking an async condition. */async function eventuallySync(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 50));
  }
}
