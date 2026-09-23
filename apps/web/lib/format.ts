import type { WasteType } from "@vyaya/core";

/** Display helpers shared by server components and the landing page. */

export const WASTE_TYPE_LABELS: Record<WasteType, string> = {
  ghost_output: "Ghost output",
  retry_storm: "Retry storm",
  schema_failure_burn: "Schema failure burn",
  context_amnesia: "Context amnesia",
  overprovisioned_max_tokens: "Overprovisioned max_tokens",
};

export const WASTE_TYPE_BLURBS: Record<WasteType, string> = {
  ghost_output:
    "You paid for tokens nobody read. The response was generated, logged, and never consumed.",
  retry_storm:
    "The same prompt hit the API again and again inside a minute. One answer, several bills.",
  schema_failure_burn:
    "The model returned JSON your schema rejected. The full generation cost got written off.",
  context_amnesia:
    "Every turn re-sends the same background. A cache or a fixed system prompt would end it.",
  overprovisioned_max_tokens:
    "You reserve thousands of tokens and use a third of them. The cap is the bill's ceiling.",
};

export function formatUsd(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (value >= 1) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One-line "why this is waste" summary from a detector's evidence JSON. */
export function evidenceSummary(
  wasteType: WasteType,
  evidence: Record<string, unknown>,
): string {
  const get = (key: string): string => {
    const v = evidence[key];
    return typeof v === "number" || typeof v === "string" ? String(v) : "?";
  };
  switch (wasteType) {
    case "ghost_output":
      return `Response never consumed; ${get("promptTokens")} prompt tokens billed.`;
    case "retry_storm":
      return `${get("attempts")} identical calls in ${get("windowMs")}ms; a later one succeeded.`;
    case "schema_failure_burn":
      return `Response failed ${get("schemaName")} validation; full generation billed.`;
    case "context_amnesia":
      return `Turns share ${get("overlapTokens")} repeated context tokens (Jaccard ${get("jaccard")}).`;
    case "overprovisioned_max_tokens":
      return `Completion used ${get("avgRatio")} of max_tokens across ${get("calls")} calls.`;
    default:
      return "Detector evidence attached.";
  }
}
