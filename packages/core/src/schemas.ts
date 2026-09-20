import { z } from "zod";
import { WASTE_TYPES } from "./types.js";

/** Zod mirrors of src/types.ts — validate at every boundary (HTTP, queue, DB). */

export const wasteTypeSchema = z.enum(WASTE_TYPES);

export const requestStatusSchema = z.enum([
  "success",
  "error",
  "client_disconnect",
]);

export const schemaValidationResultSchema = z.enum([
  "passed",
  "failed",
  "not_requested",
]);

export const requestLogSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  occurredAtMs: z.number().int().nonnegative(),
  model: z.string().min(1),
  endpoint: z.string().min(1),
  latencyMs: z.number().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
  costUsd: z.number().nonnegative(),
  inputCostUsd: z.number().nonnegative(),
  outputCostUsd: z.number().nonnegative(),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 hex expected"),
  sessionId: z.string().min(1).nullable(),
  featureTag: z.string().min(1).nullable(),
  status: requestStatusSchema,
  schemaValidation: schemaValidationResultSchema,
  retryAttempt: z.number().int().nonnegative(),
  retryOf: z.string().min(1).nullable(),
  responseConsumed: z.boolean(),
  promptText: z.string().nullable(),
});

export const wasteEventSchema = z.object({
  workspaceId: z.string().min(1),
  wasteType: wasteTypeSchema,
  requestIds: z.array(z.string().min(1)).min(1),
  dollarsWasted: z.number().nonnegative(),
  evidence: z.record(z.string(), z.unknown()),
  detectorVersion: z.string().min(1),
  suggestedFix: z.string().min(1),
  detectedAtMs: z.number().int().nonnegative(),
});

/** Evidence shared shape; each detector extends this with its own fields. */
export const detectorEvidenceSchema = z
  .object({
    detector: wasteTypeSchema,
    summary: z.string().min(1),
  })
  .catchall(z.unknown());

const roleSchema = z.enum(["admin", "operator", "viewer"]);

/** DeskId RS256 JWT claims (JSON, not OIDC). */
export const deskIdClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  org_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  aud: z
    .union([z.string(), z.array(z.string())])
    .transform((aud) => (Array.isArray(aud) ? aud : [aud])),
  roles: z.record(z.string(), roleSchema),
  token_version: z.number().int().nonnegative(),
  iss: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int().optional(),
});

export type RequestLogParsed = z.output<typeof requestLogSchema>;
export type WasteEventParsed = z.output<typeof wasteEventSchema>;
export type DeskIdClaimsParsed = z.output<typeof deskIdClaimsSchema>;
