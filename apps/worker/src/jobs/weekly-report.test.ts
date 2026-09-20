import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DETECTOR_THRESHOLDS } from "@vyaya/core";
import { schema, SEED_WORKSPACE_A_ID, SEED_WORKSPACE_B_ID } from "@vyaya/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runClassifyJob } from "./classify.js";
import {
  createEmailSender,
  ResendEmailSender,
  StubEmailSender,
} from "./email.js";
import {
  previousIsoWeek,
  runWeeklyReportJob,
  type WeeklyReportDeps,
} from "./weekly-report.js";
import { createNoopTracer } from "../otel.js";
import {
  MASTER_KEY_HEX,
  SEED_NOW_MS,
  setupSeededDb,
  silentLogger,
  type SeededDb,
} from "../test-utils.js";

/**
 * weekly-report job: 7d digest, pdf-lib PDF, Resend/stub email, idempotent
 * per (workspace, week).
 */

// Seed + classify at 2026-09-23 (Wed); the report runs the next Monday, so
// the whole seeded week (Sep 21..27) is the reporting window.
const REPORT_NOW_MS = Date.UTC(2026, 8, 28, 9, 0, 0); // 2026-09-28 Mon

describe("weekly-report job", () => {
  let seeded: SeededDb;
  let outDir: string;
  let stub: StubEmailSender;

  beforeAll(async () => {
    seeded = await setupSeededDb();
    outDir = mkdtempSync(join(tmpdir(), "vyaya-reports-"));
    // Produce waste events inside the reporting week.
    await runClassifyJob({
      db: seeded.db,
      thresholds: DEFAULT_DETECTOR_THRESHOLDS,
      batchSize: 5_000,
      masterKeyHex: MASTER_KEY_HEX,
      tracer: createNoopTracer(),
      logger: silentLogger,
      nowMs: () => SEED_NOW_MS,
    });
    stub = new StubEmailSender("reports@vyaya.local");
  }, 180_000);

  afterAll(async () => {
    await seeded?.close();
  });

  function deps(): WeeklyReportDeps {
    return {
      db: seeded.db,
      emailSender: stub,
      emailFrom: "reports@vyaya.local",
      reportOutputDir: outDir,
      logger: silentLogger,
      nowMs: () => REPORT_NOW_MS,
    };
  }

  it("computes the digest, stores the row + PDF, and emails via the stub", async () => {
    const result = await runWeeklyReportJob(deps());
    expect(result.reports).toHaveLength(2);
    for (const report of result.reports) {
      expect(report.outcome).toBe("created");
      expect(report.status).toBe("emailed");
      expect(report.weekStart).toBe("2026-09-21");
      expect(report.weekEnd).toBe("2026-09-27");
      expect(report.emailedTo).toBe(1); // one seeded admin user each
    }

    const rows = await seeded.db.db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.workspaceId, SEED_WORKSPACE_A_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.weekStart).toBe("2026-09-21");
    expect(row?.status).toBe("emailed");
    expect(row?.emailSentAt).not.toBeNull();
    expect(row?.pdfPath).toBe(join(outDir, SEED_WORKSPACE_A_ID, "weekly-2026-09-21.pdf"));
    expect(row?.dollarsWasted).toBeGreaterThan(0);
    expect(row?.totalSpendUsd).toBeGreaterThan(0);
    expect(row?.wasteRate).toBeCloseTo(row!.dollarsWasted / row!.totalSpendUsd, 6);
    expect(row?.topFix).toBeTruthy();

    // The PDF bytes exist where the row says they do, and parse as a PDF.
    const pdf = await readFile(row?.pdfPath ?? "");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);

    // The stub "sent" one email per workspace with the PDF attached.
    expect(stub.sent).toHaveLength(2);
    const emailA = stub.sent.find((e) => e.to.includes("admin@acme.example"));
    expect(emailA).toBeDefined();
    expect(emailA?.subject).toContain("2026-09-21");
    expect(emailA?.pdfFileName).toBe("vyaya-weekly-2026-09-21.pdf");
    expect(emailA?.from).toBe("reports@vyaya.local");
    // Copy rules: sentences end with periods.
    expect(emailA?.text).toContain(".");
    expect(emailA?.text).not.toContain("!");
  });

  it("is idempotent: a second run for the same week is a no-op", async () => {
    const result = await runWeeklyReportJob(deps());
    expect(result.reports.every((r) => r.outcome === "existing")).toBe(true);
    const count = await seeded.db.db
      .select({ id: schema.reports.id })
      .from(schema.reports);
    expect(count).toHaveLength(2);
    expect(stub.sent).toHaveLength(2); // no duplicate emails
  });

  it("workspace B report has a lower waste rate than A (metadata-only finds less)", async () => {
    const rowsB = await seeded.db.db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.workspaceId, SEED_WORKSPACE_B_ID));
    const rowsA = await seeded.db.db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.workspaceId, SEED_WORKSPACE_A_ID));
    expect(rowsB[0]?.status).toBe("emailed");
    expect(rowsB[0]?.dollarsWasted ?? 0).toBeGreaterThan(0);
    expect(rowsB[0]?.dollarsWasted ?? 0).toBeLessThan(rowsA[0]?.dollarsWasted ?? 0);
  });
});

describe("previousIsoWeek", () => {
  it("returns the previous Monday-Sunday window", () => {
    const { weekStart, weekEnd } = previousIsoWeek(REPORT_NOW_MS);
    expect(weekStart.toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(weekEnd.toISOString().slice(0, 10)).toBe("2026-09-27");
    expect(weekStart.getUTCDay()).toBe(1);
    expect(weekEnd.getUTCDay()).toBe(0);
  });

  it("on a Monday, returns the week that just ended (not the current one)", () => {
    const monday = Date.UTC(2026, 8, 21, 0, 0, 1);
    const { weekStart } = previousIsoWeek(monday);
    expect(weekStart.toISOString().slice(0, 10)).toBe("2026-09-14");
  });
});

describe("email sender", () => {
  it("uses the stub when RESEND_API_KEY is unset", () => {
    const sender = createEmailSender({
      resendApiKey: undefined,
      from: "reports@vyaya.local",
      logger: silentLogger,
    });
    expect(sender).toBeInstanceOf(StubEmailSender);
  });

  it("uses Resend when RESEND_API_KEY is set", () => {
    const sender = createEmailSender({
      resendApiKey: "re_test",
      from: "reports@vyaya.local",
      logger: silentLogger,
    });
    expect(sender).toBeInstanceOf(ResendEmailSender);
  });

  it("ResendEmailSender posts the email with the PDF as base64 attachment", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }) as typeof fetch;
    const sender = new ResendEmailSender({
      apiKey: "re_test",
      from: "reports@vyaya.local",
      logger: silentLogger,
      fetchFn,
    });
    await sender.send({
      to: ["admin@acme.example"],
      subject: "Subject.",
      text: "Body.",
      pdfFileName: "r.pdf",
      pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.body["to"]).toEqual(["admin@acme.example"]);
    const attachments = calls[0]?.body["attachments"] as { content: string }[];
    expect(Buffer.from(attachments[0]?.content ?? "", "base64")).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
    );
  });

  it("ResendEmailSender throws on a non-2xx response", async () => {
    const fetchFn = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const sender = new ResendEmailSender({
      apiKey: "re_test",
      from: "reports@vyaya.local",
      logger: silentLogger,
      fetchFn,
    });
    await expect(
      sender.send({
        to: ["a@b.c"],
        subject: "s",
        text: "t",
        pdfFileName: "r.pdf",
        pdfBytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("500");
  });
});
