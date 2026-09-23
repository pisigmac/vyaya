import type { RequestLog } from "../types.js";
import { LogSinkWriteError, type LogSink } from "./interface.js";

/**
 * ClickHouse HTTP sink. Config-gated: the proxy only constructs this when
 * CLICKHOUSE_URL is set; otherwise PostgresLogSink is used. Writes one
 * JSONEachRow insert per log (the retry queue batches flushes upstream).
 */

export interface ClickHouseLogSinkOptions {
  /** Base HTTP endpoint, e.g. http://localhost:8123 */
  url: string;
  database?: string;
  table?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  maxConsecutiveFailures?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ClickHouseLogSink implements LogSink {
  readonly #url: string;
  readonly #database: string;
  readonly #table: string;
  readonly #fetch: typeof fetch;
  readonly #maxConsecutiveFailures: number;
  #consecutiveFailures = 0;

  constructor(options: ClickHouseLogSinkOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#database = options.database ?? "vyaya";
    this.#table = options.table ?? "request_logs";
    for (const ident of [this.#database, this.#table]) {
      if (!IDENTIFIER.test(ident)) {
        throw new Error(`unsafe ClickHouse identifier: ${JSON.stringify(ident)}`);
      }
    }
    this.#fetch = options.fetchFn ?? fetch;
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  async write(log: RequestLog): Promise<void> {
    const row = {
      request_id: log.requestId,
      workspace_id: log.workspaceId,
      occurred_at: new Date(log.occurredAtMs)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
      model: log.model,
      endpoint: log.endpoint,
      latency_ms: log.latencyMs,
      prompt_tokens: log.promptTokens,
      completion_tokens: log.completionTokens,
      max_tokens: log.maxTokens,
      cost_usd: log.costUsd,
      input_cost_usd: log.inputCostUsd,
      output_cost_usd: log.outputCostUsd,
      prompt_hash: log.promptHash,
      session_id: log.sessionId,
      feature_tag: log.featureTag,
      status: log.status,
      schema_validation: log.schemaValidation,
      retry_attempt: log.retryAttempt,
      retry_of: log.retryOf,
      response_consumed: log.responseConsumed ? 1 : 0,
    };
    const query = encodeURIComponent(
      `INSERT INTO ${this.#database}.${this.#table} FORMAT JSONEachRow`,
    );
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}/?query=${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${JSON.stringify(row)}\n`,
      });
    } catch (err) {
      this.#consecutiveFailures += 1;
      throw new LogSinkWriteError(
        `clickhouse insert failed for ${log.requestId}`,
        err,
      );
    }
    if (!res.ok) {
      this.#consecutiveFailures += 1;
      throw new LogSinkWriteError(
        `clickhouse insert returned HTTP ${res.status}`,
      );
    }
    this.#consecutiveFailures = 0;
  }

  healthy(): boolean {
    return this.#consecutiveFailures < this.#maxConsecutiveFailures;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }
}
