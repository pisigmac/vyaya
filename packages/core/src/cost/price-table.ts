/**
 * Versioned model price table. Prices are USD per 1M tokens.
 *
 * Versioning rule: multiple rows may exist per model with different
 * effectiveFrom dates (YYYY-MM-DD, UTC). Resolution picks the latest row
 * whose effectiveFrom is <= the request date, so historical request_log
 * costs stay reproducible after a repricing.
 *
 * Figures reflect public list prices at the time of writing; treat the
 * table as data to be reviewed on each provider price change.
 */
export interface ModelPrice {
  model: string;
  /** USD per 1M input (prompt) tokens. */
  inputPer1MTokens: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1MTokens: number;
  /** ISO date (YYYY-MM-DD) from which this price applies, inclusive. */
  effectiveFrom: string;
}

/** Version of the table itself; bumped on any price edit. */
export const PRICE_TABLE_VERSION = "2026-01-01.v1";

export const PRICE_TABLE: readonly ModelPrice[] = [
  // --- gpt-4o ---
  {
    model: "gpt-4o",
    inputPer1MTokens: 2.5,
    outputPer1MTokens: 10.0,
    effectiveFrom: "2025-06-01",
  },
  {
    model: "gpt-4o",
    inputPer1MTokens: 2.0,
    outputPer1MTokens: 8.0,
    effectiveFrom: "2026-01-01",
  },
  // --- gpt-4o-mini ---
  {
    model: "gpt-4o-mini",
    inputPer1MTokens: 0.15,
    outputPer1MTokens: 0.6,
    effectiveFrom: "2025-06-01",
  },
  // --- gpt-4.1 ---
  {
    model: "gpt-4.1",
    inputPer1MTokens: 2.0,
    outputPer1MTokens: 8.0,
    effectiveFrom: "2025-06-01",
  },
  // --- o4-mini ---
  {
    model: "o4-mini",
    inputPer1MTokens: 1.1,
    outputPer1MTokens: 4.4,
    effectiveFrom: "2025-06-01",
  },
  // --- embeddings (input-only pricing; output is always 0) ---
  {
    model: "text-embedding-3-small",
    inputPer1MTokens: 0.02,
    outputPer1MTokens: 0,
    effectiveFrom: "2025-06-01",
  },
  {
    model: "text-embedding-3-large",
    inputPer1MTokens: 0.13,
    outputPer1MTokens: 0,
    effectiveFrom: "2025-06-01",
  },
];

function toDayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

function toDayKey(d: Date): number {
  const day = d.toISOString().slice(0, 10);
  return toDayMs(day);
}

/**
 * Resolve the price for a model at a point in time (defaults to now).
 * Returns undefined when the model is unknown or no row was effective yet
 * at `at` — callers must treat undefined as "cannot price", never guess.
 */
export function resolveModelPrice(
  model: string,
  at: Date = new Date(),
): ModelPrice | undefined {
  const dayMs = toDayKey(at);
  let best: ModelPrice | undefined;
  for (const row of PRICE_TABLE) {
    if (row.model !== model) continue;
    const rowMs = toDayMs(row.effectiveFrom);
    if (rowMs > dayMs) continue;
    if (best === undefined || toDayMs(best.effectiveFrom) < rowMs) {
      best = row;
    }
  }
  return best;
}

/** All distinct effectiveFrom dates in the table, ascending. */
export function listPriceVersions(): string[] {
  const versions = new Set(PRICE_TABLE.map((r) => r.effectiveFrom));
  return [...versions].sort();
}

/** All models with at least one price row, ascending. */
export function listPricedModels(): string[] {
  const models = new Set(PRICE_TABLE.map((r) => r.model));
  return [...models].sort();
}
