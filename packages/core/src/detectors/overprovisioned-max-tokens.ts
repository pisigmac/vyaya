import type { RequestLog, WasteEvent } from "../types.js";
import {
  byTimeThenId,
  makeWasteEvent,
  type DetectorContext,
  type WasteDetector,
} from "./interface.js";

/**
 * overprovisioned_max_tokens — completion_tokens consistently below
 * overprovisionedMaxRatio of requested max_tokens across a rolling window
 * of at least overprovisionedMinCalls calls, per model.
 *
 * Rule: scan calls (with maxTokens set) in time order; a maximal run of
 * consecutive calls all below the ratio whose length >= minCalls is one
 * waste event. "Consistently" means every call in the run is below the
 * ratio (strictly).
 *
 * dollars_wasted estimates reservation overhead: excess provisioned output
 * tokens (maxTokens - completionTokens) valued at the call's inferred
 * output price, times overprovisionedReservationOverhead. Calls with zero
 * completions contribute nothing (no price signal to infer from).
 */
export class OverprovisionedMaxTokensDetector implements WasteDetector {
  readonly name = "overprovisioned_max_tokens" as const;
  readonly version = "1.0.0";

  detect(ctx: DetectorContext): WasteEvent[] {
    const {
      overprovisionedMinCalls,
      overprovisionedMaxRatio,
      overprovisionedReservationOverhead,
    } = ctx.thresholds;

    const byModel = new Map<string, RequestLog[]>();
    for (const log of ctx.logs) {
      if (log.maxTokens === null || log.maxTokens <= 0) continue;
      const bucket = byModel.get(log.model);
      if (bucket === undefined) byModel.set(log.model, [log]);
      else bucket.push(log);
    }

    const events: WasteEvent[] = [];
    const models = [...byModel.keys()].sort();
    for (const model of models) {
      const calls = (byModel.get(model) as RequestLog[]).sort(byTimeThenId);
      let run: RequestLog[] = [];
      const flush = () => {
        if (run.length >= overprovisionedMinCalls) {
          events.push(this.#eventForRun(ctx, model, run));
        }
        run = [];
      };
      for (const call of calls) {
        const maxTokens = call.maxTokens as number;
        if (call.completionTokens / maxTokens < overprovisionedMaxRatio) {
          run.push(call);
        } else {
          flush();
        }
      }
      flush();
    }
    return events;
  }

  #eventForRun(
    ctx: DetectorContext,
    model: string,
    run: RequestLog[],
  ): WasteEvent {
    const { overprovisionedMaxRatio, overprovisionedMinCalls } = ctx.thresholds;
    let dollars = 0;
    let ratioSum = 0;
    let excessTokenSum = 0;
    for (const call of run) {
      const maxTokens = call.maxTokens as number;
      const excessTokens = maxTokens - call.completionTokens;
      const outputPricePerToken =
        call.completionTokens > 0
          ? call.outputCostUsd / call.completionTokens
          : 0;
      dollars +=
        excessTokens *
        outputPricePerToken *
        ctx.thresholds.overprovisionedReservationOverhead;
      ratioSum += call.completionTokens / maxTokens;
      excessTokenSum += excessTokens;
    }
    const avgRatio = ratioSum / run.length;
    return makeWasteEvent(
      ctx,
      this,
      run.map((c) => c.requestId),
      dollars,
      {
        summary: `${run.length} consecutive ${model} calls completed under ${overprovisionedMaxRatio} of requested max_tokens.`,
        model,
        callCount: run.length,
        minCalls: overprovisionedMinCalls,
        ratioThreshold: overprovisionedMaxRatio,
        avgCompletionRatio: Math.round(avgRatio * 1e6) / 1e6,
        excessProvisionedOutputTokens: excessTokenSum,
        reservationOverhead: ctx.thresholds.overprovisionedReservationOverhead,
      },
      "max_tokens sits far above observed completions. Lower max_tokens to match real output lengths and re-check after a week.",
    );
  }
}
