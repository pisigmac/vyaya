import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Per-workspace allowlist for the X-Vyaya-Tag header. The proxy validates
 * incoming feature_tag values against this table (empty = allow all,
 * matching the FEATURE_TAG_ALLOWLIST env fallback semantics).
 */
export const featureTagAllowlist = pgTable(
  "feature_tag_allowlist",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.tag] })],
);

export type FeatureTagAllowlistRow = typeof featureTagAllowlist.$inferSelect;
export type NewFeatureTagAllowlistRow = typeof featureTagAllowlist.$inferInsert;
