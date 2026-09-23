import { describe, expect, it } from "vitest";
import { OverprovisionedMaxTokensDetector } from "./overprovisioned-max-tokens.js";
import { makeCtx, makeLog } from "./fixtures.js";
import type { RequestLog } from "../types.js";

const detector = new OverprovisionedMaxTokensDetector();

/** Build n calls with the given completion/maxTokens ratio. */
function calls(
  n: number,
  completionTokens: number,
  maxTokens: number | null,
  overrides: Partial<RequestLog> = {},
): RequestLog[] {
  return Array.from({ length: n }, (_, i) =>
    makeLog({
      requestId: `call-${i}`,
      occurredAtMs: 1_000_000 + i * 1_000,
      completionTokens,
      maxTokens,
      outputCostUsd: 0.001,
      ...overrides,
    }),
  );
}

describe("OverprovisionedMaxTokensDetector", () => {
  it("flags 50+ consecutive calls under 30% of max_tokens (happy path)", () => {
    const logs = calls(50, 100, 1_000); // ratio 0.10
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.wasteType).toBe("overprovisioned_max_tokens");
    expect(event.requestIds).toHaveLength(50);
    // per call: excess 900 tokens * (0.001/100) USD/token * 0.1 overhead
    expect(event.dollarsWasted).toBeCloseTo(50 * 900 * 1e-5 * 0.1, 8);
    expect(event.evidence["callCount"]).toBe(50);
    expect(event.evidence["avgCompletionRatio"]).toBeCloseTo(0.1, 6);
    expect(event.detectorVersion).toBe("1.0.0");
  });

  it("flags exactly minCalls calls (boundary)", () => {
    const logs = calls(50, 100, 1_000);
    expect(
      detector.detect(
        makeCtx(logs, { thresholds: { overprovisionedMinCalls: 50 } }),
      ),
    ).toHaveLength(1);
  });

  it("ignores 49 calls (below minCalls)", () => {
    const logs = calls(49, 100, 1_000);
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores calls at exactly the ratio threshold (strict <, boundary)", () => {
    const logs = calls(60, 300, 1_000); // ratio exactly 0.30
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("a single healthy call breaks the run (false-positive guard)", () => {
    const logs = [
      ...calls(30, 100, 1_000),
      makeLog({
        requestId: "healthy",
        occurredAtMs: 1_000_000 + 30 * 1_000,
        completionTokens: 900,
        maxTokens: 1_000,
      }),
      ...calls(30, 100, 1_000).map((l, i) => ({
        ...l,
        requestId: `after-${i}`,
        occurredAtMs: 1_000_000 + (31 + i) * 1_000,
      })),
    ];
    // two runs of 30, each below minCalls
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores calls without max_tokens set", () => {
    const logs = calls(60, 100, null);
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("groups per model (false-positive guard against cross-model pooling)", () => {
    const logs = [
      ...calls(30, 100, 1_000, { model: "gpt-4o-mini" }),
      ...calls(30, 100, 1_000, { model: "gpt-4o" }),
    ];
    // 60 calls total but only 30 per model -> no event
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
    const big = [
      ...calls(50, 100, 1_000, { model: "gpt-4o-mini" }),
      ...calls(50, 100, 1_000, { model: "gpt-4o" }),
    ];
    expect(detector.detect(makeCtx(big))).toHaveLength(2);
  });

  it("returns no events for empty input", () => {
    expect(detector.detect(makeCtx([]))).toEqual([]);
  });

  it("honors custom thresholds", () => {
    const logs = calls(10, 100, 1_000);
    const events = detector.detect(
      makeCtx(logs, {
        thresholds: { overprovisionedMinCalls: 10, overprovisionedMaxRatio: 0.5 },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("emits separate events for runs separated by healthy calls", () => {
    const healthy = (id: string, offset: number) =>
      makeLog({
        requestId: id,
        occurredAtMs: 1_000_000 + offset * 1_000,
        completionTokens: 900,
        maxTokens: 1_000,
      });
    const logs = [
      ...calls(50, 100, 1_000),
      healthy("healthy-1", 50),
      ...calls(50, 100, 1_000).map((l, i) => ({
        ...l,
        requestId: `second-${i}`,
        occurredAtMs: 1_000_000 + (51 + i) * 1_000,
      })),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(2);
  });
});
