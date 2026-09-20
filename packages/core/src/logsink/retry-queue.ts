import type { RequestLog } from "../types.js";
import type { LogSink } from "./interface.js";

/**
 * RetryQueueLogSink — fire-and-forget wrapper around a real sink.
 *
 * Contract: write() NEVER rejects and never blocks the proxy. Logs queue in
 * memory; a background flush drains them to the inner sink. Under
 * backpressure (queue full), the oldest entry is dropped — the proxy must
 * shed load rather than grow memory without bound. Failed writes retry up
 * to maxWriteAttempts, then drop. All drops/retries are counted in metrics.
 *
 * healthy() is always true by design: proxy health is independent of
 * DB/Redis/ClickHouse health. Observe metrics() for the real story.
 */

export interface RetryQueueMetrics {
  enqueued: number;
  written: number;
  /** Dropped because the queue was full (backpressure). */
  droppedBackpressure: number;
  /** Dropped after exhausting write attempts. */
  droppedExhausted: number;
  writeFailures: number;
  flushCount: number;
  queueDepth: number;
}

export interface RetryQueueOptions {
  maxQueueSize?: number;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxWriteAttempts?: number;
}

interface QueueEntry {
  log: RequestLog;
  attempts: number;
}

const DEFAULTS = {
  maxQueueSize: 10_000,
  flushIntervalMs: 1_000,
  maxBatchSize: 500,
  maxWriteAttempts: 3,
} as const;

export class RetryQueueLogSink implements LogSink {
  readonly #inner: LogSink;
  readonly #maxQueueSize: number;
  readonly #flushIntervalMs: number;
  readonly #maxBatchSize: number;
  readonly #maxWriteAttempts: number;
  #queue: QueueEntry[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #flushing = false;
  #metrics = {
    enqueued: 0,
    written: 0,
    droppedBackpressure: 0,
    droppedExhausted: 0,
    writeFailures: 0,
    flushCount: 0,
  };

  constructor(inner: LogSink, options: RetryQueueOptions = {}) {
    this.#inner = inner;
    this.#maxQueueSize = options.maxQueueSize ?? DEFAULTS.maxQueueSize;
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.#maxBatchSize = options.maxBatchSize ?? DEFAULTS.maxBatchSize;
    this.#maxWriteAttempts = options.maxWriteAttempts ?? DEFAULTS.maxWriteAttempts;
    if (this.#maxQueueSize < 1) {
      throw new Error("maxQueueSize must be >= 1");
    }
  }

  /** Fire-and-forget: queues the log and resolves. Never rejects. */
  write(log: RequestLog): Promise<void> {
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#queue.shift(); // backpressure: drop oldest
      this.#metrics.droppedBackpressure += 1;
    }
    this.#queue.push({ log, attempts: 0 });
    this.#metrics.enqueued += 1;
    return Promise.resolve();
  }

  /** Start the background flush loop. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    // Never hold the process open for logging.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Drain up to maxBatchSize entries. Retries failures at the tail. */
  async flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      this.#metrics.flushCount += 1;
      // Snapshot the batch: entries requeued during this pass wait for the
      // next one, so a single flush cannot spin on a failing sink.
      const batch = this.#queue.splice(0, this.#maxBatchSize);
      for (const entry of batch) {
        try {
          await this.#inner.write(entry.log);
          this.#metrics.written += 1;
        } catch {
          this.#metrics.writeFailures += 1;
          entry.attempts += 1;
          if (entry.attempts >= this.#maxWriteAttempts) {
            this.#metrics.droppedExhausted += 1;
          } else if (this.#queue.length < this.#maxQueueSize) {
            this.#queue.push(entry);
          } else {
            this.#metrics.droppedBackpressure += 1;
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  healthy(): boolean {
    return true;
  }

  metrics(): RetryQueueMetrics {
    return { ...this.#metrics, queueDepth: this.#queue.length };
  }
}
