import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { wasteTypeEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * A detected unit of wasted spend. Emitted by the worker's detectors
 * (deterministic heuristics v1, pinned detector_version for reproducible
 * re-runs). Every event carries structured evidence and a suggested fix.
 *
 * dedupe_key is the worker idempotency anchor: a stable hash of
 * (workspace_id, waste_type, detector_version, sorted request_ids), so a
 * re-run over the same logs upserts instead of duplicating.
 */
export const wasteEvents = pgTable(
  "waste_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    wasteType: wasteTypeEnum("waste_type").notNull(),
    /** request_logs.request_id values implicated in this event. */
    requestIds: jsonb("request_ids").$type<string[]>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    dollarsWasted: numeric("dollars_wasted", {
      precision: 14,
      scale: 8,
      mode: "number",
    }).notNull(),
    /** Detector-specific justification (why this is waste). */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    detectorVersion: text("detector_version").notNull(),
    suggestedFix: text("suggested_fix").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "date" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("waste_events_workspace_dedupe_idx").on(t.workspaceId, t.dedupeKey),
    index("waste_events_workspace_type_detected_idx").on(
      t.workspaceId,
      t.wasteType,
      t.detectedAt,
    ),
  ],
);

export type WasteEventRow = typeof wasteEvents.$inferSelect;
export type NewWasteEventRow = typeof wasteEvents.$inferInsert;
