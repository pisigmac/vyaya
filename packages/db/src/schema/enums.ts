import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Postgres enums shared across tables. Value lists mirror the TypeScript
 * unions in @vyaya/core (types.ts) — keep them in lockstep.
 */

export const requestStatusEnum = pgEnum("request_status", [
  "success",
  "error",
  "client_disconnect",
]);

export const schemaValidationResultEnum = pgEnum("schema_validation_result", [
  "passed",
  "failed",
  "not_requested",
]);

export const wasteTypeEnum = pgEnum("waste_type", [
  "ghost_output",
  "retry_storm",
  "schema_failure_burn",
  "context_amnesia",
  "overprovisioned_max_tokens",
]);

/** DeskId `roles.vyaya` values mirrored locally per user row. */
export const workspaceRoleEnum = pgEnum("workspace_role", [
  "admin",
  "operator",
  "viewer",
]);

export const detectorRunStatusEnum = pgEnum("detector_run_status", [
  "running",
  "completed",
  "failed",
]);

export const reportStatusEnum = pgEnum("report_status", [
  "generated",
  "emailed",
  "failed",
]);

export const stripeMeterEventStatusEnum = pgEnum("stripe_meter_event_status", [
  "pending",
  "sent",
  "failed",
]);
