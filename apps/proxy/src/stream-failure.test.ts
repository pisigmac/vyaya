import { describe, expect, it, vi } from "vitest";
import { chatRequestBody, eventually, postToProxy, startTestProxy } from "./test-utils.js";

describe("HTTP stream finalization", () => {
  for (const scenario of ["before-chunk", "partial", "usage", "malformed", "cancel"] as const) {
    it(`finalizes exactly once: ${scenario}`, async () => {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const cancelled = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { source = controller; },
        cancel: cancelled,
      });
      const fetchFn = vi.fn(async () => new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
      const proxy = await startTestProxy({
        upstream: { url: "http://unused.invalid", close: async () => {} },
        fetchFn,
      });
      const end = vi.fn();
      proxy.deps.tracer = {
        startSpan: () => ({ setAttribute: vi.fn(), end }),
        shutdown: async () => {},
      };
      try {
        const responsePromise = postToProxy(proxy, "/v1/chat/completions", chatRequestBody({ stream: true }));
        // Observe fetch rejection immediately, including pre-header resets.
        const responseResult = responsePromise.then((response) => response, () => null);
        await eventually(() => vi.mocked(fetchFn).mock.calls.length === 1);
        if (scenario === "before-chunk") {
          source.error(new Error("reset before first chunk"));
          const response = await responseResult;
          if (response) await response.text().catch(() => {});
        } else {
          const payload = scenario === "usage"
            ? 'data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n'
            : scenario === "malformed" ? 'data: {broken}\n\n' : 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
          source.enqueue(new TextEncoder().encode(payload));
          const response = await responseResult;
          expect(response).not.toBeNull();
          const reader = response!.body!.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toBe(payload);
          if (scenario === "cancel") {
            await reader.cancel();
            await eventually(() => cancelled.mock.calls.length === 1);
          } else if (scenario === "malformed") {
            source.close();
            expect((await reader.read()).done).toBe(true);
          } else {
            source.error(new Error("reset after partial data"));
            await expect(reader.read()).rejects.toThrow();
          }
        }
        await eventually(() => proxy.sink.logs.length === 1 && end.mock.calls.length === 1);
        const log = proxy.sink.logs[0]!;
        expect(log.status).toBe(scenario === "cancel" ? "client_disconnect" : scenario === "malformed" ? "success" : "error");
        if (scenario !== "malformed") {
          expect(log.promptTokens).toBe(scenario === "usage" ? 11 : 0);
          expect(log.completionTokens).toBe(scenario === "usage" ? 2 : 0);
          expect(log.responseConsumed).toBe(false);
        }
        expect(proxy.sink.writes).toBe(1);
        expect(end).toHaveBeenCalledTimes(1);
      } finally {
        await proxy.close();
      }
    });
  }
});
