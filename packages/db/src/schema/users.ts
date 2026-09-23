import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceRoleEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * Local mirror of DeskId users (claim `sub`). DeskId stays the source of
 * truth; these rows exist for joins, display and API-key ownership. The
 * worker's reconciliation job (DESKID_RECONCILE_ENABLED) keeps them fresh.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** DeskId `sub` claim — globally unique user id. */
    deskidSub: text("deskid_sub").notNull().unique(),
    email: text("email").notNull(),
    role: workspaceRoleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("users_workspace_id_idx").on(t.workspaceId)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
