import type { WasteEvent } from "../types.js";
import {
  byTimeThenId,
  makeWasteEvent,
  type DetectorContext,
  type WasteDetector,
} from "./interface.js";

/**
 * ghost_output — the response was generated (and paid for) but never
 * consumed downstream: logged but unretrieved, or a client-side discard
 * signal was recorded.
 *
 * Rule: status success, responseConsumed === false, and the request is at
 * least ghostOutputMinAgeMs old (younger requests may still be in flight).
 * One waste event per qualifying request; the full call cost is wasted.
 */
export class GhostOutputDetector implements WasteDetector {
  readonly name = "ghost_output" as const;
  readonly version = "1.0.0";

  detect(ctx: DetectorContext): WasteEvent[] {
    const events: WasteEvent[] = [];
    const logs = [...ctx.logs].sort(byTimeThenId);
    for (const log of logs) {
      if (log.status !== "success") continue;
      if (log.responseConsumed) continue;
      const ageMs = ctx.nowMs - log.occurredAtMs;
      if (ageMs < ctx.thresholds.ghostOutputMinAgeMs) continue;
      events.push(
        makeWasteEvent(
          ctx,
          this,
          [log.requestId],
          log.costUsd,
          {
            summary: `Response for ${log.requestId} was never consumed.`,
            model: log.model,
            endpoint: log.endpoint,
            ageMs,
            promptTokens: log.promptTokens,
            completionTokens: log.completionTokens,
            minAgeMs: ctx.thresholds.ghostOutputMinAgeMs,
          },
          "The client never read this response. Cancel in-flight requests on unmount and stop speculative pre-generation.",
        ),
      );
    }
    return events;
  }
}
