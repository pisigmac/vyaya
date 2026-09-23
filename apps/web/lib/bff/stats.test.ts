import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withWorkspace, schema } from "../../tests/db-barrel";
import {
  getBreakdown,
  getFlowState,
  getSummary,
  getTopFixes,
  getTrend,
  listWasteEvents,
} from "./stats";
import {
  makeSession,
  SEED_WORKSPACE_A,
  SEED_WORKSPACE_B,
  startSeededDb,
  stopDb,
  type DbFixture,
} from "../../tests/helpers";
import type { WasteType } from "@vyaya/core";

/**
 * Stats BFF tests over a seeded embedded Postgres. Seed gives workspace A
 * 105 request_logs in the last few days; we add deterministic waste_events
 * on top and assert exact math.
 */

let fixture: DbFixture;
const admin = makeSession(SEED_WORKSPACE_A, "admin");

interface SeededLog {
  requestId: string;
  endpoint: string;
  costUsd: number;
  featureTag: string | null;
}

let logs: SeededLog[];
let totalSpend: number;

async function addEvent(options: {
  type: WasteType;
  dollars: number;
  requestIds: string[];
  fix: string;
  detectedAt?: Date;
  workspaceId?: string;
}): Promise<void> {
  const workspaceId = options.workspaceId ?? SEED_WORKSPACE_A;
  await withWorkspace(fixture.handle.db, workspaceId, async (tx) => {
    await tx.insert(schema.wasteEvents).values({
      workspaceId,
      wasteType: options.type,
      requestIds: options.requestIds,
      dedupeKey: `test-${options.type}-${options.requestIds.join(",")}-${options.dollars}`,
      dollarsWasted: options.dollars,
      evidence: { attempts: 3, windowMs: 60000 },
      detectorVersion: "test-v1",
      suggestedFix: options.fix,
      detectedAt: options.detectedAt ?? new Date(),
    });
  });
}

beforeAll(async () => {
  fixture = await startSeededDb();
  const rows = await fixture.handle.client`
    SELECT request_id, endpoint, cost_usd::float8 AS cost, feature_tag
    FROM request_logs WHERE workspace_id = ${SEED_WORKSPACE_A}
    ORDER BY occurred_at DESC LIMIT 6
  `;
  logs = rows.map((r) => ({
    requestId: r.request_id as string,
    endpoint: r.endpoint as string,
    costUsd: r.cost as number,
    featureTag: r.feature_tag as string | null,
  }));
  const spend = await fixture.handle.client`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS s FROM request_logs
    WHERE workspace_id = ${SEED_WORKSPACE_A}
  `;
  totalSpend = spend[0]!.s as number;

  // Deterministic waste events for workspace A.
  await addEvent({
    type: "retry_storm",
    dollars: 1.5,
    requestIds: [logs[0]!.requestId, logs[1]!.requestId, logs[2]!.requestId],
    fix: "Cache identical prompts for 60s.",
  });
  await addEvent({
    type: "ghost_output",
    dollars: 2.25,
    requestIds: [logs[3]!.requestId],
    fix: "Stop generating when the client disconnects.",
  });
  await addEvent({
    type: "ghost_output",
    dollars: 0.75,
    requestIds: [logs[4]!.requestId],
    fix: "Stop generating when the client disconnects (latest).",
  });
  await addEvent({
    type: "schema_failure_burn",
    dollars: 0.5,
    requestIds: [logs[5]!.requestId],
    fix: "Add a retry with the schema error fed back.",
  });
  // Old event (outside the 30d window) must not count.
  await addEvent({
    type: "ghost_output",
    dollars: 99,
    requestIds: [logs[0]!.requestId],
    fix: "old",
    detectedAt: new Date(Date.now() - 40 * 86_400_000),
  });
  // Foreign-tenant event must never leak.
  await addEvent({
    type: "ghost_output",
    dollars: 50,
    requestIds: ["foreign-request"],
    fix: "not yours",
    workspaceId: SEED_WORKSPACE_B,
  });
}, 240_000);

afterAll(async () => {
  await stopDb(fixture);
});

// 30d in-window waste for workspace A: 1.5 + 2.25 + 0.75 + 0.5
const WINDOW_WASTE = 5.0;

describe("getSummary", () => {
  it("returns exact 30d math for the workspace", async () => {
    const summary = await getSummary(fixture.handle.db, admin, 30);
    expect(summary.totalSpendUsd).toBeCloseTo(totalSpend, 6);
    expect(summary.dollarsWasted).toBeCloseTo(WINDOW_WASTE, 6);
    expect(summary.wasteRate).toBeCloseTo(WINDOW_WASTE / totalSpend, 6);
    expect(summary.requestCount).toBe(105);
    expect(summary.wasteEventCount).toBe(4);
  });

  it("returns zeros for a workspace with no traffic", async () => {
    const session = makeSession("00000000-0000-4000-a000-0000000000f0", "admin");
    // Workspace doesn't exist; RLS scopes to nothing. Zeros, not errors.
    const summary = await getSummary(fixture.handle.db, session, 30);
    expect(summary.totalSpendUsd).toBe(0);
    expect(summary.wasteRate).toBe(0);
  });
});

