import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { stripeMeterEventStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * Stripe meter-event outbox (STRIPE_ENABLED, test-mode plumbing only in v1).
 * The proxy appends usage rows fire-and-forget; a worker flush marks them
 * sent/failed. idempotency_key makes both the outbox write and the Stripe
 * API call retry-safe.
 */
export const stripeMeterEvents = pgTable(
  "stripe_meter_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The LLM request this usage record came from, when applicable. */
    requestId: text("request_id"),
    eventName: text("event_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: stripeMeterEventStatusEnum("status").notNull().default("pending"),
    /** Stripe-side event id once accepted. */
    stripeEventId: text("stripe_event_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("stripe_meter_events_workspace_status_idx").on(t.workspaceId, t.status)],
);

export type StripeMeterEventRow = typeof stripeMeterEvents.$inferSelect;
export type NewStripeMeterEventRow = typeof stripeMeterEvents.$inferInsert;
