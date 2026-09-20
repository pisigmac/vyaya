import { bigint, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { workspaceRoleEnum } from "./enums.js";

/**
 * Service-global DeskId reconciliation state (worker job behind
 * DESKID_RECONCILE_ENABLED). These tables are NOT tenant tables: the
 * DeskId reconciliation feed is instance-wide and grant events arrive
 * before the user's workspace mapping is known. RLS is still ENABLEd +
 * FORCEd; access is governed by service/read policies instead of the
 * workspace GUC (see rls/policies-worker.sql):
 *   * reconciliation_cursor — vyaya_service only.
 *   * user_grants_cache    — SELECT for every role (the web/proxy app role
 *     reads grants for authorization), writes only for vyaya_service.
 */

/**
 * Singleton cursor over GET /v1/admin/reconciliation/events. One row with
 * id 'deskid'; last_event_id is the greatest event id applied so far.
 */
export const reconciliationCursor = pgTable("reconciliation_cursor", {
  id: text("id").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export type ReconciliationCursorRow = typeof reconciliationCursor.$inferSelect;
export type NewReconciliationCursorRow = typeof reconciliationCursor.$inferInsert;

/**
 * Local cache of DeskId audience grants, keyed by (deskid_sub, audience).
 * Reconciliation events upsert rows here; the latest role wins. Email is
 * filled in from user.created events when seen (grants may arrive first).
 */
export const userGrantsCache = pgTable(
  "user_grants_cache",
  {
    /** DeskId `sub` (user uuid). */
    deskidSub: text("deskid_sub").notNull(),
    audience: text("audience").notNull(),
    role: workspaceRoleEnum("role").notNull(),
    email: text("email"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deskidSub, t.audience] })],
);

export type UserGrantsCacheRow = typeof userGrantsCache.$inferSelect;
export type NewUserGrantsCacheRow = typeof userGrantsCache.$inferInsert;
