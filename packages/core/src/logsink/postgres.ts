import type { RequestLog } from "../types.js";
import { LogSinkWriteError, type LogSink } from "./interface.js";

/**
 * Minimal query function injected by the caller. @vyaya/db (Drizzle) adapts
 * its pool to this signature; tests pass a fake. This package never imports
 * @vyaya/db — dependency direction stays config/db -> core, never reverse.
 */
export type SqlQueryFn = (
  text: string,
  params: readonly unknown[],
) => Promise<unknown>;

export interface PostgresLogSinkOptions {
  query: SqlQueryFn;
  /** Table name — must match ^[A-Za-z_][A-Za-z0-9_]*$ (identifier safety). */
  table?: string;
  /** Consecutive write failures before healthy() reports false. */
  maxConsecutiveFailures?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const COLUMNS = [
  "request_id",
  "workspace_id",
  "occurred_at",
  "model",
  "endpoint",
  "latency_ms",
  "prompt_tokens",
  "completion_tokens",
  "max_tokens",
  "cost_usd",
  "input_cost_usd",
  "output_cost_usd",
  "prompt_hash",
  "session_id",
  "feature_tag",
  "status",
  "schema_validation",
  "retry_attempt",
  "retry_of",
  "response_consumed",
] as const;

/** Default sink: Postgres, fully working without any optional dependency. */
export class PostgresLogSink implements LogSink {
  readonly #query: SqlQueryFn;
  readonly #table: string;
  readonly #maxConsecutiveFailures: number;
  readonly #insertSql: string;
  #consecutiveFailures = 0;

  constructor(options: PostgresLogSinkOptions) {
    this.#query = options.query;
    this.#table = options.table ?? "request_logs";
    if (!IDENTIFIER.test(this.#table)) {
      throw new Error(`unsafe table name: ${JSON.stringify(this.#table)}`);
    }
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
    this.#insertSql =
      `INSERT INTO ${this.#table} (${COLUMNS.join(", ")}) VALUES (${placeholders}) ` +
      `ON CONFLICT (request_id) DO NOTHING`;
  }

  /**
   * Bodies are never written here — prompt/response ciphertexts live in a
   * separate opt-in path (envelope-encrypted, LOG_BODIES gated).
   */
  async write(log: RequestLog): Promise<void> {
    const params: readonly unknown[] = [
      log.requestId,
      log.workspaceId,
      new Date(log.occurredAtMs).toISOString(),
      log.model,
      log.endpoint,
      log.latencyMs,
      log.promptTokens,
      log.completionTokens,
      log.maxTokens,
      log.costUsd,
      log.inputCostUsd,
      log.outputCostUsd,
      log.promptHash,
      log.sessionId,
      log.featureTag,
      log.status,
      log.schemaValidation,
      log.retryAttempt,
      log.retryOf,
      log.responseConsumed,
    ];
    try {
      await this.#query(this.#insertSql, params);
      this.#consecutiveFailures = 0;
    } catch (err) {
      this.#consecutiveFailures += 1;
      throw new LogSinkWriteError(
        `postgres request log insert failed for ${log.requestId}`,
        err,
      );
    }
  }

  healthy(): boolean {
    return this.#consecutiveFailures < this.#maxConsecutiveFailures;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }
}
