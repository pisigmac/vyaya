import { describe, expect, it } from "vitest";
import {
  deskIdClaimsSchema,
  requestLogSchema,
  schemaValidationResultSchema,
  wasteEventSchema,
} from "./schemas.js";

const validLog = {
  requestId: "req-1",
  workspaceId: "ws-1",
  occurredAtMs: 1_700_000_000_000,
  model: "gpt-4o",
  endpoint: "/v1/chat/completions",
  latencyMs: 100,
  promptTokens: 10,
  completionTokens: 5,
  maxTokens: 500,
  costUsd: 0.001,
  inputCostUsd: 0.0004,
  outputCostUsd: 0.0006,
  promptHash: "e".repeat(64),
  sessionId: null,
  featureTag: "chat",
  status: "success",
  schemaValidation: "passed",
  retryAttempt: 0,
  retryOf: null,
  responseConsumed: true,
  promptText: null,
};

describe("requestLogSchema", () => {
  it("accepts a valid row", () => {
    expect(requestLogSchema.parse(validLog).requestId).toBe("req-1");
  });

  it("rejects a malformed prompt hash", () => {
    expect(() =>
      requestLogSchema.parse({ ...validLog, promptHash: "xyz" }),
    ).toThrow();
  });

  it("rejects negative token counts", () => {
    expect(() =>
      requestLogSchema.parse({ ...validLog, promptTokens: -1 }),
    ).toThrow();
  });
});

describe("wasteEventSchema", () => {
  it("accepts a valid event", () => {
    const event = wasteEventSchema.parse({
      workspaceId: "ws-1",
      wasteType: "ghost_output",
      requestIds: ["req-1"],
      dollarsWasted: 0.5,
      evidence: { detector: "ghost_output", summary: "never consumed" },
      detectorVersion: "1.0.0",
      suggestedFix: "Cancel in-flight requests on unmount.",
      detectedAtMs: 1_700_000_000_000,
    });
    expect(event.wasteType).toBe("ghost_output");
  });

  it("rejects unknown waste types", () => {
    expect(() =>
      wasteEventSchema.parse({
        workspaceId: "ws-1",
        wasteType: "made_up",
        requestIds: ["req-1"],
        dollarsWasted: 0.5,
        evidence: {},
        detectorVersion: "1.0.0",
        suggestedFix: "x",
        detectedAtMs: 1,
      }),
    ).toThrow();
  });
});

describe("deskIdClaimsSchema", () => {
  const claims = {
    sub: "u-1",
    email: "a@b.c",
    org_id: null,
    workspace_id: "ws-1",
    aud: ["vyaya"],
    roles: { vyaya: "admin" },
    token_version: 1,
    iss: "https://deskid.test",
    exp: 4_000_000_000,
  };

  it("accepts valid claims", () => {
    expect(deskIdClaimsSchema.parse(claims).aud).toEqual(["vyaya"]);
  });

  it("rejects unknown roles", () => {
    expect(() =>
      deskIdClaimsSchema.parse({ ...claims, roles: { vyaya: "root" } }),
    ).toThrow();
  });
});

describe("schemaValidationResultSchema", () => {
  it("accepts the three documented values", () => {
    for (const v of ["passed", "failed", "not_requested"]) {
      expect(schemaValidationResultSchema.parse(v)).toBe(v);
    }
  });
});
