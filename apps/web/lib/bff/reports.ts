import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { desc, eq } from "drizzle-orm";
import { withWorkspace, type VyayaDatabase } from "@vyaya/db/client";
import * as schema from "@vyaya/db/schema";
import { notFound } from "../errors";
import type { SessionPayload } from "../session";

/**
 * Weekly reports: list metadata, download the worker-generated PDF.
 * The worker writes PDFs under REPORT_OUTPUT_DIR; web reads from the same
 * path (shared volume in compose). Paths are resolved and confined to that
 * directory before reading.
 */

export interface ReportView {
  id: string;
  weekStart: string;
  weekEnd: string;
  totalSpendUsd: number;
  dollarsWasted: number;
  wasteRate: number;
  topWasteType: string | null;
  status: string;
  emailSentAt: string | null;
  hasPdf: boolean;
  createdAt: string;
}

export async function listReports(
  db: VyayaDatabase,
  session: SessionPayload,
): Promise<ReportView[]> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.workspaceId, session.workspaceId))
      .orderBy(desc(schema.reports.weekStart));
    return rows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      totalSpendUsd: Number(r.totalSpendUsd),
      dollarsWasted: Number(r.dollarsWasted),
      wasteRate: Number(r.wasteRate),
      topWasteType: r.topWasteType,
      status: r.status,
      emailSentAt: r.emailSentAt?.toISOString() ?? null,
      hasPdf: r.pdfPath !== null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

export async function getReportPdf(
  db: VyayaDatabase,
  session: SessionPayload,
  reportId: string,
  reportOutputDir: string,
): Promise<{ filename: string; bytes: Buffer }> {
  const pdfPath = await withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .select({ pdfPath: schema.reports.pdfPath })
      .from(schema.reports)
      .where(eq(schema.reports.id, reportId))
      .limit(1);
    return rows[0]?.pdfPath ?? null;
  });
  if (!pdfPath) throw notFound("report has no PDF");

  const base = resolve(reportOutputDir);
  const full = resolve(base, pdfPath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw notFound("report PDF path is outside the report directory");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(full);
  } catch {
    throw notFound("report PDF file is missing on disk");
  }
  return { filename: `vyaya-report-${reportId}.pdf`, bytes };
}
