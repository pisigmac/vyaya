import type { RequestLog } from "../types.js";
import {
  DEFAULT_DETECTOR_THRESHOLDS,
  type DetectorContext,
  type DetectorThresholds,
} from "./interface.js";

let counter = 0;

/** Deterministic RequestLog factory for detector tests. */
export function makeLog(overrides: Partial<RequestLog> = {}): RequestLog {
  counter += 1;
  const n = counter;
  return {
    requestId: `req-${n}`,
    workspaceId: "ws-test",
    occurredAtMs: 1_000_000 + n * 1_000,
    model: "gpt-4o-mini",
    endpoint: "/v1/chat/completions",
    latencyMs: 120,
    promptTokens: 100,
    completionTokens: 50,
    maxTokens: null,
    costUsd: 0.001,
    inputCostUsd: 0.0006,
    outputCostUsd: 0.0004,
    promptHash: "a".repeat(64),
    sessionId: null,
    featureTag: null,
    status: "success",
    schemaValidation: "not_requested",
    retryAttempt: 0,
    retryOf: null,
    responseConsumed: true,
    promptText: null,
    ...overrides,
  };
}

export function makeCtx(
  logs: RequestLog[],
  overrides: {
    workspaceId?: string;
    thresholds?: Partial<DetectorThresholds>;
    nowMs?: number;
  } = {},
): DetectorContext {
  return {
    workspaceId: overrides.workspaceId ?? "ws-test",
    logs,
    thresholds: { ...DEFAULT_DETECTOR_THRESHOLDS, ...overrides.thresholds },
    nowMs: overrides.nowMs ?? 1_000_000_000,
  };
}
