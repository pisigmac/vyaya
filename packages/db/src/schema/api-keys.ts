import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Per-workspace proxy API keys (X-Vyaya-Key). Only the argon2id hash is
 * stored; plaintext is shown once at creation. `key_prefix` ("vy_live")
 * makes keys identifiable in logs/scans; `last4` is shown in the UI.
 * Revocation sets revoked_at — keys are never hard-deleted (audit trail).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull().default("vy_live"),
    /** argon2id encoded hash of the plaintext key. */
    keyHash: text("key_hash").notNull(),
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("api_keys_workspace_id_idx").on(t.workspaceId),
    index("api_keys_active_workspace_idx")
      .on(t.workspaceId)
      .where(sql`revoked_at IS NULL`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
