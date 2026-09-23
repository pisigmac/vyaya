import { getFreePort } from "@vyaya/db/test-support/embedded-pg";
import { describe, expect, it } from "vitest";
import { closeHealth, createHealthServer, listenHealth } from "./health.js";
import { parseCliArgs } from "./index.js";
import { InMemoryJobLock } from "./locks.js";
import { createNoopTracer } from "./otel.js";
import { Scheduler } from "./scheduler.js";
import { silentLogger } from "./test-utils.js";

describe("health endpoint", () => {
  it("GET /healthz returns job statuses with last run timestamps", async () => {
    const scheduler = new Scheduler({
      jobs: [
        {
          name: "classify",
          intervalMs: 3_600_000,
          enabled: true,
          run: async () => undefined,
        },
        {
          name: "deskid-reconcile",
          intervalMs: 3_600_000,
          enabled: false,
          run: async () => undefined,
        },
      ],
      lock: new InMemoryJobLock(),
      logger: silentLogger,
      tracer: createNoopTracer(),
    });
    await scheduler.runNow("classify");

    const server = createHealthServer(() => scheduler.statuses());
    const port = await getFreePort();
    await listenHealth(server, port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        service: string;
        jobs: {
          name: string;
          enabled: boolean;
          lastOutcome: string | null;
          lastFinishedAt: string | null;
        }[];
      };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("vyaya-worker");
      const classify = body.jobs.find((j) => j.name === "classify");
      expect(classify?.lastOutcome).toBe("ok");
      expect(classify?.lastFinishedAt).toBeTruthy();
      const reconcile = body.jobs.find((j) => j.name === "deskid-reconcile");
      expect(reconcile?.enabled).toBe(false);
      expect(reconcile?.lastFinishedAt).toBeNull();

      const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await closeHealth(server);
    }
  });
});

describe("CLI args", () => {
  it("parses --job <name> --once", () => {
    expect(parseCliArgs(["--job", "classify", "--once"])).toEqual({
      job: "classify",
      once: true,
    });
    expect(parseCliArgs([])).toEqual({ job: null, once: false });
    expect(parseCliArgs(["--once"])).toEqual({ job: null, once: true });
  });

  it("rejects unknown jobs and flags", () => {
    expect(() => parseCliArgs(["--job", "nope"])).toThrow("--job");
    expect(() => parseCliArgs(["--bogus"])).toThrow("unknown argument");
    expect(() => parseCliArgs(["--job"])).toThrow("--job");
  });
});
