import type { RequestLog } from "../types.js";

/**
 * LogSink — the request-log write path behind an interface.
 *
 * Hard proxy contract: logging NEVER blocks, mutates, or fails a user
 * request. Sink implementations surface errors as typed exceptions or
 * swallowed retries; proxy health is independent of sink health.
 */
export interface LogSink {
  write(log: RequestLog): Promise<void>;
  /** Liveness signal for health endpoints and the retry queue. */
  healthy(): boolean;
}

export class LogSinkWriteError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LogSinkWriteError";
  }
}
