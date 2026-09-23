import { sql as dsql } from "drizzle-orm";
import type { WasteType } from "@vyaya/core";
import { withWorkspace, type VyayaDatabase, type VyayaTx } from "@vyaya/db/client";
import type { BreakdownDimension, WasteEventsQuery } from "../schemas";
import type { SessionPayload } from "../session";

/**
 * Dashboard statistics. All queries run inside withWorkspace (RLS-scoped
 * transactions) and carry an explicit workspace_id filter as well — the
 * same belt-and-braces rule the worker follows.
 *
 * Window semantics: "30d" = occurred_at / detected_at within now() - 30
 * days. Waste events are attributed to their detection day (detectors run
 * over recent logs, so detection time is the honest timestamp).
 */

export interface StatsSummary {
  days: number;
  totalSpendUsd: number;
  dollarsWasted: number;
  /** dollars_wasted / total_spend; 0 when there is no spend. */
  wasteRate: number;
  requestCount: number;
  wasteEventCount: number;
}

export interface TrendPoint {
  /** ISO calendar day (UTC). */
  day: string;
  spendUsd: number;
  wastedUsd: number;
}

export interface BreakdownSlice {
  key: string;
  dollarsWasted: number;
  eventCount: number;
}

export interface WasteEventView {
  id: string;
  wasteType: WasteType;
  dollarsWasted: number;
  evidence: Record<string, unknown>;
  suggestedFix: string;
  detectedAt: string;
  requestIds: string[];
}

export interface WasteEventPage {
  events: WasteEventView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TopFix {
  wasteType: WasteType;
  suggestedFix: string;
  dollarsWasted30d: number;
  /** (30d waste / 30) * 365 — same convention as the weekly report x52. */
  projectedAnnualSavingsUsd: number;
  eventCount: number;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function getSummary(
  db: VyayaDatabase,
  session: SessionPayload,
  days = 30,
): Promise<StatsSummary> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const spend = await tx.execute<{ spend: string; requests: string }>(dsql`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend,
             COUNT(*)::int AS requests
      FROM request_logs
      WHERE workspace_id = ${session.workspaceId}
        AND occurred_at >= now() - make_interval(days => ${days})
    `);
    const waste = await tx.execute<{ wasted: string; events: string }>(dsql`
      SELECT COALESCE(SUM(dollars_wasted), 0)::float8 AS wasted,
             COUNT(*)::int AS events
      FROM waste_events
      WHERE workspace_id = ${session.workspaceId}
        AND detected_at >= now() - make_interval(days => ${days})
    `);
    const totalSpendUsd = num(spend[0]?.spend);
    const dollarsWasted = num(waste[0]?.wasted);
    return {
      days,
      totalSpendUsd,
      dollarsWasted,
      wasteRate: totalSpendUsd > 0 ? dollarsWasted / totalSpendUsd : 0,
      requestCount: num(spend[0]?.requests),
      wasteEventCount: num(waste[0]?.events),
    };
  });
}

export async function getTrend(
  db: VyayaDatabase,
  session: SessionPayload,
  days = 30,
): Promise<TrendPoint[]> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx.execute<{
      day: string;
      spend: number;
      wasted: number;
    }>(dsql`
      WITH days AS (
        SELECT generate_series(
          (now()::date - (${days} - 1))::timestamptz,
          now()::date::timestamptz,
          interval '1 day'
        ) AS day
      )
      SELECT d.day::date::text AS day,
             COALESCE(s.spend, 0)::float8 AS spend,
             COALESCE(w.wasted, 0)::float8 AS wasted
      FROM days d
      LEFT JOIN (
        SELECT occurred_at::date AS day, SUM(cost_usd) AS spend
        FROM request_logs
        WHERE workspace_id = ${session.workspaceId}
          AND occurred_at >= now() - make_interval(days => ${days})
        GROUP BY 1
      ) s ON s.day = d.day::date
      LEFT JOIN (
        SELECT detected_at::date AS day, SUM(dollars_wasted) AS wasted
        FROM waste_events
        WHERE workspace_id = ${session.workspaceId}
          AND detected_at >= now() - make_interval(days => ${days})
        GROUP BY 1
      ) w ON w.day = d.day::date
      ORDER BY d.day
    `);
    return rows.map((r) => ({
      day: r.day,
      spendUsd: num(r.spend),
      wastedUsd: num(r.wasted),
    }));
  });
}

/**
 * Breakdown by waste_type reads waste_events directly. By endpoint or
 * feature_tag it joins each event's request logs and splits the event's
 * dollars evenly across its implicated requests (documented attribution
 * rule — an event's cost is shared by the requests that caused it).
 */
