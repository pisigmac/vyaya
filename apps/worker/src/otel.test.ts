import { describe, expect, it } from "vitest";
import { createNoopTracer, createTracer } from "./otel.js";
import { silentLogger } from "./test-utils.js";

describe("otel tracer", () => {
  it("is a no-op when SENTINEL_ENABLED is off", async () => {
    const tracer = await createTracer({
      enabled: false,
      otelUrl: "http://localhost:4318",
      logger: silentLogger,
    });
    const span = tracer.startSpan("worker.job.run", { "job.name": "classify" });
    span.setAttribute("job.outcome", "ok");
    span.end();
    await tracer.shutdown();
  });

  it("is a no-op when enabled without a URL", async () => {
    const tracer = await createTracer({
      enabled: true,
      otelUrl: undefined,
      logger: silentLogger,
    });
    tracer.startSpan("waste_event.emitted", {}).end();
    await tracer.shutdown();
  });

  it("initializes the real SDK when enabled (export is lazy/best-effort)", async () => {
    const tracer = await createTracer({
      enabled: true,
      otelUrl: "http://127.0.0.1:1", // nothing listening; export fails off-path
      logger: silentLogger,
    });
    const span = tracer.startSpan("waste_event.emitted", {
      "waste.type": "ghost_output",
      "waste.dollars_wasted": 0.5,
    });
    span.end();
    await tracer.shutdown();
  });
});

describe("noop tracer", () => {
  it("supports the full span lifecycle", async () => {
    const tracer = createNoopTracer();
    const span = tracer.startSpan("x", {});
    span.setAttribute("k", "v");
    span.end();
    await tracer.shutdown();
  });
});
