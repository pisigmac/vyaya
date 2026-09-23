import type { WorkerEnv } from "@vyaya/config";
import { closeDb, createDb, type DbHandle } from "@vyaya/db";
import { pino, type Logger } from "pino";
import { createEmailSender, type EmailSender } from "./jobs/email.js";
import { InMemoryJobLock, RedisJobLock, type JobLock } from "./locks.js";
import { createTracer, type WorkerTracer } from "./otel.js";

/**
 * Wiring: build every dependency of the worker from validated env. Kept
 * separate from index.ts so tests can inject fakes for any boundary (lock,
 * sender, tracer, clock) without booting the CLI.
 */
export interface WorkerRuntime {
  env: WorkerEnv;
  db: DbHandle;
  logger: Logger;
  tracer: WorkerTracer;
  lock: JobLock;
  emailSender: EmailSender;
  close(): Promise<void>;
}

export async function buildWorkerRuntime(env: WorkerEnv): Promise<WorkerRuntime> {
  const logger: Logger = pino({
    level: env.logLevel,
    base: { service: "vyaya-worker" },
    redact: {
      paths: ["*.key", "*.apiKey", "promptBody", "responseBody", "body"],
      censor: "[redacted]",
    },
  });

  const db = createDb({ databaseUrl: env.databaseUrl });
  const tracer = await createTracer({
    enabled: env.sentinel.enabled,
    otelUrl: env.sentinel.otelUrl,
    serviceName: "vyaya-worker",
    logger,
  });
  const lock = env.redisUrl
    ? RedisJobLock.fromUrl(env.redisUrl)
    : new InMemoryJobLock();
  const emailSender = createEmailSender({
    resendApiKey: env.email.resendApiKey,
    from: env.email.from,
    logger,
  });

  let closed = false;
  return {
    env,
    db,
    logger,
    tracer,
    lock,
    emailSender,
    async close() {
      if (closed) return;
      closed = true;
      await lock.close().catch(() => {});
      await closeDb(db).catch(() => {});
      await tracer.shutdown();
    },
  };
}
