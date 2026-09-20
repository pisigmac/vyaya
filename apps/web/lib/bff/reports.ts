import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DrizzleDatabase } from "@vyaya/db";
import { weeklyReports } from "@vyaya/db";
import { desc, eq } from "drizzle-orm";
import type { SessionPayload } from "../session";

/**
 * Weekly report listing + PDF download. Rows are written by the worker;
 * PDFs live under REPORT_OUTPUT_DIR (shared with the worker's env).
 */

export interface ReportSummary {
  id: string;
  weekStart: string;
  weekEnd: string;
  totalSpendUsd: number;
  dollarsWasted: number;
  wasteRate: number;
  hasPdf: boolean;
  emailedAt: string | null;
}

type ReportRow = typeof weeklyReports.$inferSelect;

function summarize(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    totalSpendUsd: Number(row.totalSpendUsd),
    dollarsWasted: Number(row.dollarsWasted),
    wasteRate: Number(row.wasteRate),
    hasPdf: row.pdfPath !== null,
    emailedAt: row.emailedAt === null ? null : row.emailedAt.toISOString(),
  };
}

export async function listReports(
  db: DrizzleDatabase,
  session: SessionPayload,
): Promise<ReportSummary[]> {
  const rows = await db
    .select()
    .from(weeklyReports)
    .where(eq(weeklyReports.workspaceId, session.workspaceId))
    .orderBy(desc(weeklyReports.weekStart));
  return rows.map(summarize);
}

export async function getReportPdf(
  db: DrizzleDatabase,
  session: SessionPayload,
  reportId: string,
  reportOutputDir: string,
): Promise<{ bytes: Buffer; filename: string }> {
  const rows = await db
    .select()
    .from(weeklyReports)
    .where(eq(weeklyReports.id, reportId))
    .limit(1);
  const row = rows[0];
  // Cross-workspace reads are a 404, not a 403: don't leak existence.
  if (row === undefined || row.workspaceId !== session.workspaceId) {
    throw new Error("report not found");
  }
  if (row.pdfPath === null) throw new Error("report has no PDF");
  // pdfPath is a bare filename written by the worker; resolve it against
  // the shared output dir and never trust it as a path.
  const safeName = row.pdfPath.replace(/[^a-zA-Z0-9._-]/g, "");
  const bytes = await readFile(join(reportOutputDir, safeName));
  return { bytes, filename: safeName };
}
