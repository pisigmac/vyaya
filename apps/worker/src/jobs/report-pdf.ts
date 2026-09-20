import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Weekly report PDF, generated with pdf-lib only — no headless browser.
 * Layout: cover line, summary table (spend / wasted / rate / biggest
 * event), top-3 fixes ranked by projected annual savings. Deterministic
 * given the same digest (fixed layout, standard fonts, no timestamps in
 * content — the caller's week bounds carry the dating).
 */

export interface ReportFix {
  suggestedFix: string;
  wasteType: string;
  weeklyUsd: number;
  projectedAnnualSavingsUsd: number;
}

export interface WeeklyDigest {
  workspaceName: string;
  weekStart: string; // ISO date (Monday)
  weekEnd: string; // ISO date (Sunday)
  totalSpendUsd: number;
  dollarsWasted: number;
  /** 0..1 */
  wasteRate: number;
  topWasteType: string | null;
  biggestEventUsd: number | null;
  fixes: ReportFix[];
}

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.38, 0.35);

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function drawRow(
  page: PDFPage,
  font: PDFFont,
  x: number,
  y: number,
  label: string,
  value: string,
): void {
  page.drawText(label, { x, y, size: 10, font, color: MUTED });
  page.drawText(value, { x: x + 200, y, size: 10, font, color: INK });
}

/** Clamp overlong copy so a fix string can never break the layout. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function buildWeeklyReportPdf(digest: WeeklyDigest): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Vyaya weekly waste report ${digest.weekStart}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]); // US Letter

  let y = 720;
  page.drawText("Vyaya", { x: 56, y, size: 22, font: bold, color: INK });
  y -= 30;
  page.drawText("Weekly waste report", { x: 56, y, size: 16, font: bold, color: INK });
  y -= 18;
  page.drawText(
    clip(`${digest.workspaceName} — ${digest.weekStart} to ${digest.weekEnd}.`, 90),
    { x: 56, y, size: 10, font, color: MUTED },
  );
  y -= 34;

  page.drawText("Summary", { x: 56, y, size: 12, font: bold, color: INK });
  y -= 20;
  drawRow(page, font, 56, y, "Total LLM spend", usd(digest.totalSpendUsd));
  y -= 16;
  drawRow(page, font, 56, y, "Dollars wasted", usd(digest.dollarsWasted));
  y -= 16;
  drawRow(page, font, 56, y, "Waste rate", `${(digest.wasteRate * 100).toFixed(1)}%`);
  y -= 16;
  drawRow(
    page,
    font,
    56,
    y,
    "Biggest waste event",
    digest.biggestEventUsd === null
      ? "none this week"
      : `${usd(digest.biggestEventUsd)} (${digest.topWasteType ?? "unknown"})`,
  );
  y -= 36;

  page.drawText("Top fixes by projected annual savings", {
    x: 56,
    y,
    size: 12,
    font: bold,
    color: INK,
  });
  y -= 20;
  if (digest.fixes.length === 0) {
    page.drawText("No waste found this week. Keep it that way.", {
      x: 56,
      y,
      size: 10,
      font,
      color: MUTED,
    });
  }
  for (const [i, fix] of digest.fixes.slice(0, 3).entries()) {
    page.drawText(`${i + 1}. ${clip(fix.suggestedFix, 78)}`, {
      x: 56,
      y,
      size: 10,
      font,
      color: INK,
    });
    y -= 14;
    page.drawText(
      `${fix.wasteType} — wasted ${usd(fix.weeklyUsd)} this week, projected ${usd(fix.projectedAnnualSavingsUsd)} per year.`,
      { x: 72, y, size: 9, font, color: MUTED },
    );
    y -= 22;
  }

  return doc.save();
}
