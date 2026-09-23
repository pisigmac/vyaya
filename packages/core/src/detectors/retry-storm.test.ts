import { describe, expect, it } from "vitest";
import { RetryStormDetector } from "./retry-storm.js";
import { makeCtx, makeLog } from "./fixtures.js";

const detector = new RetryStormDetector();
const HASH = "b".repeat(64);
const T0 = 5_000_000;

function attempt(
  requestId: string,
  offsetMs: number,
  status: "success" | "error" = "error",
  promptHash: string = HASH,
) {
  return makeLog({
    requestId,
    occurredAtMs: T0 + offsetMs,
    status,
    promptHash,
    costUsd: 0.01,
  });
}

describe("RetryStormDetector", () => {
  it("flags >=3 identical calls in 60s where a later attempt succeeded (happy path)", () => {
    const logs = [
      attempt("r1", 0),
      attempt("r2", 5_000),
      attempt("r3", 9_000, "success"),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.wasteType).toBe("retry_storm");
    expect(event.requestIds).toEqual(["r1", "r2"]);
    expect(event.dollarsWasted).toBeCloseTo(0.02, 10);
    expect(event.evidence["succeededRequestId"]).toBe("r3");
    expect(event.evidence["promptHash"]).toBe(HASH);
    expect(event.detectorVersion).toBe("1.0.0");
  });

  it("flags a cluster spanning exactly the 60s window (boundary)", () => {
    const logs = [
      attempt("r1", 0),
      attempt("r2", 30_000),
      attempt("r3", 60_000, "success"),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(1);
  });

  it("ignores two attempts (below min attempts)", () => {
    const logs = [attempt("r1", 0), attempt("r2", 5_000, "success")];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores clusters spanning more than the window", () => {
    const logs = [
      attempt("r1", 0),
      attempt("r2", 40_000),
      attempt("r3", 80_000, "success"),
    ];
    // window from r1 covers r1..r2 (40s), r3 is 80s out -> no 3-call cluster
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores clusters with no successful attempt (false-positive guard)", () => {
    const logs = [
      attempt("r1", 0),
      attempt("r2", 5_000),
      attempt("r3", 9_000),
      attempt("r4", 12_000),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores a leading success followed by duplicates (no earlier wasted attempts)", () => {
    const logs = [
      attempt("r1", 0, "success"),
      attempt("r2", 5_000, "success"),
      attempt("r3", 9_000, "success"),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("does not group different prompt hashes (false-positive guard)", () => {
    const logs = [
      attempt("r1", 0, "error", "a".repeat(64)),
      attempt("r2", 5_000, "error", "b".repeat(64)),
      attempt("r3", 9_000, "success", "c".repeat(64)),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("returns no events for empty input", () => {
    expect(detector.detect(makeCtx([]))).toEqual([]);
  });

  it("emits separate events for separate storms and skips consumed attempts", () => {
    const logs = [
      attempt("s1r1", 0),
      attempt("s1r2", 5_000),
      attempt("s1r3", 9_000, "success"),
      attempt("s2r1", 500_000),
      attempt("s2r2", 505_000),
      attempt("s2r3", 509_000, "success"),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(2);
    expect(events[0]!.requestIds).toEqual(["s1r1", "s1r2"]);
    expect(events[1]!.requestIds).toEqual(["s2r1", "s2r2"]);
  });

  it("honors custom thresholds", () => {
    const logs = [
      attempt("r1", 0),
      attempt("r2", 5_000),
      attempt("r3", 9_000),
      attempt("r4", 12_000, "success"),
    ];
    const events = detector.detect(
      makeCtx(logs, {
        thresholds: { retryStormMinAttempts: 4, retryStormWindowMs: 15_000 },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.requestIds).toEqual(["r1", "r2", "r3"]);
  });
});
