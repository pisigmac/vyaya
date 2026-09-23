import { describe, expect, it } from "vitest";
import {
  ContextAmnesiaDetector,
  jaccardSimilarity,
  tokenize,
  tokenShingles,
} from "./context-amnesia.js";
import { makeCtx, makeLog } from "./fixtures.js";

const detector = new ContextAmnesiaDetector();

const BACKGROUND = [
  "you are a support agent for acme corporation",
  "always answer politely and reference the customer handbook",
  "the customer handbook covers billing refunds shipping and account issues",
  "never offer discounts above twenty percent without manager approval",
  "the company was founded in nineteen ninety eight and operates worldwide",
  "business hours are nine to five eastern time monday through friday",
  "for escalations contact the on duty supervisor immediately",
  "all responses must be concise factual and free of speculation",
].join(" ");

function sessionLog(
  requestId: string,
  sessionId: string | null,
  promptText: string | null,
  offsetMs: number,
  overrides: Record<string, unknown> = {},
) {
  return makeLog({
    requestId,
    sessionId,
    promptText,
    occurredAtMs: 1_000_000 + offsetMs,
    promptTokens: 1_000,
    inputCostUsd: 0.01,
    ...overrides,
  });
}

describe("token shingles and jaccard", () => {
  it("tokenizes deterministically", () => {
    expect(tokenize("Hello, World! 42")).toEqual(["hello", "world", "42"]);
  });

  it("builds word shingles of the given size", () => {
    expect(tokenShingles("a b c d", 2)).toEqual(new Set(["a b", "b c", "c d"]));
  });

  it("yields a single shingle for short texts", () => {
    expect(tokenShingles("a b", 3)).toEqual(new Set(["a b"]));
  });

  it("computes jaccard similarity", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(
      1 / 3,
      10,
    );
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(["x"]), new Set(["x"]))).toBe(1);
  });
});

describe("ContextAmnesiaDetector", () => {
  it("flags a session that resends background content across turns (happy path)", () => {
    const logs = [
      sessionLog("t1", "sess-1", `${BACKGROUND} what is my refund status`, 0),
      sessionLog("t2", "sess-1", `${BACKGROUND} and what about shipping`, 60_000),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.wasteType).toBe("context_amnesia");
    expect(event.requestIds).toEqual(["t2"]); // the later turn carries the waste
    expect(event.dollarsWasted).toBeGreaterThan(0);
    expect(event.detectorVersion).toBe("1.0.0");
    expect(event.evidence["sessionId"]).toBe("sess-1");
    expect(event.evidence["wastedTurnCount"]).toBe(1);
  });

  it("flags similarity exactly at the threshold (boundary)", () => {
    const p1 = `${BACKGROUND} question one about billing`;
    const p2 = `${BACKGROUND} question two about refunds`;
    const sim = jaccardSimilarity(tokenShingles(p1, 3), tokenShingles(p2, 3));
    const logs = [
      sessionLog("t1", "sess-1", p1, 0),
      sessionLog("t2", "sess-1", p2, 60_000),
    ];
    const events = detector.detect(
      makeCtx(logs, {
        thresholds: {
          contextAmnesiaJaccardThreshold: sim,
          contextAmnesiaMinOverlapTokens: 1,
        },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("ignores similarity just below the threshold", () => {
    const p1 = `${BACKGROUND} question one about billing`;
    const p2 = `${BACKGROUND} question two about refunds`;
    const sim = jaccardSimilarity(tokenShingles(p1, 3), tokenShingles(p2, 3));
    const logs = [
      sessionLog("t1", "sess-1", p1, 0),
      sessionLog("t2", "sess-1", p2, 60_000),
    ];
    const events = detector.detect(
      makeCtx(logs, {
        thresholds: {
          contextAmnesiaJaccardThreshold: sim + 1e-9,
          contextAmnesiaMinOverlapTokens: 1,
        },
      }),
    );
    expect(events).toHaveLength(0);
  });

  it("ignores dissimilar consecutive turns (false-positive guard)", () => {
    const logs = [
      sessionLog("t1", "sess-1", "alpha beta gamma delta epsilon zeta", 0),
      sessionLog(
        "t2",
        "sess-1",
        "xylophone quantum undergrowth kinetic jitter vapour",
        60_000,
      ),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("does not compare turns across different sessions (false-positive guard)", () => {
    const text = `${BACKGROUND} identical question`;
    const logs = [
      sessionLog("t1", "sess-1", text, 0),
      sessionLog("t2", "sess-2", text, 60_000),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores single-turn sessions and null session ids", () => {
    const logs = [
      sessionLog("t1", "sess-1", `${BACKGROUND} one`, 0),
      sessionLog("t2", null, `${BACKGROUND} one`, 60_000),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("skips metadata-only logs without prompt bodies", () => {
    const logs = [
      sessionLog("t1", "sess-1", null, 0),
      sessionLog("t2", "sess-1", null, 60_000),
    ];
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("ignores overlap below the minimum repeated tokens", () => {
    const logs = [
      sessionLog("t1", "sess-1", `${BACKGROUND} q1`, 0, { promptTokens: 10 }),
      sessionLog("t2", "sess-1", `${BACKGROUND} q2`, 60_000, {
        promptTokens: 10,
      }),
    ];
    // similarity * 10 tokens < 64 default minimum
    expect(detector.detect(makeCtx(logs))).toHaveLength(0);
  });

  it("returns no events for empty input", () => {
    expect(detector.detect(makeCtx([]))).toEqual([]);
  });

  it("accumulates multiple wasted turns into one event per session", () => {
    const logs = [
      sessionLog("t1", "sess-1", `${BACKGROUND} q1`, 0),
      sessionLog("t2", "sess-1", `${BACKGROUND} q2`, 60_000),
      sessionLog("t3", "sess-1", `${BACKGROUND} q3`, 120_000),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(1);
    expect(events[0]!.requestIds).toEqual(["t2", "t3"]);
  });
});
