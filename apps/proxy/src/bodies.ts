import type { EncryptedPayload, WrappedDek } from "@vyaya/core";
import { EnvelopeCipher } from "@vyaya/core";
import type { Logger } from "pino";
import type postgres from "postgres";

/**
 * Opt-in prompt/response body storage.
 *
 * Bodies are stored ONLY when all of these hold (documented in
 * docs/ASSUMPTIONS.md):
 *   1. proxy env LOG_BODIES=true (service-level kill switch)
 *   2. the workspace has log_bodies_enabled (per-workspace opt-in)
 *   3. the workspace has a wrapped DEK (created on opt-in)
 *
 * Encryption happens here, before anything touches the sink: AES-256-GCM
 * under the workspace DEK (unwrapped with the env master key). Plaintext
 * bodies never reach pino or stdout.
 *
 * Writes are fire-and-forget with a bounded in-memory retry: the insert
 * must land after the request_logs row it references, which flushes
 * asynchronously through the retry queue, so FK races simply retry. After
 * maxAttempts the body row is dropped (counted); the request log row is
 * never affected.
 */

/** Matches the worker's BODY_RETENTION_DAYS default (7 days). */
export const BODY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BodyRow {
  requestId: string;
  workspaceId: string;
  promptBody: string;
  responseBody: string | null;
  wrappedDek: WrappedDek;
}

export interface BodyStoreOptions {
  flushIntervalMs?: number;
  maxAttempts?: number;
  maxQueueSize?: number;
  now?: () => number;
}

interface QueueEntry {
  row: BodyRow;
  attempts: number;
}

export class PostgresBodyStore {
  readonly #client: postgres.Sql;
  readonly #cipher: EnvelopeCipher;
  readonly #logger: Logger;
  readonly #flushIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #maxQueueSize: number;
  readonly #now: () => number;
  readonly #deks = new Map<string, Buffer>();
  #queue: QueueEntry[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #flushing = false;
  #written = 0;
  #dropped = 0;
  #failures = 0;

  constructor(
    client: postgres.Sql,
    masterKeyHex: string,
    logger: Logger,
    options: BodyStoreOptions = {},
  ) {
    this.#client = client;
    this.#cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(masterKeyHex));
    this.#logger = logger;
    this.#flushIntervalMs = options.flushIntervalMs ?? 500;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#maxQueueSize = options.maxQueueSize ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /** Fire-and-forget enqueue. Never throws, never blocks the request. */
  store(row: BodyRow): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push({ row, attempts: 0 });
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const batch = this.#queue.splice(0, this.#queue.length);
      for (const entry of batch) {
        try {
          await this.#write(entry.row);
          this.#written += 1;
        } catch (err) {
          this.#failures += 1;
          entry.attempts += 1;
          this.#logger.warn(
            { err, requestId: entry.row.requestId, attempt: entry.attempts },
            "body row write failed",
          );
          if (entry.attempts >= this.#maxAttempts) {
            this.#dropped += 1;
            this.#logger.warn(
              { requestId: entry.row.requestId },
              "dropping body row after repeated write failures",
            );
          } else if (this.#queue.length < this.#maxQueueSize) {
            this.#queue.push(entry);
          } else {
            this.#dropped += 1;
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  metrics(): { written: number; dropped: number; failures: number; queueDepth: number } {
    return {
      written: this.#written,
      dropped: this.#dropped,
      failures: this.#failures,
      queueDepth: this.#queue.length,
    };
  }

  #dek(row: BodyRow): Buffer {
    let dek = this.#deks.get(row.workspaceId);
    if (dek === undefined) {
      dek = this.#cipher.unwrapDek(row.wrappedDek);
      this.#deks.set(row.workspaceId, dek);
    }
    return dek;
  }

  async #write(row: BodyRow): Promise<void> {
    const dek = this.#dek(row);
    const aad = Buffer.from(row.workspaceId, "utf8");
    const promptEnvelope: EncryptedPayload = this.#cipher.encryptText(
      dek,
      row.promptBody,
      aad,
    );
    const responseEnvelope: EncryptedPayload | null =
      row.responseBody === null
        ? null
        : this.#cipher.encryptText(dek, row.responseBody, aad);
    const expiresAt = new Date(this.#now() + BODY_TTL_MS).toISOString();
    // unsafe + prepare:false + explicit ::jsonb casts: the prepared-statement
    // path re-applies the jsonb serializer to already-stringified values
    // (double-encode), and sql.json Parameter objects are fragile when the
    // client module instance differs from the query's (vite-node inlining
    // of workspace packages). Text + server-side cast is unambiguous.
    await this.#client.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [
        row.workspaceId,
      ]);
      await tx.unsafe(
        `INSERT INTO request_bodies
          (request_id, workspace_id, prompt_envelope, response_envelope,
           prompt_bytes, response_bytes, expires_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
        ON CONFLICT (request_id) DO NOTHING`,
        [
          row.requestId,
          row.workspaceId,
          JSON.stringify(promptEnvelope),
          responseEnvelope === null ? null : JSON.stringify(responseEnvelope),
          Buffer.byteLength(row.promptBody, "utf8"),
          row.responseBody === null
            ? null
            : Buffer.byteLength(row.responseBody, "utf8"),
          expiresAt,
        ],
        { prepare: false },
      );
    });
  }
}
