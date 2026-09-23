import { schema, type DbHandle } from "@vyaya/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * jobs/deskid-reconcile — poll DeskId's reconciliation feed
 * (GET /v1/admin/reconciliation/events?since_id=...) and apply grant/user
 * changes to the local user_grants_cache, advancing the
 * reconciliation_cursor. Behind DESKID_RECONCILE_ENABLED; a no-op
 * ("disabled") when the flag is off.
 *
 * Idempotent: events are applied in id order inside one transaction that
 * also advances the cursor; a crash rolls both back together, and a rerun
 * simply re-fetches from the last committed cursor. Cursor + cache are
 * service-global tables (see rls/policies-worker.sql), so this job runs
 * unscoped — no workspace GUC.
 */

const reconciliationEventSchema = z.object({
  id: z.number().int().positive(),
  type: z.enum(["user.created", "grant.created"]),
  occurred_at: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const reconciliationFeedSchema = z.object({
  events: z.array(reconciliationEventSchema),
  latest_id: z.number().int().nonnegative(),
});

export type ReconciliationFeed = z.output<typeof reconciliationFeedSchema>;

type FetchLike = typeof fetch;

export interface DeskIdReconcileDeps {
  db: DbHandle;
  enabled: boolean;
  baseUrl: string;
  adminToken: string | undefined;
  logger: Logger;
  fetchFn?: FetchLike;
}

export interface ReconcileResult {
  outcome: "disabled" | "applied";
  eventsApplied: number;
  cursor: number;
}

const CURSOR_ID = "deskid";

export async function runDeskIdReconcile(
  deps: DeskIdReconcileDeps,
): Promise<ReconcileResult> {
  if (!deps.enabled) {
    return { outcome: "disabled", eventsApplied: 0, cursor: 0 };
  }
  const fetchFn = deps.fetchFn ?? fetch;

  const cursorRows = await deps.db.db
    .select({ lastEventId: schema.reconciliationCursor.lastEventId })
    .from(schema.reconciliationCursor)
    .where(sql`${schema.reconciliationCursor.id} = ${CURSOR_ID}`)
    .limit(1);
  const since = cursorRows[0]?.lastEventId ?? 0;

  const url = `${deps.baseUrl.replace(/\/+$/, "")}/v1/admin/reconciliation/events?since_id=${since}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (deps.adminToken !== undefined && deps.adminToken !== "") {
    headers.authorization = `Bearer ${deps.adminToken}`;
  }
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    throw new Error(`deskid reconciliation feed returned ${res.status}`);
  }
  const feed: ReconciliationFeed = reconciliationFeedSchema.parse(await res.json());

  const applied = await deps.db.db.transaction(async (tx) => {
    const emailByUser = new Map<string, string>();
    let count = 0;
    for (const event of feed.events) {
      const userId = event.data["user_id"];
      if (typeof userId !== "string" || userId.length === 0) continue;
      if (event.type === "user.created") {
        const email = event.data["email"];
        if (typeof email === "string" && email.length > 0) {
          emailByUser.set(userId, email);
          await tx
            .update(schema.userGrantsCache)
            .set({ email, updatedAt: new Date(event.occurred_at) })
            .where(sql`${schema.userGrantsCache.deskidSub} = ${userId}`);
        }
        count += 1;
        continue;
      }
      // grant.created
      const audience = event.data["audience"];
      const role = event.data["role"];
      if (typeof audience !== "string" || audience.length === 0) continue;
      if (role !== "admin" && role !== "operator" && role !== "viewer") continue;
      const email =
        emailByUser.get(userId) ??
        (
          await tx
            .select({ email: schema.userGrantsCache.email })
            .from(schema.userGrantsCache)
            .where(sql`${schema.userGrantsCache.deskidSub} = ${userId}`)
            .limit(1)
        )[0]?.email ??
        null;
      await tx
        .insert(schema.userGrantsCache)
        .values({
          deskidSub: userId,
          audience,
          role,
          email,
          updatedAt: new Date(event.occurred_at),
        })
        .onConflictDoUpdate({
          target: [
            schema.userGrantsCache.deskidSub,
            schema.userGrantsCache.audience,
          ],
          set: {
            role,
            email,
            updatedAt: new Date(event.occurred_at),
          },
        });
      count += 1;
    }

    // Advance the cursor to the newest applied event (or latest_id when
    // the feed is empty) in the same transaction as the cache writes.
    const maxApplied = feed.events.reduce((max, e) => Math.max(max, e.id), 0);
    const cursorValue =
      feed.events.length === 0 ? Math.max(since, feed.latest_id) : Math.max(since, maxApplied);
    await tx
      .insert(schema.reconciliationCursor)
      .values({ id: CURSOR_ID, lastEventId: cursorValue, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.reconciliationCursor.id],
        set: { lastEventId: cursorValue, updatedAt: new Date() },
      });
    return count;
  });

  const after = await deps.db.db
    .select({ lastEventId: schema.reconciliationCursor.lastEventId })
    .from(schema.reconciliationCursor)
    .where(sql`${schema.reconciliationCursor.id} = ${CURSOR_ID}`)
    .limit(1);

  deps.logger.info(
    { eventsApplied: applied, cursor: after[0]?.lastEventId ?? since },
    "deskid reconcile done",
  );
  return {
    outcome: "applied",
    eventsApplied: applied,
    cursor: after[0]?.lastEventId ?? since,
  };
}
