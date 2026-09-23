import { bigint, date, numeric, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Per-workspace per-day rollup of request_logs. The worker's retention
 * sweeper upserts these rows BEFORE deleting expired request_logs, so
 * aggregate history survives the 400-day metadata retention window:
 * bodies 7 days, metadata 400 days, aggregates forever.
 *
 * One row per (workspace_id, day). Re-aggregating the same day adds to the
 * existing row (the sweeper only rolls up days it is about to delete, so
 * each source log is counted exactly once).
 */
export const dailyAggregates = pgTable(
  "daily_aggregates",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Calendar day (UTC) the aggregated requests occurred on. */
    day: date("day", { mode: "string" }).notNull(),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" })
      .notNull()
      .default(0),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 8,
      mode: "number",
    }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day] })],
);

export type DailyAggregateRow = typeof dailyAggregates.$inferSelect;
export type NewDailyAggregateRow = typeof dailyAggregates.$inferInsert;
