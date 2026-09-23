"use client";

import { useState } from "react";
import type { BreakdownSlice } from "@/lib/bff/stats";
import { BreakdownDonut } from "./charts";

const DIMENSIONS = [
  { id: "waste_type", label: "By waste type" },
  { id: "endpoint", label: "By endpoint" },
  { id: "feature_tag", label: "By feature tag" },
] as const;

type Dimension = (typeof DIMENSIONS)[number]["id"];

/**
 * Donut with a dimension toggle. Initial data comes from the server; the
 * toggle refetches the BFF endpoint for the other dimensions.
 */
export function BreakdownPanel({
  initialSlices,
}: {
  initialSlices: BreakdownSlice[];
}) {
  const [dimension, setDimension] = useState<Dimension>("waste_type");
  const [slices, setSlices] = useState(initialSlices);
  const [loading, setLoading] = useState(false);

  const switchTo = async (next: Dimension) => {
    setDimension(next);
    if (next === "waste_type") {
      setSlices(initialSlices);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/stats/breakdown?dimension=${next}`);
      if (res.ok) {
        const body = (await res.json()) as { slices: BreakdownSlice[] };
        setSlices(body.slices);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex gap-2">
        {DIMENSIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => void switchTo(d.id)}
            className={`rounded-md border px-3 py-1.5 text-small shadow-(--shadow-interactive) ${
              dimension === d.id
                ? "border-primary bg-primary text-primary-ink"
                : "border-border bg-surface text-ink hover:border-muted"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="text-small text-muted">Loading.</p>
      ) : (
        <BreakdownDonut slices={slices} />
      )}
    </div>
  );
}
