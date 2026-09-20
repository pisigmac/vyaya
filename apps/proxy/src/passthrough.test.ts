import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCost, normalizeChatMessages, promptHashHex } from "@vyaya/core";
import {
  chatRequestBody,
  eventually,
  postToProxy,
  startMockUpstream,
  startTestProxy,
  type RunningServer,
  type TestProxy,
} from "./test-utils.js";

/**
 * Passthrough correctness: buffered and streaming responses must arrive
 * byte-identical to a direct mock-upstream call, with observability logged
 * after the fact.
 */

describe("proxy passthrough", () => {
  let upstream: RunningServer;
  let proxy: TestProxy;

  beforeEach(async () => {
    upstream = await startMockUpstream();
    proxy = await startTestProxy({ upstream });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close().catch(() => {});
  });

  it("buffered chat: byte-identical body, usage + cost + hash logged", async () => {
    const body = chatRequestBody();
    const [direct, viaProxy] = await Promise.all([
      fetch(`${upstream.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      postToProxy(proxy, "/v1/chat/completions", body),
    ]);
    expect(viaProxy.status).toBe(200);
    const directText = await direct.text();
    const proxyText = await viaProxy.text();
    expect(proxyText).toBe(directText);
    expect(viaProxy.headers.get("x-vyaya-request-id")).toBeTruthy();

    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    const usage = (JSON.parse(directText) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    }).usage;
    expect(log.model).toBe("gpt-4o-mini");
    expect(log.endpoint).toBe("/v1/chat/completions");
    expect(log.status).toBe("success");
    expect(log.promptTokens).toBe(usage.prompt_tokens);
    expect(log.completionTokens).toBe(usage.completion_tokens);
    expect(log.promptHash).toBe(
      promptHashHex(
        normalizeChatMessages(
          body.messages as { role: string; content: unknown }[],
        ),
      ),
    );
    expect(log.workspaceId).toBeTruthy();
    const expected = computeCost({
      model: "gpt-4o-mini",
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    });
    expect(log.costUsd).toBe(expected.totalCostUsd);
    expect(log.inputCostUsd).toBe(expected.inputCostUsd);
    expect(log.outputCostUsd).toBe(expected.outputCostUsd);
    expect(log.schemaValidation).toBe("not_requested");
    expect(log.responseConsumed).toBe(true);
    expect(log.retryAttempt).toBe(0);
    expect(log.retryOf).toBeNull();
    expect(log.maxTokens).toBeNull();
  });

  it("streaming chat (SSE): byte-identical stream, usage tapped", async () => {
    const body = chatRequestBody({
      stream: true,
      stream_options: { include_usage: true },
    });
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    const direct = await fetch(`${upstream.url}/v1/chat/completions`, init);
    const viaProxy = await postToProxy(proxy, "/v1/chat/completions", body);
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.headers.get("content-type")).toContain("text/event-stream");
    const directText = await direct.text();
    const proxyText = await viaProxy.text();
    expect(proxyText).toBe(directText);
    expect(proxyText).toContain("data: [DONE]");

    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    // The mock guarantees stream usage == buffered usage for identical
    // input, so a direct buffered call gives the expected numbers.
    const buffered = await fetch(`${upstream.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequestBody()),
    });
    const expected = (await buffered.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(log.promptTokens).toBe(expected.usage.prompt_tokens);
    expect(log.completionTokens).toBe(expected.usage.completion_tokens);
    expect(log.completionTokens).toBeGreaterThan(0);
    expect(log.status).toBe("success");
  });

  it("streaming without include_usage still logs (estimated tokens)", async () => {
    const body = chatRequestBody({ stream: true });
    const res = await postToProxy(proxy, "/v1/chat/completions", body);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    expect(log.promptTokens).toBeGreaterThan(0);
    expect(log.completionTokens).toBeGreaterThan(0);
  });

  it("embeddings passthrough with usage and priced cost", async () => {
    const body = { model: "text-embedding-3-small", input: ["hello", "world"] };
    const [direct, viaProxy] = await Promise.all([
      fetch(`${upstream.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      postToProxy(proxy, "/v1/embeddings", body),
    ]);
    expect(viaProxy.status).toBe(200);
    expect(await viaProxy.text()).toBe(await direct.text());
    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    expect(log.endpoint).toBe("/v1/embeddings");
    expect(log.promptTokens).toBeGreaterThan(0);
    expect(log.completionTokens).toBe(0);
    expect(log.costUsd).toBeGreaterThan(0);
  });

  it("cost is computed from the price table, never from the client", async () => {
    const body = chatRequestBody({ cost_usd: 999.99, price_override: "1" });
    const res = await postToProxy(proxy, "/v1/chat/completions", body, {
      "x-client-cost": "999.99",
      "x-vyaya-cost": "999.99",
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    const expected = computeCost({
      model: "gpt-4o-mini",
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
    });
    expect(log.costUsd).toBe(expected.totalCostUsd);
    expect(log.costUsd).toBeLessThan(1);
  });

  it("logs vyaya headers: session, tag, retry metadata, consumed signal", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-session": "sess-42",
      "x-vyaya-tag": "anything-allowed",
      "x-vyaya-retry-attempt": "2",
      "x-vyaya-retry-of": "req-original",
      "x-vyaya-consumed": "false",
      "x-vyaya-request-id": "req-client-1",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vyaya-request-id")).toBe("req-client-1");
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    expect(log.requestId).toBe("req-client-1");
    expect(log.sessionId).toBe("sess-42");
    expect(log.featureTag).toBe("anything-allowed");
    expect(log.retryAttempt).toBe(2);
    expect(log.retryOf).toBe("req-original");
    expect(log.responseConsumed).toBe(false);
  });

  it("upstream failures pass through with status and get logged as error", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-mock-fail": "500",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("injected failure");
    await eventually(() => proxy.sink.logs.length === 1);
    const log = proxy.sink.logs[0]!;
    expect(log.status).toBe("error");
    expect(log.promptTokens).toBe(0);
    expect(log.costUsd).toBe(0);
  });

  it("unreachable upstream returns 502 and is logged", async () => {
    await upstream.close();
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.status).toBe("error");
  });

  it("healthz reports ok with queue metrics", async () => {
    const res = await fetch(`${proxy.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; queue: { enqueued: number } };
    expect(body.status).toBe("ok");
    expect(body.queue.enqueued).toBeTypeOf("number");
  });
});

describe("proxy auth (HTTP)", () => {
  let upstream: RunningServer;
  let proxy: TestProxy;

  beforeEach(async () => {
    upstream = await startMockUpstream();
    proxy = await startTestProxy({ upstream });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("missing key -> 401 missing_api_key", async () => {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequestBody()),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_api_key");
  });

  it("malformed key -> 401", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-key": "garbage",
    });
    expect(res.status).toBe(401);
  });

  it("unknown but well-formed key -> 401", async () => {
    const other = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-key": `vy_live_${"1".repeat(64)}`,
    });
    expect(other.status).toBe(401);
    const body = (await other.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("revoked key -> 401", async () => {
    const { ApiKeyAuthenticator } = await import("./auth.js");
    const revokedProxy = await startTestProxy({
      upstream,
      authStore: proxy.authStore,
      authenticator: new ApiKeyAuthenticator(proxy.authStore.revokedStore()),
    });
    try {
      const res = await postToProxy(revokedProxy, "/v1/chat/completions", chatRequestBody());
      expect(res.status).toBe(401);
    } finally {
      await revokedProxy.close();
    }
  });

  it("valid key -> 200", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
    expect(res.status).toBe(200);
    await res.text();
  });

  it("auth backend down + cold cache -> 503", async () => {
    proxy.authStore.failNext = true;
    const freshKey = `vy_live_${"2".repeat(64)}`;
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-key": freshKey,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_unavailable");
  });
});

describe("proxy rate limit (HTTP)", () => {
  it("burst past the limit -> 429 with Retry-After; window slides", async () => {
    const upstream = await startMockUpstream();
    let now = Date.now();
    const { InMemorySlidingWindowRateLimiter } = await import("./rate-limit.js");
    const limiter = new InMemorySlidingWindowRateLimiter({
      limit: 3,
      windowMs: 400,
      now: () => now,
      sweepIntervalMs: 0,
    });
    const proxy = await startTestProxy({ upstream, rateLimiter: limiter });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
        expect(res.status).toBe(200);
        await res.text();
      }
      const denied = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
      expect(denied.status).toBe(429);
      const retryAfter = Number(denied.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      const body = (await denied.json()) as { error: { type: string } };
      expect(body.error.type).toBe("rate_limit_error");

      now += 500; // window slides
      const allowed = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody());
      expect(allowed.status).toBe(200);
      await allowed.text();
    } finally {
      await proxy.close();
      await upstream.close();
      await limiter.close();
    }
  });
});
