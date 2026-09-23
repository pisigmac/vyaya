import type { Logger } from "pino";
import type { JobLock } from "./locks.js";
import type { WorkerTracer } from "./otel.js";

/**
 * In-process job scheduler. Each job runs on its own interval via chained
 * setTimeout (never overlapping itself); every run goes through the JobLock
 * and is wrapped in an OTel span (`worker.job.run`, duration recorded).
 * Statuses feed GET /healthz.
 */

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Disabled jobs are listed in /healthz but never scheduled. */
  enabled: boolean;
  run(): Promise<unknown>;
}

export interface JobStatus {
  name: string;
  enabled: boolean;
  running: boolean;
  runs: number;
  failures: number;
  /** ISO-8601 timestamps; null until the first run. */
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: "ok" | "failed" | "skipped_locked" | null;
  lastError: string | null;
}

export interface SchedulerOptions {
  jobs: JobDefinition[];
  lock: JobLock;
  logger: Logger;
  tracer: WorkerTracer;
  /**
   * Lock TTL per run. Must exceed the slowest expected run; on expiry the
   * next scheduler may start while the holder still runs (documented in
   * docs/ASSUMPTIONS.md — jobs are idempotent, so overlap is safe).
   */
  lockTtlMs?: number;
}

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

export class Scheduler {
  readonly #jobs: JobDefinition[];
  readonly #lock: JobLock;
  readonly #logger: Logger;
  readonly #tracer: WorkerTracer;
  readonly #lockTtlMs: number;
  readonly #statuses = new Map<string, JobStatus>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#jobs = options.jobs;
    this.#lock = options.lock;
    this.#logger = options.logger;
    this.#tracer = options.tracer;
    this.#lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    for (const job of this.#jobs) {
      this.#statuses.set(job.name, {
        name: job.name,
        enabled: job.enabled,
        running: false,
        runs: 0,
        failures: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastOutcome: null,
        lastError: null,
      });
    }
  }

  statuses(): JobStatus[] {
    return this.#jobs.map((job) => ({ ...this.#status(job.name) }));
  }

  /** Run one job immediately (used by --once CLI flags and tests). */
  async runNow(name: string): Promise<JobStatus> {
    const job = this.#jobs.find((j) => j.name === name);
    if (job === undefined) {
      throw new Error(`unknown job ${JSON.stringify(name)}`);
    }
    await this.#run(job);
    return { ...this.#status(name) };
  }

  /** Begin interval scheduling for every enabled job. Idempotent. */
  start(): void {
    this.#stopped = false;
    for (const job of this.#jobs) {
      if (!job.enabled || this.#timers.has(job.name)) continue;
      this.#schedule(job);
    }
  }

  /** Stop scheduling; in-flight runs are left to finish. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #schedule(job: JobDefinition): void {
    const timer = setTimeout(() => {
      this.#timers.delete(job.name);
      void this.#run(job).finally(() => {
        if (!this.#stopped) this.#schedule(job);
      });
    }, job.intervalMs);
    timer.unref();
    this.#timers.set(job.name, timer);
  }

  async #run(job: JobDefinition): Promise<void> {
    const status = this.#status(job.name);
    const token = await this.#lock
      .acquire(`vyaya:job:${job.name}`, this.#lockTtlMs)
      .catch((err: unknown) => {
        this.#logger.error({ err, job: job.name }, "job lock acquisition failed; skipping run");
        status.lastOutcome = "skipped_locked";
        status.lastError = err instanceof Error ? err.message : String(err);
        return null;
      });
    if (token === null) {
      if (status.lastOutcome !== "skipped_locked") status.lastOutcome = "skipped_locked";
      this.#logger.info({ job: job.name }, "job lock held elsewhere; skipping run");
      return;
    }

    const span = this.#tracer.startSpan("worker.job.run", { "job.name": job.name });
    const startedAt = new Date();
    status.running = true;
    status.runs += 1;
    status.lastStartedAt = startedAt.toISOString();
    const startMs = startedAt.getTime();
    try {
      await job.run();
      status.lastOutcome = "ok";
      status.lastError = null;
      span.setAttribute("job.outcome", "ok");
      this.#logger.info({ job: job.name, durationMs: Date.now() - startMs }, "job finished");
    } catch (err) {
      status.lastOutcome = "failed";
      status.failures += 1;
      status.lastError = err instanceof Error ? err.message : String(err);
      span.setAttribute("job.outcome", "failed");
      this.#logger.error({ err, job: job.name }, "job failed");
    } finally {
      status.running = false;
      status.lastFinishedAt = new Date().toISOString();
      span.setAttribute("job.duration_ms", Date.now() - startMs);
      span.end();
      await this.#lock.release(`vyaya:job:${job.name}`, token).catch(() => {});
    }
  }

  #status(name: string): JobStatus {
    const status = this.#statuses.get(name);
    if (status === undefined) throw new Error(`unknown job ${JSON.stringify(name)}`);
    return status;
  }
}
