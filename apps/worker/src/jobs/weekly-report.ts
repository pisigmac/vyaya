import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listWorkspaceIds, schema, withWorkspace, type DbHandle } from "@vyaya/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { EmailSender } from "./email.js";
import { buildWeeklyReportPdf, type ReportFix, type WeeklyDigest } from "./report-pdf.js";

/**
 * jobs/weekly-report — per-workspace 7d waste digest.
 *
 * For the most recently COMPLETED ISO week (Monday-Sunday), compute
 * waste_rate (dollars_wasted / total_spend), the biggest waste event, and
 * the top fixes ranked by projected_annual_savings (weekly waste x 52).
 * Render a pdf-lib PDF (no headless browser), store the report row + PDF
 * bytes location regardless of email delivery, then send via the
 * EmailSender (Resend when RESEND_API_KEY is set, recording stub
 * otherwise).
 *
 * Idempotent: one report row per (workspace_id, week_start) via the
 * reports_workspace_week_idx unique index; a second run for the same week
 * is a no-op.
 */

export interface WeeklyReportDeps {
  db: DbHandle;
  emailSender: EmailSender;
  emailFrom: string;
  /** Worker-local directory for PDF bytes. */
  reportOutputDir: string;
  logger: Logger;
  nowMs?: () => number;
}

export interface WorkspaceReportResult {
  workspaceId: string;
  weekStart: string;
  weekEnd: string;
  /** "created" | "existing" (same week already reported). */
  outcome: "created" | "existing";
  status: "generated" | "emailed" | "failed";
  pdfPath: string;
  emailedTo: number;
}

export interface WeeklyReportResult {
  reports: WorkspaceReportResult[];
}

/** Previous completed ISO week (Monday 00:00 UTC .. Sunday 23:59:59.999 UTC). */
export function previousIsoWeek(nowMs: number): { weekStart: Date; weekEnd: Date } {
  const now = new Date(nowMs);
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const mondayThisWeek = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - day,
  );
  const weekStartMs = mondayThisWeek - 7 * 86_400_000;
  return {
    weekStart: new Date(weekStartMs),
    weekEnd: new Date(weekStartMs + 7 * 86_400_000 - 1),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runWeeklyReportJob(
  deps: WeeklyReportDeps,
): Promise<WeeklyReportResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const { weekStart, weekEnd } = previousIsoWeek(nowMs());
  const workspaceIds = await listWorkspaceIds(deps.db);
  const reports: WorkspaceReportResult[] = [];
  for (const workspaceId of workspaceIds) {
    reports.push(
      await reportWorkspace(deps, workspaceId, weekStart, weekEnd, nowMs),
    );
  }
  return { reports };
}

