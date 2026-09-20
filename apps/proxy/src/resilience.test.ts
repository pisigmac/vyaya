import { describe, expect, it } from "vitest";
import { RetryQueueLogSink } from "@vyaya/core";
import {
  chatRequestBody,
  CollectingSink,
  eventually,
  postToProxy,
  startMockUpstream,
  startTestProxy,
} from "./test-utils.js";

/**
 * CRITICAL resilience contract: the logging backend being DOWN must not
 * affect proxied requests — responses stay 200 and added latency stays
 * under 10ms p95 versus calling the mock upstream directly.
 */

const REQUESTS = 200;
const CONCURRENCY = 8;
const MOCK_LATENCY_MS = 50;

interface TimedTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * Interleaved measurement: direct and proxied requests alternate inside
 * the same worker pool so any event-loop/CPU noise hits both sides
 * symmetrically. Comparing p95(proxy) - p95(direct) then isolates the
 * proxy's added latency.
 */
async function timedInterleaved(
  a: TimedTarget,
  b: TimedTarget,
  countEach: number,
): Promise<{ a: number[]; b: number[] }> {
  const durationsA: number[] = [];
  const durationsB: number[] = [];
  let next = 0;
  const total = countEach * 2;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= total) return;
      const target = i % 2 === 0 ? a : b;
      const start = performance.now();
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mock-latency-ms": String(MOCK_LATENCY_MS),
          ...target.headers,
        },
        body: JSON.stringify(chatRequestBody()),
      });
      if (res.status !== 200) {
        throw new Error(`expected 200, got ${res.status}`);
      }
      await res.text();
      (i % 2 === 0 ? durationsA : durationsB).push(performance.now() - start);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { a: durationsA, b: durationsB };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function p95(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 95);
}

describe("resilience: logging backend DOWN", () => {
  it("responses stay 200 and p95 added latency < 10ms over 200 requests", async () => {
    const upstream = await startMockUpstream();
    const failingSink = new CollectingSink();
    failingSink.failing = true;
    const queue = new RetryQueueLogSink(failingSink, {
      flushIntervalMs: 25,
      maxWriteAttempts: 2,
      maxBatchSize: 500,
    });
    queue.start();
    const proxy = await startTestProxy({
      upstream,
      sink: queue,
      queueMetrics: () => queue.metrics(),
    });
    try {
      // Warm the auth cache, JIT, and socket pools: 10 requests each side.
      for (let i = 0; i < 10; i++) {
        const warm = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
        expect(warm.status).toBe(200);
        await warm.text();
        const warmDirect = await fetch(`${upstream.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chatRequestBody()),
        });
        await warmDirect.text();
      }

      const { a: baseline, b: proxied } = await timedInterleaved(
        { url: `${upstream.url}/v1/chat/completions`, headers: {} },
        {
          url: `${proxy.url}/v1/chat/completions`,
          headers: { "x-vyaya-key": proxy.apiKey },
        },
        REQUESTS,
      );

      expect(proxied).toHaveLength(REQUESTS);
      expect(baseline).toHaveLength(REQUESTS);
      const p95Baseline = p95(baseline);
      const p95Proxy = p95(proxied);
      // Interleaved pair deltas cancel common-mode load spikes (GC, CPU
      // contention from sibling test workers): delta_i = proxy_i - direct_i.
      const deltas = proxied.map((d, i) => d - (baseline[i] ?? 0));
      const added = p95(deltas);
      console.log(
        JSON.stringify({
          p95BaselineMs: Number(p95Baseline.toFixed(2)),
          p95ProxyMs: Number(p95Proxy.toFixed(2)),
          p95AddedMs: Number(added.toFixed(2)),
          p95DiffOfP95Ms: Number((p95Proxy - p95Baseline).toFixed(2)),
        }),
      );
      expect(added).toBeLessThan(10);

      // The backend really was failing the whole time.
      await eventually(() => queue.metrics().writeFailures > 0);
      const metrics = queue.metrics();
      expect(metrics.written).toBe(0);
      expect(metrics.writeFailures).toBeGreaterThan(0);
    } finally {
      queue.stop();
      await proxy.close();
      await upstream.close();
    }
  }, 120_000);

  it("backpressure: full queue drops oldest, responses unaffected", async () => {
    const upstream = await startMockUpstream();
    const failingSink = new CollectingSink();
    failingSink.failing = true;
    const queue = new RetryQueueLogSink(failingSink, {
      flushIntervalMs: 60_000, // never flushes during the test
      maxQueueSize: 5,
    });
    queue.start();
    const proxy = await startTestProxy({
      upstream,
      sink: queue,
      queueMetrics: () => queue.metrics(),
    });
    try {
      for (let i = 0; i < 20; i++) {
        const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
        expect(res.status).toBe(200);
        await res.text();
      }
      await eventually(() => queue.metrics().droppedBackpressure > 0);
      const metrics = queue.metrics();
      expect(metrics.enqueued).toBe(20);
      expect(metrics.droppedBackpressure).toBe(15);
      expect(metrics.queueDepth).toBe(5);
    } finally {
      queue.stop();
      await proxy.close();
      await upstream.close();
    }
  }, 60_000);

  it("backend recovery: queued logs flush once the sink is healthy", async () => {
    const upstream = await startMockUpstream();
    const sink = new CollectingSink();
    sink.failing = true;
    const queue = new RetryQueueLogSink(sink, {
      flushIntervalMs: 25,
      maxWriteAttempts: 10,
    });
    queue.start();
    const proxy = await startTestProxy({
      upstream,
      sink: queue,
      queueMetrics: () => queue.metrics(),
    });
    try {
      const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
      expect(res.status).toBe(200);
      await res.text();
      await eventually(() => queue.metrics().writeFailures > 0);
      sink.failing = false;
      await eventually(() => sink.logs.length === 1);
      expect(sink.logs[0]!.model).toBe("gpt-4o-mini");
    } finally {
      queue.stop();
      await proxy.close();
      await upstream.close();
    }
  }, 60_000);
});
