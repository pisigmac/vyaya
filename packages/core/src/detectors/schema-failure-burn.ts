import type { WasteEvent } from "../types.js";
import {
  byTimeThenId,
  makeWasteEvent,
  type DetectorContext,
  type WasteDetector,
} from "./interface.js";

/**
 * schema_failure_burn — the response failed JSON-schema / response_format
 * validation. The full generation cost is written off. One event per
 * qualifying request.
 *
 * Rule: schemaValidation === "failed" and status === "success" (the provider
 * generated — and billed — a completion that failed validation downstream).
 */
export class SchemaFailureBurnDetector implements WasteDetector {
  readonly name = "schema_failure_burn" as const;
  readonly version = "1.0.0";

  detect(ctx: DetectorContext): WasteEvent[] {
    const events: WasteEvent[] = [];
    const logs = [...ctx.logs].sort(byTimeThenId);
    for (const log of logs) {
      if (log.schemaValidation !== "failed") continue;
      if (log.status !== "success") continue;
      events.push(
        makeWasteEvent(
          ctx,
          this,
          [log.requestId],
          log.costUsd,
          {
            summary: `Response for ${log.requestId} failed schema validation; full generation cost written off.`,
            model: log.model,
            endpoint: log.endpoint,
            promptTokens: log.promptTokens,
            completionTokens: log.completionTokens,
          },
          "Responses are failing schema validation and the generation cost is lost. Use constrained decoding (response_format or tool use) instead of re-parsing free-form output.",
        ),
      );
    }
    return events;
  }
}
