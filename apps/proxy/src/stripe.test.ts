import { describe, expect, it } from "vitest";
import {
  HttpStripeApi,
  NoopUsageRecorder,
  StubStripeApi,
  StripeUsageRecorder,
} from "./stripe.js";
import { silentLogger } from "./test-utils.js";

describe("stripe usage recording (fire-and-forget)", () => {
  it("records meter event via api + outbox", async () => {
    const api = new StubStripeApi();
    const outbox: { idempotencyKey: string }[] = [];
    const recorder = new StripeUsageRecorder({
      api,
      eventName: "vyaya.llm_tokens",
      insertOutbox: async (row) => {
        outbox.push(row);
      },
      logger: silentLogger,
    });
    recorder.record({
      workspaceId: "ws",
      requestId: "req-1",
      totalTokens: 150,
      atMs: 1_700_000_000_000,
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.eventName).toBe("vyaya.llm_tokens");
    expect(api.calls[0]!.payload["tokens"]).toBe("150");
    expect(api.calls[0]!.timestamp).toBe(1_700_000_000);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.idempotencyKey).toBe("req-1");
    expect(recorder.metrics().recorded).toBe(1);
  });

  it("swallows api + outbox failures", async () => {
    const api: StubStripeApi = new StubStripeApi();
    api.createMeterEvent = () => Promise.reject(new Error("stripe down"));
    const recorder = new StripeUsageRecorder({
      api,
      eventName: "vyaya.llm_tokens",
      insertOutbox: async () => {
        throw new Error("db down");
      },
      logger: silentLogger,
    });
    expect(() =>
      recorder.record({ workspaceId: "ws", requestId: "r", totalTokens: 5, atMs: 0 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(recorder.metrics().failures).toBe(2);
  });

  it("skips zero-token usage", () => {
    const api = new StubStripeApi();
    const recorder = new StripeUsageRecorder({
      api,
      eventName: "e",
      insertOutbox: null,
      logger: silentLogger,
    });
    recorder.record({ workspaceId: "ws", requestId: "r", totalTokens: 0, atMs: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("NoopUsageRecorder is inert", () => {
    expect(() =>
      new NoopUsageRecorder().record(),
    ).not.toThrow();
  });
});

describe("HttpStripeApi", () => {
  it("posts form-encoded meter events with bearer auth", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "mev_1" }), { status: 200 });
    }) as typeof fetch;
    const api = new HttpStripeApi({
      secretKey: "sk_test_123",
      fetchFn,
      baseUrl: "https://stripe.test",
    });
    const out = await api.createMeterEvent({
      eventName: "vyaya.llm_tokens",
      payload: { tokens: "10" },
      timestamp: 123,
    });
    expect(out.id).toBe("mev_1");
    expect(calls[0]!.url).toBe("https://stripe.test/v2/billing/meter_events");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_123");
    const body = String(calls[0]!.init?.body);
    expect(body).toContain("event_name=vyaya.llm_tokens");
    expect(body).toContain("payload%5Btokens%5D=10");
  });

  it("throws on non-2xx", async () => {
    const fetchFn = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    const api = new HttpStripeApi({ secretKey: "sk_test", fetchFn });
    await expect(
      api.createMeterEvent({ eventName: "e", payload: {}, timestamp: 1 }),
    ).rejects.toThrow("HTTP 400");
  });
});
