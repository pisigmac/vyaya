import { describe, expect, it } from "vitest";
import { createNoopTracer, createTracer } from "./otel.js";
import { silentLogger } from "./test-utils.js";

describe("otel tracer", () => {
  it("is a no-op when disabled", async () => {
    const tracer = await createTracer({
      enabled: false,
      otelUrl: "http://localhost:4318",
      logger: silentLogger,
    });
    const span = tracer.startSpan("test", { a: 1 });
    span.setAttribute("b", "c");
    span.end();
    await tracer.shutdown();
  });

  it("is a no-op when enabled without a URL", async () => {
    const tracer = await createTracer({
      enabled: true,
      otelUrl: undefined,
      logger: silentLogger,
    });
    tracer.startSpan("test", {}).end();
    await tracer.shutdown();
  });

  it("initializes the real SDK when enabled (export is lazy/best-effort)", async () => {
    const tracer = await createTracer({
      enabled: true,
      otelUrl: "http://127.0.0.1:1", // nothing listening; export fails later, off-path
      logger: silentLogger,
    });
    const span = tracer.startSpan("proxy /v1/chat/completions", {
      "vyaya.request_id": "req-1",
    });
    span.setAttribute("vyaya.status", "success");
    span.end();
    await tracer.shutdown();
  });
});

describe("noop tracer", () => {
  it("supports the full span lifecycle", async () => {
    const tracer = createNoopTracer();
    const span = tracer.startSpan("x", {});
    span.end();
    await tracer.shutdown();
  });
});
