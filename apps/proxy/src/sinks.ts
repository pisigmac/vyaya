import type { LogSink, RequestLog, SqlQueryFn } from "@vyaya/core";
import { PostgresLogSink } from "@vyaya/core";
import { scopedQueryFn } from "@vyaya/db";
import type postgres from "postgres";

/**
 * Multi-tenant Postgres sink adapter.
 *
 * PostgresLogSink takes a single SqlQueryFn, but scopedQueryFn binds one
 * workspace (it sets the RLS GUC inside the insert transaction). This
 * adapter keeps one PostgresLogSink per workspace and dispatches on
 * log.workspaceId, so one proxy process can serve every tenant while each
 * write stays workspace-scoped.
 *
 * The RetryQueueLogSink wraps this; retry/backpressure semantics live in
 * @vyaya/core.
 */
export class WorkspacePostgresLogSink implements LogSink {
  readonly #client: postgres.Sql;
  readonly #sinks = new Map<string, PostgresLogSink>();

  constructor(client: postgres.Sql) {
    this.#client = client;
  }

  write(log: RequestLog): Promise<void> {
    let sink = this.#sinks.get(log.workspaceId);
    if (sink === undefined) {
      const query: SqlQueryFn = scopedQueryFn(this.#client, log.workspaceId);
      sink = new PostgresLogSink({ query });
      this.#sinks.set(log.workspaceId, sink);
    }
    return sink.write(log);
  }

  /** Aggregate health: unhealthy only when every workspace sink is failing. */
  healthy(): boolean {
    for (const sink of this.#sinks.values()) {
      if (sink.healthy()) return true;
    }
    return this.#sinks.size === 0 ? true : false;
  }
}
