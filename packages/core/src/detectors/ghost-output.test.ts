import { describe, expect, it } from "vitest";
import { GhostOutputDetector } from "./ghost-output.js";
import { makeCtx, makeLog } from "./fixtures.js";
import { DEFAULT_DETECTOR_THRESHOLDS } from "./interface.js";

const detector = new GhostOutputDetector();
const MIN_AGE = DEFAULT_DETECTOR_THRESHOLDS.ghostOutputMinAgeMs;
const NOW = 10_000_000;

describe("GhostOutputDetector", () => {
  it("flags an unconsumed successful response past the age threshold (happy path)", () => {
    const log = makeLog({
      requestId: "ghost-1",
      occurredAtMs: NOW - MIN_AGE - 1_000,
      responseConsumed: false,
      costUsd: 0.42,
    });
    const events = detector.detect(makeCtx([log], { nowMs: NOW }));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.wasteType).toBe("ghost_output");
    expect(event.requestIds).toEqual(["ghost-1"]);
    expect(event.dollarsWasted).toBe(0.42);
    expect(event.detectorVersion).toBe("1.0.0");
    expect(event.suggestedFix.length).toBeGreaterThan(0);
    expect(event.evidence["ageMs"]).toBe(MIN_AGE + 1_000);
  });

  it("flags a request exactly at the age threshold (boundary)", () => {
    const log = makeLog({
      occurredAtMs: NOW - MIN_AGE,
      responseConsumed: false,
    });
    expect(detector.detect(makeCtx([log], { nowMs: NOW }))).toHaveLength(1);
  });

  it("ignores a request one millisecond below the age threshold", () => {
    const log = makeLog({
      occurredAtMs: NOW - MIN_AGE + 1,
      responseConsumed: false,
    });
    expect(detector.detect(makeCtx([log], { nowMs: NOW }))).toHaveLength(0);
  });

  it("ignores consumed responses (false-positive guard)", () => {
    const log = makeLog({
      occurredAtMs: NOW - MIN_AGE - 60_000,
      responseConsumed: true,
    });
    expect(detector.detect(makeCtx([log], { nowMs: NOW }))).toHaveLength(0);
  });

  it("ignores failed requests (false-positive guard)", () => {
    const log = makeLog({
      occurredAtMs: NOW - MIN_AGE - 60_000,
      responseConsumed: false,
      status: "error",
    });
    expect(detector.detect(makeCtx([log], { nowMs: NOW }))).toHaveLength(0);
  });

  it("returns no events for empty input", () => {
    expect(detector.detect(makeCtx([], { nowMs: NOW }))).toEqual([]);
  });

  it("emits one event per qualifying request, in time order", () => {
    const a = makeLog({
      requestId: "a",
      occurredAtMs: NOW - MIN_AGE - 5_000,
      responseConsumed: false,
    });
    const b = makeLog({
      requestId: "b",
      occurredAtMs: NOW - MIN_AGE - 10_000,
      responseConsumed: false,
    });
    const events = detector.detect(makeCtx([a, b], { nowMs: NOW }));
    expect(events.map((e) => e.requestIds[0])).toEqual(["b", "a"]);
  });

  it("honors a custom age threshold", () => {
    const log = makeLog({
      occurredAtMs: NOW - 2_000,
      responseConsumed: false,
    });
    const events = detector.detect(
      makeCtx([log], {
        nowMs: NOW,
        thresholds: { ghostOutputMinAgeMs: 1_000 },
      }),
    );
    expect(events).toHaveLength(1);
  });
});
