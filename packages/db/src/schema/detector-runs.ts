import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detectorRunStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * Detector job checkpointing. The nightly classifier is idempotent and
 * resumable per workspace: on start it resumes after
 * last_processed_log_id, and on completion it advances the cursor.
 * status='failed' rows carry the error for ops triage.
 */
export const detectorRuns = pgTable(
  "detector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    /** Checkpoint: request_logs.request_id cursor of the last processed row. */
    lastProcessedLogId: text("last_processed_log_id"),
    status: detectorRunStatusEnum("status").notNull().default("running"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("detector_runs_workspace_started_idx").on(t.workspaceId, t.startedAt)],
);

export type DetectorRunRow = typeof detectorRuns.$inferSelect;
export type NewDetectorRunRow = typeof detectorRuns.$inferInsert;
