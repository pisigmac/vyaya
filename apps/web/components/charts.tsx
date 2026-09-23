import type { BreakdownSlice, TrendPoint } from "@/lib/bff/stats";
import { formatUsd } from "@/lib/format";

/**
 * Lightweight inline-SVG charts. No chart library, no canvas, no WebGL —
 * just polylines and circles with solid fills (zero gradients).
 */

const W = 640;
const H = 200;
const PAD = 8;

export function TrendChart({ points }: { points: TrendPoint[] }) {
  const max = Math.max(0.000001, ...points.map((p) => p.spendUsd));
  const x = (i: number) =>
    PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const line = (pick: (p: TrendPoint) => number) =>
    points.map((p, i) => `${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-48 w-full"
        role="img"
        aria-label="Daily spend versus waste over the last 30 days"
      >
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          stroke="var(--border)"
          strokeWidth="1"
        />
        <polyline
          points={line((p) => p.spendUsd)}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
        />
        <polyline
          points={line((p) => p.wastedUsd)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        />
      </svg>
      <div className="mt-2 flex gap-6 text-small text-muted">
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-4 bg-primary" /> Spend
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-4 bg-accent" /> Waste
        </span>
        <span className="ml-auto">
          {points[0]?.day} to {points[points.length - 1]?.day}
        </span>
      </div>
    </div>
  );
}

/**
 * Donut built from stroke-dasharray segments on a single-hue scale: the
 * primary and accent colors at stepped opacities. Solid fills only.
 */
const DONUT_OPACITIES = [1, 0.72, 0.5, 1, 0.72];

export function BreakdownDonut({ slices }: { slices: BreakdownSlice[] }) {
  const total = slices.reduce((s, x) => s + x.dollarsWasted, 0);
  if (total <= 0) {
    return (
      <p className="text-small text-muted">
        No waste in this window. That's the goal — keep it there.
      </p>
    );
  }
  const r = 15.9155; // circumference = 100
  let offset = 25; // start at 12 o'clock
  const segments = slices.map((slice, i) => {
    const fraction = (slice.dollarsWasted / total) * 100;
    const seg = {
      slice,
      dash: `${fraction} ${100 - fraction}`,
      offset,
      color: i < 3 ? "var(--primary)" : "var(--accent)",
      opacity: DONUT_OPACITIES[i] ?? 0.5,
    };
    offset -= fraction;
    return seg;
  });

  return (
    <div className="flex flex-wrap items-center gap-8">
      <svg
        viewBox="0 0 42 42"
        className="h-40 w-40"
        role="img"
        aria-label="Waste breakdown"
      >
        <circle
          cx="21"
          cy="21"
          r={r}
          fill="none"
          stroke="var(--track)"
          strokeWidth="6"
        />
        {segments.map((seg) => (
          <circle
            key={seg.slice.key}
            cx="21"
            cy="21"
            r={r}
            fill="none"
            stroke={seg.color}
            strokeOpacity={seg.opacity}
            strokeWidth="6"
            strokeDasharray={seg.dash}
            strokeDashoffset={seg.offset}
          />
        ))}
        <text
          x="21"
          y="21"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-ink"
          fontSize="6"
          fontWeight="600"
        >
          {formatUsd(total)}
        </text>
      </svg>
      <ul className="space-y-1.5 text-small">
        {segments.map((seg) => (
          <li key={seg.slice.key} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-md"
              style={{ background: seg.color, opacity: seg.opacity }}
            />
            <span className="text-ink">{seg.slice.key}</span>
            <span className="text-muted">
              {formatUsd(seg.slice.dollarsWasted)} · {seg.slice.eventCount}{" "}
              events
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
