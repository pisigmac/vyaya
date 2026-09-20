import type { DetectorThresholds, WrappedDek } from "@vyaya/core";
import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tenant root. Every other tenant table carries workspace_id referencing
 * this row. RLS policy on this table matches `id` (not workspace_id) against
 * the app.workspace_id GUC; see rls/policies.sql.
 */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** DeskId org_id this workspace maps to (null = dev/mock). */
  deskidOrgId: text("deskid_org_id"),
  /** Per-workspace opt-in for encrypted prompt/response body logging. */
  logBodiesEnabled: boolean("log_bodies_enabled").notNull().default(false),
  /**
   * Where the weekly report email goes. Null = send to every user email in
   * the workspace (worker fallback).
   */
  reportEmail: text("report_email"),
  /**
   * Per-workspace detector threshold overrides (partial DetectorThresholds).
   * The worker merges these over the env defaults before running detectors.
   */
  detectorThresholds: jsonb("detector_thresholds").$type<Partial<DetectorThresholds>>(),
  /**
   * Per-workspace data encryption key, wrapped by the master key
   * (EnvelopeCipher.wrapDek in @vyaya/core). Created on first body opt-in.
   */
  wrappedDek: jsonb("wrapped_dek").$type<WrappedDek>(),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
