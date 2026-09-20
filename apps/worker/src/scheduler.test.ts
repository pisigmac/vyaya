import { describe, expect, it } from "vitest";
import { InMemoryJobLock } from "./locks.js";
import { createNoopTracer } from "./otel.js";
import { Scheduler, type JobDefinition } from "./scheduler.js";
import { silentLogger } from "./test-utils.js";

function makeScheduler(jobs: JobDefinition[], lock = new InMemoryJobLock()) {
  return new Scheduler({
    jobs,
    lock,
    logger: silentLogger,
    tracer: createNoopTracer(),
    lockTtlMs: 60_000,
  });
}

describe("Scheduler", () => {
  it("runs a job once via runNow and records ok status", async () => {
    let calls = 0;
    const scheduler = makeScheduler([
      { name: "classify", intervalMs: 3_600_000, enabled: true, run: async () => { calls += 1; } },
    ]);
    const status = await scheduler.runNow("classify");
    expect(calls).toBe(1);
    expect(status.lastOutcome).toBe("ok");
    expect(status.runs).toBe(1);
    expect(status.lastStartedAt).toBeTruthy();
    expect(status.lastFinishedAt).toBeTruthy();
    expect(status.running).toBe(false);
  });

  it("records failures without throwing (job errors do not crash the worker)", async () => {
    const scheduler = makeScheduler([
      {
        name: "weekly-report",
        intervalMs: 3_600_000,
        enabled: true,
        run: async () => { throw new Error("boom"); },
      },
    ]);
    const status = await scheduler.runNow("weekly-report");
    expect(status.lastOutcome).toBe("failed");
    expect(status.lastError).toBe("boom");
    expect(status.failures).toBe(1);
  });

  it("skips the run when the lock is held elsewhere", async () => {
    const lock = new InMemoryJobLock();
    const held = await lock.acquire("vyaya:job:classify", 60_000);
    expect(held).toBeTruthy();
    let calls = 0;
    const scheduler = makeScheduler(
      [{ name: "classify", intervalMs: 3_600_000, enabled: true, run: async () => { calls += 1; } }],
      lock,
    );
    const status = await scheduler.runNow("classify");
    expect(calls).toBe(0);
    expect(status.lastOutcome).toBe("skipped_locked");
  });

  it("rejects unknown job names", async () => {
    const scheduler = makeScheduler([]);
    await expect(scheduler.runNow("nope")).rejects.toThrow("unknown job");
  });

  it("start() schedules enabled jobs only; stop() cancels timers", async () => {
    let enabledRuns = 0;
    const scheduler = makeScheduler([
      { name: "classify", intervalMs: 10, enabled: true, run: async () => { enabledRuns += 1; } },
      { name: "deskid-reconcile", intervalMs: 10, enabled: false, run: async () => { enabledRuns += 100; } },
    ]);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 45));
    await scheduler.stop();
    const afterStop = enabledRuns;
    expect(afterStop).toBeGreaterThanOrEqual(1);
    expect(afterStop).toBeLessThan(100); // disabled job never ran
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(enabledRuns).toBe(afterStop); // no more runs after stop
    const statuses = scheduler.statuses();
    expect(statuses.find((s) => s.name === "deskid-reconcile")?.enabled).toBe(false);
  });
});