describe("getTrend", () => {
  it("returns 30 ascending daily points with spend and waste", async () => {
    const points = await getTrend(fixture.handle.db, admin, 30);
    expect(points).toHaveLength(30);
    const days = points.map((p) => p.day);
    expect([...days].sort()).toEqual(days);
    const spendSum = points.reduce((s, p) => s + p.spendUsd, 0);
    expect(spendSum).toBeCloseTo(totalSpend, 4);
    const wasteSum = points.reduce((s, p) => s + p.wastedUsd, 0);
    expect(wasteSum).toBeCloseTo(WINDOW_WASTE, 4);
  });
});

describe("getBreakdown", () => {
  it("groups by waste_type with exact sums", async () => {
    const slices = await getBreakdown(fixture.handle.db, admin, "waste_type", 30);
    const byType = new Map(slices.map((s) => [s.key, s]));
    expect(byType.get("retry_storm")?.dollarsWasted).toBeCloseTo(1.5, 6);
    expect(byType.get("ghost_output")?.dollarsWasted).toBeCloseTo(3.0, 6);
    expect(byType.get("ghost_output")?.eventCount).toBe(2);
    expect(byType.get("schema_failure_burn")?.dollarsWasted).toBeCloseTo(0.5, 6);
    expect(slices.reduce((s, x) => s + x.dollarsWasted, 0)).toBeCloseTo(5.0, 6);
  });

  it("splits event dollars evenly across endpoints", async () => {
    const slices = await getBreakdown(fixture.handle.db, admin, "endpoint", 30);
    const total = slices.reduce((s, x) => s + x.dollarsWasted, 0);
    expect(total).toBeCloseTo(5.0, 4);
    // Every slice key is a real endpoint from the seed.
    for (const slice of slices) {
      expect(["/v1/chat/completions", "/v1/embeddings"]).toContain(slice.key);
    }
  });

  it("groups by feature_tag with (untagged) fallback", async () => {
    const slices = await getBreakdown(fixture.handle.db, admin, "feature_tag", 30);
    expect(slices.length).toBeGreaterThan(0);
    const total = slices.reduce((s, x) => s + x.dollarsWasted, 0);
    expect(total).toBeCloseTo(5.0, 4);
  });
});

describe("getTopFixes", () => {
  it("ranks by projected annual savings, latest fix wins, top 3", async () => {
    const fixes = await getTopFixes(fixture.handle.db, admin, 30);
    expect(fixes).toHaveLength(3);
    // ghost_output: 3.0 in-window dollars -> highest projection.
    expect(fixes[0]?.wasteType).toBe("ghost_output");
    expect(fixes[0]?.projectedAnnualSavingsUsd).toBeCloseTo((3.0 / 30) * 365, 4);
    // Latest ghost event's fix text wins.
    expect(fixes[0]?.suggestedFix).toContain("latest");
    expect(fixes[1]?.wasteType).toBe("retry_storm");
    expect(fixes[2]?.wasteType).toBe("schema_failure_burn");
  });
});

describe("listWasteEvents", () => {
  it("paginates without overlap and reports the total", async () => {
    const page1 = await listWasteEvents(fixture.handle.db, admin, {
      page: 1,
      pageSize: 2,
      sort: "dollars",
    });
    const page2 = await listWasteEvents(fixture.handle.db, admin, {
      page: 2,
      pageSize: 2,
      sort: "dollars",
    });
    expect(page1.total).toBe(5); // 4 in-window + 1 old event
    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    const ids1 = new Set(page1.events.map((e) => e.id));
    expect(page2.events.every((e) => !ids1.has(e.id))).toBe(true);
    // dollars sort: descending.
    expect(page1.events[0]!.dollarsWasted).toBeGreaterThanOrEqual(
      page1.events[1]!.dollarsWasted,
    );
  });

  it("sorts by recency and filters by type", async () => {
    const recent = await listWasteEvents(fixture.handle.db, admin, {
      page: 1,
      pageSize: 10,
      sort: "recent",
    });
    const times = recent.events.map((e) => Date.parse(e.detectedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const ghosts = await listWasteEvents(fixture.handle.db, admin, {
      page: 1,
      pageSize: 10,
      sort: "dollars",
      wasteType: "ghost_output",
    });
    expect(ghosts.total).toBe(3); // 2 in-window + 1 old
    expect(ghosts.events.every((e) => e.wasteType === "ghost_output")).toBe(true);
  });

  it("never leaks another tenant's events", async () => {
    const foreign = makeSession(SEED_WORKSPACE_B, "admin");
    const page = await listWasteEvents(fixture.handle.db, foreign, {
      page: 1,
      pageSize: 50,
      sort: "dollars",
    });
    expect(page.total).toBe(1);
    expect(page.events[0]?.dollarsWasted).toBeCloseTo(50, 6);
    const summary = await getSummary(fixture.handle.db, foreign, 30);
    expect(summary.dollarsWasted).toBeCloseTo(50, 6);
  });
});

describe("getFlowState", () => {
  it("reports request and waste counts for onboarding", async () => {
    const flow = await getFlowState(fixture.handle.db, admin);
    expect(flow.requestCount).toBe(105);
    expect(flow.wasteEventCount).toBe(5);
  });
});
