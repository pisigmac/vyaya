import type { WasteType } from "../types.js";
import { ContextAmnesiaDetector } from "./context-amnesia.js";
import { GhostOutputDetector } from "./ghost-output.js";
import type { WasteDetector } from "./interface.js";
import { OverprovisionedMaxTokensDetector } from "./overprovisioned-max-tokens.js";
import { RetryStormDetector } from "./retry-storm.js";
import { SchemaFailureBurnDetector } from "./schema-failure-burn.js";

/**
 * The detector registry. Every waste_event pins the detector_version from
 * here, so re-running the same detector version over the same logs
 * reproduces the same events.
 */
export const DETECTOR_REGISTRY: readonly WasteDetector[] = [
  new GhostOutputDetector(),
  new RetryStormDetector(),
  new SchemaFailureBurnDetector(),
  new ContextAmnesiaDetector(),
  new OverprovisionedMaxTokensDetector(),
];

export function getDetector(name: WasteType): WasteDetector | undefined {
  return DETECTOR_REGISTRY.find((d) => d.name === name);
}

/** name -> version, for stamping and audit. */
export function detectorVersions(): Record<WasteType, string> {
  const out = {} as Record<WasteType, string>;
  for (const detector of DETECTOR_REGISTRY) {
    out[detector.name] = detector.version;
  }
  return out;
}
