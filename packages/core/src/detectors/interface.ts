import type { RequestLog, WasteEvent, WasteType } from "../types.js";

/**
 * Detector threshold bundle. Global defaults come from env
 * (packages/config); workspaces may override per-workspace in the database.
 * Workers merge overrides before constructing the DetectorContext.
 */
export interface DetectorThresholds {
  /** retry_storm: attempts within the window that count as a storm. */
  retryStormMinAttempts: number;
  /** retry_storm: sliding window in milliseconds. */
  retryStormWindowMs: number;
  /** ghost_output: unconsumed responses younger than this are ignored. */
  ghostOutputMinAgeMs: number;
  /** context_amnesia: minimum Jaccard similarity between consecutive turns. */
  contextAmnesiaJaccardThreshold: number;
  /** context_amnesia: minimum estimated repeated input tokens. */
  contextAmnesiaMinOverlapTokens: number;
  /** context_amnesia: shingle size (in word tokens) for Jaccard. */
  contextAmnesiaShingleSize: number;
  /** overprovisioned_max_tokens: minimum calls in a rolling window. */
  overprovisionedMinCalls: number;
  /** overprovisioned_max_tokens: completion/max_tokens must be below this. */
  overprovisionedMaxRatio: number;
  /**
   * overprovisioned_max_tokens: fraction of the excess provisioned output
   * tokens valued as waste (reservation overhead estimate).
   */
  overprovisionedReservationOverhead: number;
}

/** Defaults exactly as the waste taxonomy specifies. */
export const DEFAULT_DETECTOR_THRESHOLDS: DetectorThresholds = {
  retryStormMinAttempts: 3,
  retryStormWindowMs: 60_000,
  ghostOutputMinAgeMs: 300_000,
  contextAmnesiaJaccardThreshold: 0.6,
  contextAmnesiaMinOverlapTokens: 64,
  contextAmnesiaShingleSize: 3,
  overprovisionedMinCalls: 50,
  overprovisionedMaxRatio: 0.3,
  overprovisionedReservationOverhead: 0.1,
};

export interface DetectorContext {
  workspaceId: string;
  /** Recent request logs for the workspace (any order). */
  logs: readonly RequestLog[];
  thresholds: DetectorThresholds;
  /** Reference time in epoch ms — injected so runs are deterministic. */
  nowMs: number;
}

/**
 * A deterministic waste detector (heuristics v1, zero LLM cost).
 * LLM-judged detectors slot in later behind this same interface.
 */
export interface WasteDetector {
  readonly name: WasteType;
  /** Semver, pinned onto every emitted waste_event for reproducibility. */
  readonly version: string;
  detect(ctx: DetectorContext): WasteEvent[];
}

/** Deterministic total ordering used by all detectors before scanning. */
export function byTimeThenId(a: RequestLog, b: RequestLog): number {
  if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

export function makeWasteEvent(
  ctx: DetectorContext,
  detector: WasteDetector,
  requestIds: string[],
  dollarsWasted: number,
  evidence: Record<string, unknown>,
  suggestedFix: string,
): WasteEvent {
  return {
    workspaceId: ctx.workspaceId,
    wasteType: detector.name,
    requestIds,
    dollarsWasted: Math.round(dollarsWasted * 1e8) / 1e8,
    evidence: { detector: detector.name, ...evidence },
    detectorVersion: detector.version,
    suggestedFix,
    detectedAtMs: ctx.nowMs,
  };
}
