import { describe, expect, it } from "vitest";
import {
  listPriceVersions,
  listPricedModels,
  PRICE_TABLE,
  PRICE_TABLE_VERSION,
  resolveModelPrice,
} from "./price-table.js";
import {
  computeCost,
  roundUsd,
  UnknownModelPriceError,
} from "./compute-cost.js";

describe("price table", () => {
  it("contains the required models", () => {
    expect(listPricedModels()).toEqual([
      "gpt-4.1",
      "gpt-4o",
      "gpt-4o-mini",
      "o4-mini",
      "text-embedding-3-large",
      "text-embedding-3-small",
    ]);
  });

  it("lists versions in ascending order", () => {
    expect(listPriceVersions()).toEqual(["2025-06-01", "2026-01-01"]);
  });

  it("resolves the price effective at a given date (versioning)", () => {
    const before = resolveModelPrice("gpt-4o", new Date("2025-08-15T12:00:00Z"));
    const after = resolveModelPrice("gpt-4o", new Date("2026-02-01T12:00:00Z"));
    expect(before?.inputPer1MTokens).toBe(2.5);
    expect(after?.inputPer1MTokens).toBe(2.0);
    expect(before?.effectiveFrom).toBe("2025-06-01");
    expect(after?.effectiveFrom).toBe("2026-01-01");
  });

  it("treats the effectiveFrom day itself as effective", () => {
    const onDay = resolveModelPrice("gpt-4o", new Date("2026-01-01T00:30:00Z"));
    expect(onDay?.inputPer1MTokens).toBe(2.0);
  });

  it("returns undefined before any row is effective", () => {
    expect(
      resolveModelPrice("gpt-4o", new Date("2020-01-01T00:00:00Z")),
    ).toBeUndefined();
  });

  it("returns undefined for unknown models", () => {
    expect(resolveModelPrice("not-a-model")).toBeUndefined();
  });

  it("has no duplicate (model, effectiveFrom) rows", () => {
    const keys = PRICE_TABLE.map((r) => `${r.model}@${r.effectiveFrom}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("computeCost", () => {
  it("computes input/output/total cost from per-1M prices", () => {
    const cost = computeCost({
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      at: new Date("2025-08-15T00:00:00Z"),
    });
    expect(cost.inputCostUsd).toBe(2.5);
    expect(cost.outputCostUsd).toBe(5);
    expect(cost.totalCostUsd).toBe(7.5);
    expect(cost.priceTableVersion).toBe(PRICE_TABLE_VERSION);
  });

  it("prices fractional token counts deterministically", () => {
    const a = computeCost({
      model: "gpt-4o-mini",
      promptTokens: 12_345,
      completionTokens: 678,
      at: new Date("2025-08-15T00:00:00Z"),
    });
    const b = computeCost({
      model: "gpt-4o-mini",
      promptTokens: 12_345,
      completionTokens: 678,
      at: new Date("2025-08-15T00:00:00Z"),
    });
    expect(a).toEqual(b);
    expect(a.inputCostUsd).toBe(roundUsd((12_345 * 0.15) / 1_000_000));
  });

  it("uses the price effective at the request date", () => {
    const oldCost = computeCost({
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      at: new Date("2025-12-31T00:00:00Z"),
    });
    const newCost = computeCost({
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      at: new Date("2026-01-02T00:00:00Z"),
    });
    expect(oldCost.totalCostUsd).toBe(2.5);
    expect(newCost.totalCostUsd).toBe(2.0);
  });

  it("throws UnknownModelPriceError for unpriced models", () => {
    expect(() =>
      computeCost({ model: "mystery-1", promptTokens: 1, completionTokens: 1 }),
    ).toThrow(UnknownModelPriceError);
  });

  it("zero tokens cost zero dollars", () => {
    const cost = computeCost({
      model: "o4-mini",
      promptTokens: 0,
      completionTokens: 0,
      at: new Date("2025-08-15T00:00:00Z"),
    });
    expect(cost.totalCostUsd).toBe(0);
  });
});
