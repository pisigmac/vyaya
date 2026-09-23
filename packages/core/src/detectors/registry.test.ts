import { describe, expect, it } from "vitest";
import {
  DETECTOR_REGISTRY,
  detectorVersions,
  getDetector,
} from "./registry.js";
import { WASTE_TYPES } from "../types.js";
import { makeCtx, makeLog } from "./fixtures.js";
import { DEFAULT_DETECTOR_THRESHOLDS } from "./interface.js";

describe("detector registry", () => {
  it("registers exactly the five taxonomy detectors", () => {
    expect(DETECTOR_REGISTRY.map((d) => d.name).sort()).toEqual(
      [...WASTE_TYPES].sort(),
    );
  });

  it("pins a semver version per detector", () => {
    const versions = detectorVersions();
    for (const name of WASTE_TYPES) {
      expect(versions[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("getDetector round-trips", () => {
    expect(getDetector("retry_storm")?.name).toBe("retry_storm");
  });

  it("stamps emitted events with the pinned detector_version", () => {
    const log = makeLog({
      occurredAtMs: 1_000,
      responseConsumed: false,
      status: "success",
    });
    const ghost = getDetector("ghost_output");
    const events = ghost?.detect(
      makeCtx([log], { nowMs: DEFAULT_DETECTOR_THRESHOLDS.ghostOutputMinAgeMs + 2_000 }),
    );
    expect(events?.[0]?.detectorVersion).toBe(detectorVersions().ghost_output);
  });
});