async function reportWorkspace(
  deps: WeeklyReportDeps,
  workspaceId: string,
  weekStart: Date,
  weekEnd: Date,
  nowMs: () => number,
): Promise<WorkspaceReportResult> {
  const weekStartDay = isoDay(weekStart);
  const weekEndDay = isoDay(weekEnd);
  const pdfDir = join(deps.reportOutputDir, workspaceId);
  const pdfPath = join(pdfDir, `weekly-${weekStartDay}.pdf`);

  const prepared = await withWorkspace(deps.db, workspaceId, async (tx) => {
    // Already reported this week? Then nothing to do.
    const existing = await tx
      .select({ id: schema.reports.id, status: schema.reports.status })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.workspaceId, workspaceId),
          eq(schema.reports.weekStart, weekStartDay),
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) return { kind: "existing" as const };

    const ws = await tx
      .select({
        name: schema.workspaces.name,
        reportEmail: schema.workspaces.reportEmail,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    // Spend over the week (request_logs by occurred_at). The explicit
    // workspace filter complements RLS — the service role sees all tenants.
    const spendRows = await tx
      .select({
        total: sql<string>`coalesce(sum(${schema.requestLogs.costUsd}), 0)::text`,
      })
      .from(schema.requestLogs)
      .where(
        and(
          eq(schema.requestLogs.workspaceId, workspaceId),
          gte(schema.requestLogs.occurredAt, weekStart),
          lt(schema.requestLogs.occurredAt, new Date(weekEnd.getTime() + 1)),
        ),
      );
    const totalSpendUsd = Number(spendRows[0]?.total ?? "0");

    // Waste events detected during the week.
    const events = await tx
      .select({
        id: schema.wasteEvents.id,
        wasteType: schema.wasteEvents.wasteType,
        dollarsWasted: schema.wasteEvents.dollarsWasted,
        suggestedFix: schema.wasteEvents.suggestedFix,
      })
      .from(schema.wasteEvents)
      .where(
        and(
          eq(schema.wasteEvents.workspaceId, workspaceId),
          gte(schema.wasteEvents.detectedAt, weekStart),
          lt(schema.wasteEvents.detectedAt, new Date(weekEnd.getTime() + 1)),
        ),
      )
      .orderBy(desc(schema.wasteEvents.dollarsWasted));

    const dollarsWasted = events.reduce((sum, e) => sum + e.dollarsWasted, 0);
    const biggest = events[0];

    // Top fixes ranked by projected annual savings (weekly x 52).
    const byFix = new Map<string, ReportFix>();
    for (const event of events) {
      const fix = byFix.get(event.suggestedFix) ?? {
        suggestedFix: event.suggestedFix,
        wasteType: event.wasteType,
        weeklyUsd: 0,
        projectedAnnualSavingsUsd: 0,
      };
      fix.weeklyUsd += event.dollarsWasted;
      fix.projectedAnnualSavingsUsd = fix.weeklyUsd * 52;
      byFix.set(event.suggestedFix, fix);
    }
    const fixes = [...byFix.values()]
      .sort((a, b) => b.projectedAnnualSavingsUsd - a.projectedAnnualSavingsUsd)
      .slice(0, 3);

    // Recipients: the workspace's configured report email when set
    // (Settings -> report recipient), otherwise every mirrored user email.
    const configured = ws[0]?.reportEmail?.trim();
    const recipients = configured
      ? [{ email: configured }]
      : await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.workspaceId, workspaceId));

    return {
      kind: "new" as const,
      digest: {
        workspaceName: ws[0]?.name ?? workspaceId,
        weekStart: weekStartDay,
        weekEnd: weekEndDay,
        totalSpendUsd,
        dollarsWasted,
        wasteRate: totalSpendUsd > 0 ? dollarsWasted / totalSpendUsd : 0,
        topWasteType: biggest?.wasteType ?? null,
        biggestEventUsd: biggest?.dollarsWasted ?? null,
        fixes,
      } satisfies WeeklyDigest,
      biggestEventId: biggest?.id ?? null,
      topFix: fixes[0]?.suggestedFix ?? null,
      recipients: recipients.map((r) => r.email),
    };
  });

  if (prepared.kind === "existing") {
    return {
      workspaceId,
      weekStart: weekStartDay,
      weekEnd: weekEndDay,
      outcome: "existing",
      status: "generated",
      pdfPath,
      emailedTo: 0,
    };
  }

  // Render + persist the PDF bytes BEFORE the report row, so a stored row
  // never points at a missing file.
  const pdfBytes = await buildWeeklyReportPdf(prepared.digest);
  await mkdir(pdfDir, { recursive: true });
  await writeFile(pdfPath, pdfBytes);

  const reportId = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const inserted = await tx
      .insert(schema.reports)
      .values({
        workspaceId,
        weekStart: weekStartDay,
        weekEnd: weekEndDay,
        totalSpendUsd: prepared.digest.totalSpendUsd,
        dollarsWasted: prepared.digest.dollarsWasted,
        wasteRate: prepared.digest.wasteRate,
        topWasteType: prepared.digest.topWasteType as
          | "ghost_output"
          | "retry_storm"
          | "schema_failure_burn"
          | "context_amnesia"
          | "overprovisioned_max_tokens"
          | null,
        biggestEventId: prepared.biggestEventId,
        topFix: prepared.topFix,
        pdfPath,
        status: "generated",
      })
      .onConflictDoNothing()
      .returning({ id: schema.reports.id });
    return inserted[0]?.id ?? null;
  });
  if (reportId === null) {
    // Lost an insert race with a concurrent worker: report exists already.
    return {
      workspaceId,
      weekStart: weekStartDay,
      weekEnd: weekEndDay,
      outcome: "existing",
      status: "generated",
      pdfPath,
      emailedTo: 0,
    };
  }

  // Email (stub or Resend). Delivery failure marks the row failed but
  // keeps the PDF + row — the next run does not regenerate this week.
  let status: "generated" | "emailed" | "failed" = "generated";
  if (prepared.recipients.length > 0) {
    const d = prepared.digest;
    try {
      await deps.emailSender.send({
        to: prepared.recipients,
        subject: `Your weekly waste report — ${d.weekStart} to ${d.weekEnd}.`,
        text: emailBody(d),
        pdfFileName: `vyaya-weekly-${d.weekStart}.pdf`,
        pdfBytes,
      });
      status = "emailed";
    } catch (err) {
      status = "failed";
      deps.logger.warn({ err, workspaceId }, "weekly report email failed");
    }
    await withWorkspace(deps.db, workspaceId, async (tx) => {
      await tx
        .update(schema.reports)
        .set({
          status,
          emailSentAt: status === "emailed" ? new Date(nowMs()) : null,
        })
        .where(eq(schema.reports.id, reportId));
    });
  }

  deps.logger.info(
    { workspaceId, weekStart: weekStartDay, status, pdfPath },
    "weekly report generated",
  );
  return {
    workspaceId,
    weekStart: weekStartDay,
    weekEnd: weekEndDay,
    outcome: "created",
    status,
    pdfPath,
    emailedTo: status === "emailed" ? prepared.recipients.length : 0,
  };
}

/** Plain-text body. UI copy rules: contractions, name the enemy, periods. */
function emailBody(d: WeeklyDigest): string {
  const lines = [
    `Here's what your LLM spend actually bought this week (${d.weekStart} to ${d.weekEnd}).`,
    "",
    `Total spend: $${d.totalSpendUsd.toFixed(2)}.`,
    `Wasted: $${d.dollarsWasted.toFixed(2)} (${(d.wasteRate * 100).toFixed(1)}%).`,
  ];
  if (d.biggestEventUsd !== null) {
    lines.push(
      `Biggest single waste event: $${d.biggestEventUsd.toFixed(2)} (${d.topWasteType ?? "unknown"}).`,
    );
  }
  if (d.fixes.length > 0) {
    lines.push("", "Top fixes, ranked by projected annual savings:");
    d.fixes.forEach((fix, i) => {
      lines.push(
        `${i + 1}. ${fix.suggestedFix} That's $${fix.projectedAnnualSavingsUsd.toFixed(2)} a year you don't have to burn.`,
      );
    });
  } else {
    lines.push("", "No waste found this week. That's the goal.");
  }
  lines.push("", "The full report is attached as a PDF.");
  return lines.join("\n");
}
