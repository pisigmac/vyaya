import { PRICE_TABLE_VERSION, resolveModelPrice } from "./price-table.js";
import type { ModelPrice } from "./price-table.js";

export class UnknownModelPriceError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(
      `no price table entry for model ${JSON.stringify(model)} — add it to packages/core/src/cost/price-table.ts`,
    );
    this.name = "UnknownModelPriceError";
    this.model = model;
  }
}

export interface CostBreakdown {
  model: string;
  promptTokens: number;
  completionTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  price: ModelPrice;
  priceTableVersion: string;
}

export interface ComputeCostInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Pricing date; defaults to now. Pass the request timestamp for logs. */
  at?: Date;
}

/**
 * Compute the cost of one LLM call from the versioned price table.
 * Costs are always computed here, server-side — never trusted from clients.
 *
 * Deterministic: integer token counts in, USD out. Results are rounded to
 * 8 decimal places (hundredths of a micro-dollar) to kill float noise while
 * staying exact for any realistic token count.
 */
export function computeCost(input: ComputeCostInput): CostBreakdown {
  const at = input.at ?? new Date();
  const price = resolveModelPrice(input.model, at);
  if (price === undefined) {
    throw new UnknownModelPriceError(input.model);
  }
  const inputCostUsd = roundUsd(
    (input.promptTokens * price.inputPer1MTokens) / 1_000_000,
  );
  const outputCostUsd = roundUsd(
    (input.completionTokens * price.outputPer1MTokens) / 1_000_000,
  );
  return {
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: roundUsd(inputCostUsd + outputCostUsd),
    price,
    priceTableVersion: PRICE_TABLE_VERSION,
  };
}

/** Round to 8 decimal places deterministically. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
