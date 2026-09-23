import { loadWorkerEnv, type WorkerEnv } from "@vyaya/config";
import { buildWorkerRuntime, type WorkerRuntime } from "./deps.js";
import { closeHealth, createHealthServer, listenHealth } from "./health.js";
import { runClassifyJob } from "./jobs/classify.js";
import { runDeskIdReconcile } from "./jobs/deskid-reconcile.js";
import { runRetentionSweep } from "./jobs/retention-sweeper.js";
import { runWeeklyReportJob } from "./jobs/weekly-report.js";
import { Scheduler, type JobDefinition } from "./scheduler.js";

/** CLI entry: validate env, wire dependencies, schedule jobs, serve health. */

export const JOB_NAMES = [
  "classify",
  "weekly-report",
  "retention-sweeper",
  "deskid-reconcile",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface CliArgs {
  /** Run only this job (with --once) or restrict scheduling to it. */
  job: JobName | null;
  /** Run once and exit instead of scheduling. */
  once: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let job: JobName | null = null;
  let once = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") {
      once = true;
    } else if (arg === "--job") {
      const name = argv[i + 1];
      if (name === undefined || !(JOB_NAMES as readonly string[]).includes(name)) {
        throw new Error(
          `--job must be one of: ${JOB_NAMES.join(", ")} (got ${JSON.stringify(name)})`,
        );
      }
      job = name as JobName;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { job, once };
}

export function buildJobs(env: WorkerEnv, runtime: WorkerRuntime): JobDefinition[] {
  const { db, logger, tracer, emailSender } = runtime;
  return [
    {
      name: "classify",
      intervalMs: env.jobs.classifyIntervalMs,
      enabled: true,
      run: () =>
        runClassifyJob({
          db,
          thresholds: env.detectors,
          batchSize: env.jobs.classifyBatchSize,
          masterKeyHex: env.masterEncryptionKey,
          tracer,
          logger,
        }).then(() => undefined),
    },
    {
      name: "weekly-report",
      intervalMs: env.jobs.weeklyReportIntervalMs,
      enabled: true,
      run: () =>
        runWeeklyReportJob({
          db,
          emailSender,
          emailFrom: env.email.from,
          reportOutputDir: env.reportOutputDir,
          logger,
        }).then(() => undefined),
    },
    {
      name: "retention-sweeper",
      intervalMs: env.jobs.retentionSweepIntervalMs,
      enabled: true,
      run: () =>
        runRetentionSweep({
          db,
          bodyRetentionDays: env.retention.bodyDays,
          metadataRetentionDays: env.retention.metadataDays,
          logger,
        }).then(() => undefined),
    },
    {
      name: "deskid-reconcile",
      intervalMs: env.deskId.reconcileIntervalMs,
      enabled: env.deskId.reconcileEnabled,
      run: () =>
        runDeskIdReconcile({
          db,
          enabled: env.deskId.reconcileEnabled,
          baseUrl: env.deskId.baseUrl,
          adminToken: env.deskId.adminToken,
          logger,
        }).then(() => undefined),
    },
  ];
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const env = loadWorkerEnv();
  const runtime = await buildWorkerRuntime(env);
  const jobs = buildJobs(env, runtime).filter(
    (job) => args.job === null || job.name === args.job,
  );
  const scheduler = new Scheduler({
    jobs,
    lock: runtime.lock,
    logger: runtime.logger,
    tracer: runtime.tracer,
  });

  if (args.once) {
    let failed = false;
    for (const job of jobs) {
      const status = await scheduler.runNow(job.name);
      if (status.lastOutcome === "failed") failed = true;
    }
    await runtime.close();
    process.exit(failed ? 1 : 0);
  }

  const health = createHealthServer(() => scheduler.statuses());
  await listenHealth(health, env.port);
  runtime.logger.info({ port: env.port }, "vyaya-worker health endpoint listening");
  scheduler.start();

  const shutdown = (signal: string): void => {
    runtime.logger.info({ signal }, "shutting down");
    void (async () => {
      await scheduler.stop();
      await closeHealth(health).catch(() => {});
      await runtime.close();
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// CLI entry: node dist/index.js [--job <name>] [--once]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error("worker failed to start:", err);
    process.exit(1);
  });
}
