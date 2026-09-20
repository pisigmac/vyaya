import type { EncryptedPayload } from "@vyaya/core";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { requestLogs } from "./request-logs.js";
import { workspaces } from "./workspaces.js";

/**
 * AES-256-GCM-encrypted prompt/response bodies. Written ONLY when the
 * workspace has log_bodies_enabled (LOG_BODIES opt-in). Each envelope is an
 * EncryptedPayload from @vyaya/core: base64 ciphertext + 12-byte IV +
 * 16-byte GCM auth tag, encrypted under the workspace DEK.
 *
 * Retention: the worker's sweeper deletes rows once expires_at passes
 * (default 7 days, BODY_RETENTION_DAYS).
 */
export const requestBodies = pgTable(
  "request_bodies",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => requestLogs.requestId, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    promptEnvelope: jsonb("prompt_envelope").$type<EncryptedPayload>().notNull(),
    /** Null when the upstream errored before producing a response body. */
    responseEnvelope: jsonb("response_envelope").$type<EncryptedPayload>(),
    /** Plaintext byte sizes, for retention/backpressure accounting. */
    promptBytes: integer("prompt_bytes").notNull(),
    responseBytes: integer("response_bytes"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("request_bodies_workspace_expiry_idx").on(t.workspaceId, t.expiresAt)],
);

export type RequestBodyRow = typeof requestBodies.$inferSelect;
export type NewRequestBodyRow = typeof requestBodies.$inferInsert;
