import { loadDbEnv } from "@vyaya/config";
import type { SqlQueryFn } from "@vyaya/core";
import { sql as dsql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import * as schema from "./schema/index.js";

/**
 * Database client for every Vyaya service.
 *
 * Tenant isolation model (see rls/policies.sql):
 *   * Postgres RLS (ENABLE + FORCE) on every tenant table. Policies compare
 *     workspace_id against the transaction-local GUC app.workspace_id.
 *   * withWorkspace() opens a transaction, sets the GUC with SET LOCAL
 *     (via set_config(..., true)), and runs the callback inside. All tenant
 *     reads/writes go through it — there is no unscoped query path.
 *   * The worker's service path: listWorkspaceIds() as vyaya_service (the
 *     only role allowed to enumerate workspaces), then withWorkspace() per
 *     workspace it processes. Tenant rows stay DB-scoped even for the
 *     service role.
 */

export const WORKSPACE_GUC = "app.workspace_id";

export type VyayaSchema = typeof schema;
export type VyayaDatabase = PostgresJsDatabase<VyayaSchema>;
/** Transaction handle handed to withWorkspace callbacks. */
export type VyayaTx = Parameters<
  Parameters<VyayaDatabase["transaction"]>[0]
>[0];

export interface DbHandle {
  /** Raw postgres.js client (use for close, LISTEN, unsafe escape hatches). */
  client: postgres.Sql;
  /** Drizzle query interface. */
  db: VyayaDatabase;
}

export interface CreateDbOptions {
  /** Defaults to DATABASE_URL via @vyaya/config (loadDbEnv). */
  databaseUrl?: string;
  /** postgres.js pool size. Default 10. */
  maxConnections?: number;
}

export function createDb(options: CreateDbOptions = {}): DbHandle {
  const databaseUrl = options.databaseUrl ?? loadDbEnv().databaseUrl;
  const client = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    // Never log bind parameter values — request metadata is not sensitive,
    // but prompt bodies must never reach logs, even in error output.
    onnotice: () => {},
  });
  return { client, db: drizzle(client, { schema }) };
}

export async function closeDb(handle: DbHandle): Promise<void> {
  await handle.client.end({ timeout: 5 });
}

const uuidSchema = z.uuid();

/**
 * Run `fn` inside a transaction scoped to one workspace. Sets
 * `SET LOCAL app.workspace_id` (parameterised — never string-interpolated)
 * before any other statement, so RLS policies see exactly one tenant and
 * the setting can never leak outside the transaction.
 */
export async function withWorkspace<T>(
  handle: DbHandle | VyayaDatabase,
  workspaceId: string,
  fn: (tx: VyayaTx) => Promise<T>,
): Promise<T> {
  const id = uuidSchema.parse(workspaceId);
  const db = isHandle(handle) ? handle.db : handle;
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config(${WORKSPACE_GUC}, ${id}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Enumerate tenant ids. Only returns rows when the connection can read the
 * workspaces table: the vyaya_service role (worker) or a superuser/owner
 * (migrations, dev). As vyaya_app this returns only the workspace the GUC
 * is set to — services should never call it.
 */
export async function listWorkspaceIds(
  handle: DbHandle | VyayaDatabase,
): Promise<string[]> {
  const db = isHandle(handle) ? handle.db : handle;
  const rows = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .orderBy(schema.workspaces.createdAt, schema.workspaces.id);
  return rows.map((r) => r.id);
}

/**
 * Adapter from a postgres.js client to the SqlQueryFn that
 * PostgresLogSink (@vyaya/core) expects. Each write runs in its own
 * workspace-scoped transaction so the RLS WITH CHECK passes. The sink's
 * insert text is a static string built from an identifier-validated table
 * name with positional parameters — this path stays fully parameterised.
 */
export function scopedQueryFn(
  client: postgres.Sql,
  workspaceId: string,
): SqlQueryFn {
  const id = uuidSchema.parse(workspaceId);
  return async (text, params) => {
    await client.begin(async (tx) => {
      await tx`SELECT set_config(${WORKSPACE_GUC}, ${id}, true)`;
      // The sink's insert text is a fixed identifier-validated string with
      // positional parameters (built once in @vyaya/core); values pass
      // through the driver untouched.
      await tx.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    });
  };
}

function isHandle(handle: DbHandle | VyayaDatabase): handle is DbHandle {
  return "client" in handle;
}
