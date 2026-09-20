import { describe, expect, it } from "vitest";
import { SchemaFailureBurnDetector } from "./schema-failure-burn.js";
import { makeCtx, makeLog } from "./fixtures.js";

const detector = new SchemaFailureBurnDetector();

describe("SchemaFailureBurnDetector", () => {
  it("flags a successful response that failed schema validation (happy path)", () => {
    const log = makeLog({
      requestId: "sf-1",
      status: "success",
      schemaValidation: "failed",
      costUsd: 0.1337,
    });
    const events = detector.detect(makeCtx([log]));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.wasteType).toBe("schema_failure_burn");
    expect(event.requestIds).toEqual(["sf-1"]);
    expect(event.dollarsWasted).toBe(0.1337);
    expect(event.detectorVersion).toBe("1.0.0");
    expect(event.suggestedFix.length).toBeGreaterThan(0);
  });

  it("flags every failed-validation request when several exist", () => {
    const logs = [
      makeLog({ requestId: "a", schemaValidation: "failed" }),
      makeLog({ requestId: "b", schemaValidation: "failed" }),
    ];
    const events = detector.detect(makeCtx(logs));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.requestIds[0])).toEqual(["a", "b"]);
  });

  it("ignores responses that passed validation (false-positive guard)", () => {
    const log = makeLog({ schemaValidation: "passed" });
    expect(detector.detect(makeCtx([log]))).toHaveLength(0);
  });

  it("ignores requests without validation (below-threshold analogue)", () => {
    const log = makeLog({ schemaValidation: "not_requested" });
    expect(detector.detect(makeCtx([log]))).toHaveLength(0);
  });

  it("ignores errored requests even if validation failed (no billed completion)", () => {
    const log = makeLog({ status: "error", schemaValidation: "failed" });
    expect(detector.detect(makeCtx([log]))).toHaveLength(0);
  });

  it("returns no events for empty input", () => {
    expect(detector.detect(makeCtx([]))).toEqual([]);
  });

  it("writes the full generation cost off in evidence", () => {
    const log = makeLog({
      requestId: "sf-2",
      schemaValidation: "failed",
      costUsd: 1.25,
      promptTokens: 10_000,
      completionTokens: 2_000,
    });
    const event = detector.detect(makeCtx([log]))[0]!;
    expect(event.dollarsWasted).toBe(1.25);
    expect(event.evidence["promptTokens"]).toBe(10_000);
    expect(event.evidence["completionTokens"]).toBe(2_000);
  });
});
