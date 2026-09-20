import type { RequestLog, WasteEvent } from "../types.js";
import {
  byTimeThenId,
  makeWasteEvent,
  type DetectorContext,
  type WasteDetector,
} from "./interface.js";

/**
 * retry_storm — >= retryStormMinAttempts identical prompt_hash calls within
 * retryStormWindowMs where a later attempt succeeded. Every attempt before
 * the first success in the cluster is wasted spend.
 *
 * Deterministic: attempts are sorted by (time, requestId); the cluster is
 * the maximal run starting at the first unprocessed attempt whose span fits
 * the window. One event per cluster.
 */
export class RetryStormDetector implements WasteDetector {
  readonly name = "retry_storm" as const;
  readonly version = "1.0.0";

  detect(ctx: DetectorContext): WasteEvent[] {
    const { retryStormMinAttempts, retryStormWindowMs } = ctx.thresholds;
    const byHash = new Map<string, RequestLog[]>();
    for (const log of ctx.logs) {
      const bucket = byHash.get(log.promptHash);
      if (bucket === undefined) byHash.set(log.promptHash, [log]);
      else bucket.push(log);
    }

    const events: WasteEvent[] = [];
    const hashes = [...byHash.keys()].sort();
    for (const hash of hashes) {
      const attempts = (byHash.get(hash) as RequestLog[]).sort(byTimeThenId);
      const n = attempts.length;
      let i = 0;
      while (i < n) {
        const start = attempts[i] as RequestLog;
        let j = i;
        while (
          j + 1 < n &&
          (attempts[j + 1] as RequestLog).occurredAtMs - start.occurredAtMs <=
            retryStormWindowMs
        ) {
          j += 1;
        }
        const cluster = attempts.slice(i, j + 1);
        if (cluster.length >= retryStormMinAttempts) {
          const firstSuccessIdx = cluster.findIndex(
            (a) => a.status === "success",
          );
          if (firstSuccessIdx > 0) {
            const wasted = cluster.slice(0, firstSuccessIdx);
            const succeeded = cluster[firstSuccessIdx] as RequestLog;
            const dollarsWasted = wasted.reduce((s, a) => s + a.costUsd, 0);
            events.push(
              makeWasteEvent(
                ctx,
                this,
                wasted.map((a) => a.requestId),
                dollarsWasted,
                {
                  summary: `${cluster.length} identical calls within ${retryStormWindowMs}ms; attempt ${succeeded.requestId} succeeded after ${wasted.length} wasted attempt(s).`,
                  promptHash: hash,
                  attemptCount: cluster.length,
                  windowMs: retryStormWindowMs,
                  minAttempts: retryStormMinAttempts,
                  wastedAttemptIds: wasted.map((a) => a.requestId),
                  succeededRequestId: succeeded.requestId,
                },
                "Identical prompts are being retried within seconds. Add idempotency keys with exponential backoff and dedupe identical in-flight requests.",
              ),
            );
            i = j + 1;
            continue;
          }
        }
        i += 1;
      }
    }
    return events;
  }
}