export async function getBreakdown(
  db: VyayaDatabase,
  session: SessionPayload,
  dimension: BreakdownDimension,
  days = 30,
): Promise<BreakdownSlice[]> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    if (dimension === "waste_type") {
      const rows = await tx.execute<{
        key: string;
        wasted: number;
        events: number;
      }>(dsql`
        SELECT waste_type::text AS key,
               SUM(dollars_wasted)::float8 AS wasted,
               COUNT(*)::int AS events
        FROM waste_events
        WHERE workspace_id = ${session.workspaceId}
          AND detected_at >= now() - make_interval(days => ${days})
        GROUP BY waste_type
        ORDER BY wasted DESC
      `);
      return rows.map(slice);
    }
    const dimCol =
      dimension === "endpoint"
        ? dsql`rl.endpoint`
        : dsql`COALESCE(rl.feature_tag, '(untagged)')`;
    const rows = await tx.execute<{
      key: string;
      wasted: number;
      events: number;
    }>(dsql`
      SELECT ${dimCol} AS key,
             SUM(we.dollars_wasted / jsonb_array_length(we.request_ids))::float8 AS wasted,
             COUNT(DISTINCT we.id)::int AS events
      FROM waste_events we
      CROSS JOIN LATERAL jsonb_array_elements_text(we.request_ids) AS rid(request_id)
      JOIN request_logs rl
        ON rl.request_id = rid.request_id
       AND rl.workspace_id = we.workspace_id
      WHERE we.workspace_id = ${session.workspaceId}
        AND we.detected_at >= now() - make_interval(days => ${days})
      GROUP BY 1
      ORDER BY wasted DESC
    `);
    return rows.map(slice);
  });
}

function slice(r: { key: string; wasted: number; events: number }): BreakdownSlice {
  return {
    key: r.key,
    dollarsWasted: num(r.wasted),
    eventCount: num(r.events),
  };
}

export async function listWasteEvents(
  db: VyayaDatabase,
  session: SessionPayload,
  query: WasteEventsQuery,
): Promise<WasteEventPage> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const orderBy =
      query.sort === "recent"
        ? dsql`detected_at DESC, id`
        : dsql`dollars_wasted DESC, id`;
    const typeFilter = query.wasteType
      ? dsql`AND waste_type = ${query.wasteType}`
      : dsql``;
    const rows = await tx.execute<{
      id: string;
      waste_type: WasteType;
      dollars_wasted: number;
      evidence: Record<string, unknown> | string;
      suggested_fix: string;
      detected_at: Date | string;
      request_ids: string[] | string;
    }>(dsql`
      SELECT id, waste_type, dollars_wasted::float8 AS dollars_wasted,
             evidence, suggested_fix, detected_at, request_ids
      FROM waste_events
      WHERE workspace_id = ${session.workspaceId}
      ${typeFilter}
      ORDER BY ${orderBy}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    `);
    const counts = await tx.execute<{ total: string }>(dsql`
      SELECT COUNT(*)::int AS total FROM waste_events
      WHERE workspace_id = ${session.workspaceId}
      ${typeFilter}
    `);
    return {
      events: rows.map((r) => ({
        id: r.id,
        wasteType: r.waste_type,
        dollarsWasted: num(r.dollars_wasted),
        evidence:
          typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence,
        suggestedFix: r.suggested_fix,
        detectedAt: new Date(r.detected_at).toISOString(),
        requestIds:
          typeof r.request_ids === "string"
            ? JSON.parse(r.request_ids)
            : r.request_ids,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: num(counts[0]?.total),
    };
  });
}

/**
 * Top-3 fixes ranked by projected annual savings. The suggested fix and
 * evidence come from the most recent event of each type.
 */
export async function getTopFixes(
  db: VyayaDatabase,
  session: SessionPayload,
  days = 30,
): Promise<TopFix[]> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx.execute<{
      waste_type: WasteType;
      wasted: number;
      events: number;
      suggested_fix: string;
    }>(dsql`
      SELECT waste_type,
             SUM(dollars_wasted)::float8 AS wasted,
             COUNT(*)::int AS events,
             (ARRAY_AGG(suggested_fix ORDER BY detected_at DESC))[1] AS suggested_fix
      FROM waste_events
      WHERE workspace_id = ${session.workspaceId}
        AND detected_at >= now() - make_interval(days => ${days})
      GROUP BY waste_type
      ORDER BY wasted DESC
      LIMIT 3
    `);
    return rows.map((r) => {
      const dollarsWasted30d = num(r.wasted);
      return {
        wasteType: r.waste_type,
        suggestedFix: r.suggested_fix,
        dollarsWasted30d,
        projectedAnnualSavingsUsd: (dollarsWasted30d / days) * 365,
        eventCount: num(r.events),
      };
    });
  });
}

/** Small aggregate used by onboarding: has any request / waste arrived? */
export async function getFlowState(
  db: VyayaDatabase,
  session: SessionPayload,
): Promise<{ requestCount: number; wasteEventCount: number }> {
  return withWorkspace(db, session.workspaceId, async (tx: VyayaTx) => {
    const logs = await tx.execute<{ n: string }>(dsql`
      SELECT COUNT(*)::int AS n FROM request_logs
      WHERE workspace_id = ${session.workspaceId}
    `);
    const events = await tx.execute<{ n: string }>(dsql`
      SELECT COUNT(*)::int AS n FROM waste_events
      WHERE workspace_id = ${session.workspaceId}
    `);
    return {
      requestCount: num(logs[0]?.n),
      wasteEventCount: num(events[0]?.n),
    };
  });
}
