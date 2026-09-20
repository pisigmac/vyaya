"use client";

import { useId } from "react";
import type { BreakdownSlice, TrendPoint } from "@/lib/bff/stats";
import { formatUsd, shortLabel, WASTE_TYPE_LABELS } from "@/lib/format";

/**
 * Pure-SVG charts. No chart library: the shapes are simple, the tokens are
 * ours, and a dependency would fight the design system for styling.
 */

const DONUT_COLORS = [
  "var(--color-primary)",
  "var(--color-accent)",
  "#7a8a99",
  "#a89a6b",
  "#6b7fa8",
  "#8a6ba8",
  "#a86b7f",
];

function sliceLabel(slice: BreakdownSlice): string {
  if (slice.dimension === "waste_type") {
    return WASTE_TYPE_LABELS[slice.key as keyof typeof WASTE_TYPE_LABELS] ?? slice.key;
  }
  return shortLabel(slice.key);
}

export function BreakdownDonut({ slices }: { slices: BreakdownSlice[] }) {
  const gradientId = useId();
  if (slices.length === 0) {
    return <p className="text-small text-muted">No data yet.</p>;
  }
  const total = slices.reduce((sum, s) => sum + s.dollarsWasted, 0);
  const radius = 60;
  const cx = 70;
  const cy = 70;
  let angle = -Math.PI / 2;

  const paths = slices.map((slice, i) => {
    const frac = total > 0 ? slice.dollarsWasted / total : 0;
    const theta = frac * Math.PI * 2;
    // A full circle can't be drawn as one arc; nudge full-circle slices.
    const end = angle + (frac >= 0.9999 ? Math.PI * 2 - 0.001 : theta);
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    const largeArc = end - angle > Math.PI ? 1 : 0;
    const color = DONUT_COLORS[i % DONUT_COLORS.length]!;
    angle = end;
    return {
      d: `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
      color,
      slice,
    };
  });

  return (
    <div className="flex items-start gap-6">
      <svg
        width="140"
        height="140"
        viewBox="0 0 140 140"
        role="img"
        aria-label="Waste breakdown"
      >
        <defs>
          <clipPath id={gradientId}>
            <circle cx={cx} cy={cy} r={radius - 18} />
          </clipPath>
        </defs>
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.color} stroke="var(--color-surface)" />
        ))}
        {/* Punch the donut hole. */}
        <circle cx={cx} cy={cy} r={radius - 24} fill="var(--color-surface)" />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-muted"
          fontSize="11"
        >
          wasted
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-ink font-semibold"
          fontSize="15"
        >
          {formatUsd(total)}
        </text>
      </svg>
      <ul className="space-y-1.5">
        {slices.map((slice, i) => (
          <li key={slice.key} className="flex items-center gap-2 text-small">
            <span
              className="inline-block h-2.5 w-2.5 rounded-[3px]"
              style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
            />
            <span className="text-ink">{sliceLabel(slice)}</span>
            <span className="text-muted">
              {formatUsd(slice.dollarsWasted)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Two stacked-area series over time: total spend vs wasted spend. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return <p className="text-small text-muted">No data yet.</p>;
  }
  const width = 640;
  const height = 200;
  const padX = 8;
  const padY = 14;
  const maxUsd = Math.max(
    0.0001,
    ...points.map((p) => p.totalSpendUsd),
  );
  const stepX =
    points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const x = (i: number) => padX + i * stepX;
  const y = (usd: number) =>
    height - padY - (usd / maxUsd) * (height - padY * 2);

  const area = (key: "totalSpendUsd" | "wastedUsd") => {
    const top = points
      .map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join(" ");
    return `${padX},${height - padY} ${top} ${(width - padX).toFixed(1)},${height - padY}`;
  };

  const first = points[0]!;
  const last = points[points.length - 1]!;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-48 w-full"
        role="img"
        aria-label="Spend and waste over time"
        preserveAspectRatio="none"
      >
        <polygon points={area("totalSpendUsd")} fill="var(--color-track)" />
        <polygon points={area("wastedUsd")} fill="var(--color-accent)" opacity="0.85" />
        {/* Baseline. */}
        <line
          x1={padX}
          x2={width - padX}
          y1={height - padY}
          y2={height - padY}
          stroke="var(--color-border)"
        />
      </svg>
      <div className="mt-2 flex items-center justify-between text-micro text-muted">
        <span>{first.date}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-track" />
            spend
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-accent" />
            waste
          </span>
        </span>
        <span>{last.date}</span>
      </div>
    </div>
  );
}
