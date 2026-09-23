import { describe, expect, it } from "vitest";
import type { RequestLog } from "../types.js";
import { PostgresLogSink, type SqlQueryFn } from "./postgres.js";
import { ClickHouseLogSink } from "./clickhouse.js";
import { RetryQueueLogSink } from "./retry-queue.js";
import { LogSinkWriteError, type LogSink } from "./interface.js";

function makeLog(requestId: string): RequestLog {
  return {
    requestId,
    workspaceId: "ws-1",
    occurredAtMs: 1_700_000_000_000,
    model: "gpt-4o",
    endpoint: "/v1/chat/completions",
    latencyMs: 123,
    promptTokens: 100,
    completionTokens: 40,
    maxTokens: 500,
    costUsd: 0.00165,
    inputCostUsd: 0.00025,
    outputCostUsd: 0.0014,
    promptHash: "f".repeat(64),
    sessionId: "sess-1",
    featureTag: "support-bot",
    status: "success",
    schemaValidation: "passed",
    retryAttempt: 0,
    retryOf: null,
    responseConsumed: true,
    promptText: null,
  };
}

describe("PostgresLogSink", () => {
  it("writes a parameterized INSERT with all log fields", async () => {
    const calls: { text: string; params: readonly unknown[] }[] = [];
    const query: SqlQueryFn = async (text, params) => {
      calls.push({ text, params });
    };
    const sink = new PostgresLogSink({ query });
    await sink.write(makeLog("req-1"));
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toContain("INSERT INTO request_logs");
    expect(text).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(text).toMatch(/\$20/);
    expect(params[0]).toBe("req-1");
    expect(params[1]).toBe("ws-1");
    expect(params[2]).toBe(new Date(1_700_000_000_000).toISOString());
    expect(params).toHaveLength(20);
    // retry metadata columns ride along (retry_attempt, retry_of).
    expect(params[17]).toBe(0);
    expect(params[18]).toBeNull();
  });

  it("stays healthy across successful writes", async () => {
    const sink = new PostgresLogSink({ query: async () => {} });
    await sink.write(makeLog("a"));
    expect(sink.healthy()).toBe(true);
  });

  it("goes unhealthy after consecutive failures and recovers on success", async () => {
    let fail = true;
    const query: SqlQueryFn = async () => {
      if (fail) throw new Error("db down");
    };
    const sink = new PostgresLogSink({ query, maxConsecutiveFailures: 2 });
    await expect(sink.write(makeLog("a"))).rejects.toBeInstanceOf(
      LogSinkWriteError,
    );
    expect(sink.healthy()).toBe(true);
    await expect(sink.write(makeLog("b"))).rejects.toBeInstanceOf(
      LogSinkWriteError,
    );
    expect(sink.healthy()).toBe(false);
    fail = false;
    await sink.write(makeLog("c"));
    expect(sink.healthy()).toBe(true);
  });

  it("rejects unsafe table identifiers", () => {
    expect(
      () => new PostgresLogSink({ query: async () => {}, table: "x; DROP TABLE y" }),
    ).toThrow();
  });
});

describe("ClickHouseLogSink", () => {
  function fakeFetch(status = 200) {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(null, { status });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it("POSTs a JSONEachRow insert", async () => {
    const { fetchFn, calls } = fakeFetch();
    const sink = new ClickHouseLogSink({
      url: "http://localhost:8123",
      fetchFn,
    });
    await sink.write(makeLog("req-ch"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("http://localhost:8123/?query=");
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "INSERT INTO vyaya.request_logs FORMAT JSONEachRow",
    );
    const row = JSON.parse(calls[0]!.body.trim()) as Record<string, unknown>;
    expect(row["request_id"]).toBe("req-ch");
    expect(row["response_consumed"]).toBe(1);
    expect(sink.healthy()).toBe(true);
  });

  it("throws LogSinkWriteError on non-2xx and flips unhealthy", async () => {
    const { fetchFn } = fakeFetch(500);
    const sink = new ClickHouseLogSink({
      url: "http://localhost:8123",
      fetchFn,
      maxConsecutiveFailures: 1,
    });
    await expect(sink.write(makeLog("x"))).rejects.toBeInstanceOf(
      LogSinkWriteError,
    );
    expect(sink.healthy()).toBe(false);
  });

  it("rejects unsafe database/table identifiers", () => {
    expect(
      () =>
        new ClickHouseLogSink({
          url: "http://localhost:8123",
          table: "logs FORMAT Native",
        }),
    ).toThrow();
  });
});

describe("RetryQueueLogSink", () => {
  function collectingSink(failTimes = 0) {
    const written: string[] = [];
    let failuresLeft = failTimes;
    const sink: LogSink = {
      write: async (log) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("sink down");
        }
        written.push(log.requestId);
      },
      healthy: () => failuresLeft === 0,
    };
    return { sink, written };
  }

  it("flushes queued logs to the inner sink", async () => {
    const { sink, written } = collectingSink();
    const queue = new RetryQueueLogSink(sink);
    await queue.write(makeLog("a"));
    await queue.write(makeLog("b"));
    await queue.flush();
    expect(written).toEqual(["a", "b"]);
    expect(queue.metrics().written).toBe(2);
    expect(queue.metrics().queueDepth).toBe(0);
  });

  it("write() never rejects, even when the inner sink is down", async () => {
    const { sink } = collectingSink(999);
    const queue = new RetryQueueLogSink(sink);
    await expect(queue.write(makeLog("a"))).resolves.toBeUndefined();
    await queue.flush();
    const m = queue.metrics();
    expect(m.writeFailures).toBe(1);
    expect(m.queueDepth).toBe(1); // requeued for retry
  });

  it("retries then drops after maxWriteAttempts", async () => {
    const { sink } = collectingSink(999);
    const queue = new RetryQueueLogSink(sink, { maxWriteAttempts: 2 });
    await queue.write(makeLog("a"));
    await queue.flush(); // attempt 1 fails, requeue
    await queue.flush(); // attempt 2 fails, drop
    const m = queue.metrics();
    expect(m.writeFailures).toBe(2);
    expect(m.droppedExhausted).toBe(1);
    expect(m.queueDepth).toBe(0);
  });

  it("drops the oldest entry under backpressure and counts it", async () => {
    const { sink, written } = collectingSink();
    const queue = new RetryQueueLogSink(sink, { maxQueueSize: 2 });
    await queue.write(makeLog("old"));
    await queue.write(makeLog("mid"));
    await queue.write(makeLog("new")); // drops "old"
    const m = queue.metrics();
    expect(m.droppedBackpressure).toBe(1);
    expect(m.queueDepth).toBe(2);
    await queue.flush();
    expect(written).toEqual(["mid", "new"]);
  });

  it("always reports healthy (proxy health is independent)", async () => {
    const { sink } = collectingSink(999);
    const queue = new RetryQueueLogSink(sink);
    await queue.write(makeLog("a"));
    await queue.flush();
    expect(queue.healthy()).toBe(true);
  });

  it("start()/stop() manage the flush loop without leaking timers", async () => {
    const { sink, written } = collectingSink();
    const queue = new RetryQueueLogSink(sink, { flushIntervalMs: 5 });
    queue.start();
    await queue.write(makeLog("bg"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    queue.stop();
    expect(written).toContain("bg");
  });

  it("rejects maxQueueSize < 1", () => {
    const { sink } = collectingSink();
    expect(() => new RetryQueueLogSink(sink, { maxQueueSize: 0 })).toThrow();
  });
});
