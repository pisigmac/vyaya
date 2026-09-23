import { createDb, type DbHandle } from "@vyaya/db/client";

/**
 * Memoized database handle. Route handlers and server components share one
 * pool per process; globalThis survives Next.js dev-mode module reloads.
 */
const globalForDb = globalThis as unknown as { __vyayaDb?: DbHandle };

export function getDb(): DbHandle {
  globalForDb.__vyayaDb ??= createDb();
  return globalForDb.__vyayaDb;
}
