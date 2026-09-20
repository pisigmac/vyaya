/**
 * Core domain types shared by every Vyaya service.
 * These are the TypeScript source of truth; src/schemas.ts mirrors them
 * with zod for boundary validation.
 */

export type WasteType =
  | "ghost_output"
  | "retry_storm"
  | "schema_failure_burn"
  | "context_amnesia"
  | "overprovisioned_max_tokens";

export const WASTE_TYPES: readonly WasteType[] = [
  "ghost_output",
  "retry_storm",
  "schema_failure_burn",
  "context_amnesia",
  "overprovisioned_max_tokens",
];

export type RequestStatus = "success" | "error" | "client_disconnect";

export type SchemaValidationResult = "passed" | "failed" | "not_requested";

/**
 * One proxied LLM request, as recorded by the proxy's LogSink.
 * Costs are always computed server-side from the versioned price table in
 * packages/core — never trusted from the client.
 */
export interface RequestLog {
  requestId: string;
  workspaceId: string;
  /** Epoch milliseconds when the request completed. */
  occurredAtMs: number;
  model: string;
  endpoint: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Requested max_tokens, or null when the client did not set one. */
  maxTokens: number | null;
  /** Total computed cost in USD. */
  costUsd: number;
  /** Computed input-token cost in USD. */
  inputCostUsd: number;
  /** Computed output-token cost in USD. */
  outputCostUsd: number;
  /** SHA-256 (hex) of the normalized prompt. */
  promptHash: string;
  /** X-Vyaya-Session header value, or null. */
  sessionId: string | null;
  /** X-Vyaya-Tag header value (allowlisted), or null. */
  featureTag: string | null;
  status: RequestStatus;
  schemaValidation: SchemaValidationResult;
  /**
   * Retry attempt number from the X-Vyaya-Retry-Attempt header
   * (0 = first attempt). retryOf points at the request_id of the first
   * attempt in the chain (X-Vyaya-Retry-Of), or null.
   */
  retryAttempt: number;
  retryOf: string | null;
  /**
   * Whether the response was consumed downstream. False past the ghost
   * threshold means the client never read what it paid to generate.
   */
  responseConsumed: boolean;
  /**
   * Decrypted prompt text. Only present in the worker when the workspace
   * opted into body logging (LOG_BODIES); null for metadata-only logging.
   */
  promptText: string | null;
}

/** A detected unit of waste. Persisted as a waste_event row. */
export interface WasteEvent {
  workspaceId: string;
  wasteType: WasteType;
  requestIds: string[];
  dollarsWasted: number;
  /** Structured justification for the finding (detector-specific). */
  evidence: Record<string, unknown>;
  /** Pinned by the detector registry so re-runs are reproducible. */
  detectorVersion: string;
  suggestedFix: string;
  detectedAtMs: number;
}

/** DeskId JWT claims (RS256). Verified statelessly against DeskId JWKS. */
export interface DeskIdClaims {
  sub: string;
  email: string;
  org_id: string | null;
  workspace_id: string | null;
  aud: string[];
  roles: Record<string, "admin" | "operator" | "viewer">;
  token_version: number;
  iss: string;
  exp: number;
  iat?: number;
}
