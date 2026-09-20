import { describe, expect, it } from "vitest";
import { byTimeThenId } from "./interface.js";
import { tokenShingles } from "./context-amnesia.js";
import { OverprovisionedMaxTokensDetector } from "./overprovisioned-max-tokens.js";
import { makeCtx, makeLog } from "./fixtures.js";

describe("detector edge cases", () => {
  it("tokenShingles yields an empty set for empty/punctuation-only text", () => {
    expect(tokenShingles("", 3).size).toBe(0);
    expect(tokenShingles("!?. ", 3).size).toBe(0);
  });

  it("byTimeThenId breaks time ties by requestId", () => {
    const a = makeLog({ requestId: "a", occurredAtMs: 5 });
    const b = makeLog({ requestId: "b", occurredAtMs: 5 });
    expect(byTimeThenId(a, b)).toBe(-1);
    expect(byTimeThenId(b, a)).toBe(1);
    expect(byTimeThenId(a, a)).toBe(0);
    expect(byTimeThenId(a, makeLog({ occurredAtMs: 9 }))).toBeLessThan(0);
  });

  it("overprovisioned: zero-completion calls contribute no inferred price", () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      makeLog({
        requestId: `zc-${i}`,
        occurredAtMs: 1_000_000 + i,
        maxTokens: 1_000,
        completionTokens: 0,
        outputCostUsd: 0,
      }),
    );
    const events = new OverprovisionedMaxTokensDetector().detect(
      makeCtx(logs),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.dollarsWasted).toBe(0);
    expect(events[0]!.evidence["excessProvisionedOutputTokens"]).toBe(50_000);
  });
});
