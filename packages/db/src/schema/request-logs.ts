import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { requestStatusEnum, schemaValidationResultEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * One row per proxied LLM request. Metadata only — bodies (when the
 * workspace opts in) live in request_bodies, encrypted.
 *
 * Column names are contract-bound to PostgresLogSink in @vyaya/core, which
 * INSERTs by name with ON CONFLICT (request_id) DO NOTHING for idempotent
 * retry-queue replays. Do not rename without changing the sink.
 *
 * Costs are computed server-side from the versioned price table in
 * @vyaya/core — never trusted from the client.
 */
export const requestLogs = pgTable(
  "request_logs",
  {
    /** Client/supplier correlation id; idempotency key for log writes. */
    requestId: text("request_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull(),
    model: text("model").notNull(),
    endpoint: text("endpoint").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    /** Requested max_tokens, or null when the client did not set one. */
    maxTokens: integer("max_tokens"),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 8,
      mode: "number",
    }).notNull(),
    inputCostUsd: numeric("input_cost_usd", {
      precision: 14,
      scale: 8,
      mode: "number",
    }).notNull(),
    outputCostUsd: numeric("output_cost_usd", {
      precision: 14,
      scale: 8,
      mode: "number",
    }).notNull(),
    /** SHA-256 (hex) of the normalized prompt — retry_storm grouping key. */
    promptHash: text("prompt_hash").notNull(),
    /** X-Vyaya-Session header value, or null. */
    sessionId: text("session_id"),
    /** X-Vyaya-Tag header value (validated against the allowlist), or null. */
    featureTag: text("feature_tag"),
    status: requestStatusEnum("status").notNull(),
    schemaValidation: schemaValidationResultEnum("schema_validation").notNull(),
    /**
     * Downstream-consumption signal for ghost_output. False past the ghost
     * threshold means the client never read what it paid to generate.
     */
    responseConsumed: boolean("response_consumed").notNull().default(true),
    /**
     * Retry metadata (supplementary; detectors primarily use prompt_hash +
     * status + timing). retry_attempt 0 = first attempt; retry_of points at
     * the request_id of the first attempt in the chain.
     */
    retryAttempt: integer("retry_attempt").notNull().default(0),
    retryOf: text("retry_of"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Worker checkpoint scans and dashboard time-range queries.
    index("request_logs_workspace_occurred_idx").on(t.workspaceId, t.occurredAt),
    // retry_storm detector: identical prompts clustered in time.
    index("request_logs_workspace_hash_idx").on(t.workspaceId, t.promptHash, t.occurredAt),
    // context_amnesia detector: turns within a session.
    index("request_logs_workspace_session_idx").on(t.workspaceId, t.sessionId),
    // Dashboard breakdown by feature tag.
    index("request_logs_workspace_tag_idx").on(t.workspaceId, t.featureTag),
  ],
);

export type RequestLogRow = typeof requestLogs.$inferSelect;
export type NewRequestLogRow = typeof requestLogs.$inferInsert;
