import { z } from "zod";
import {
  boolField,
  floatField,
  hexKey32Field,
  intField,
  logLevelField,
  nodeEnvField,
  optionalString,
  optionalUrl,
  portField,
  requiredUrl,
} from "../shared.js";
import { deskIdFields, sentinelFields } from "./web-proxy.js";

/**
 * Detector thresholds. Global defaults come from env; workspaces may override
 * per-workspace in the database (worker merges before running detectors).
 * Output keys deliberately match DetectorThresholds in @vyaya/core so the
 * worker can pass them straight through.
 */
export const detectorThresholdsRawSchema = z.object({
  RETRY_STORM_MIN_ATTEMPTS: intField(3, { min: 2 }),
  RETRY_STORM_WINDOW_MS: intField(60_000, { min: 1_000 }),
  GHOST_OUTPUT_MIN_AGE_MS: intField(300_000, { min: 0 }),
  CONTEXT_AMNESIA_JACCARD_THRESHOLD: floatField(0.6, { min: 0, max: 1 }),
  CONTEXT_AMNESIA_MIN_OVERLAP_TOKENS: intField(64, { min: 1 }),
  CONTEXT_AMNESIA_SHINGLE_SIZE: intField(3, { min: 1, max: 10 }),
  OVERPROVISIONED_MIN_CALLS: intField(50, { min: 2 }),
  OVERPROVISIONED_MAX_RATIO: floatField(0.3, { min: 0.01, max: 1 }),
  OVERPROVISIONED_RESERVATION_OVERHEAD: floatField(0.1, { min: 0, max: 1 }),
});

export const detectorThresholdsEnvSchema = detectorThresholdsRawSchema.transform(
  (env) => ({
    retryStormMinAttempts: env.RETRY_STORM_MIN_ATTEMPTS,
    retryStormWindowMs: env.RETRY_STORM_WINDOW_MS,
    ghostOutputMinAgeMs: env.GHOST_OUTPUT_MIN_AGE_MS,
    contextAmnesiaJaccardThreshold: env.CONTEXT_AMNESIA_JACCARD_THRESHOLD,
    contextAmnesiaMinOverlapTokens: env.CONTEXT_AMNESIA_MIN_OVERLAP_TOKENS,
    contextAmnesiaShingleSize: env.CONTEXT_AMNESIA_SHINGLE_SIZE,
    overprovisionedMinCalls: env.OVERPROVISIONED_MIN_CALLS,
    overprovisionedMaxRatio: env.OVERPROVISIONED_MAX_RATIO,
    overprovisionedReservationOverhead:
      env.OVERPROVISIONED_RESERVATION_OVERHEAD,
  }),
);

export type DetectorThresholdsEnv = z.output<
  typeof detectorThresholdsEnvSchema
>;

export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    WORKER_PORT: portField(8790),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: optionalString,
    CLICKHOUSE_URL: optionalUrl,
    ...deskIdFields,
    DESKID_BASE_URL: requiredUrl,
    DESKID_ADMIN_TOKEN: optionalString,
    DESKID_RECONCILE_ENABLED: boolField(false),
    DESKID_RECONCILE_INTERVAL_MS: intField(60_000, { min: 5_000 }),
    /** Nightly classifier cadence; --job classify --once bypasses it. */
    CLASSIFY_INTERVAL_MS: intField(86_400_000, { min: 5_000 }),
    /** request_logs loaded per workspace per classify transaction. */
    CLASSIFY_BATCH_SIZE: intField(5_000, { min: 1 }),
    /** Weekly-report cadence; the job itself decides when a week closes. */
    WEEKLY_REPORT_INTERVAL_MS: intField(21_600_000, { min: 5_000 }),
    /** Retention sweeper cadence. */
    RETENTION_SWEEP_INTERVAL_MS: intField(3_600_000, { min: 5_000 }),
    RESEND_API_KEY: optionalString,
    EMAIL_FROM: z.string().default("reports@vyaya.local"),
    /** Worker-local directory for generated report PDFs. */
    REPORT_OUTPUT_DIR: z.string().default("reports"),
    BODY_RETENTION_DAYS: intField(7, { min: 1 }),
    METADATA_RETENTION_DAYS: intField(400, { min: 1 }),
    MASTER_ENCRYPTION_KEY: hexKey32Field,
    ...sentinelFields,
    ...detectorThresholdsRawSchema.shape,
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.WORKER_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    clickhouseUrl: env.CLICKHOUSE_URL,
    auth: {
      mode: env.AUTH_MODE,
      deskIdIssuer: env.DESKID_ISSUER,
      deskIdJwksUrl: env.DESKID_JWKS_URL,
    },
    deskId: {
      baseUrl: env.DESKID_BASE_URL,
      adminToken: env.DESKID_ADMIN_TOKEN,
      reconcileEnabled: env.DESKID_RECONCILE_ENABLED,
      reconcileIntervalMs: env.DESKID_RECONCILE_INTERVAL_MS,
    },
    email: {
      resendApiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    },
    jobs: {
      classifyIntervalMs: env.CLASSIFY_INTERVAL_MS,
      classifyBatchSize: env.CLASSIFY_BATCH_SIZE,
      weeklyReportIntervalMs: env.WEEKLY_REPORT_INTERVAL_MS,
      retentionSweepIntervalMs: env.RETENTION_SWEEP_INTERVAL_MS,
    },
    reportOutputDir: env.REPORT_OUTPUT_DIR,
    retention: {
      bodyDays: env.BODY_RETENTION_DAYS,
      metadataDays: env.METADATA_RETENTION_DAYS,
    },
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY,
    sentinel: {
      enabled: env.SENTINEL_ENABLED,
      otelUrl: env.SENTINEL_OTEL_URL,
    },
    detectors: detectorThresholdsEnvSchema.parse(env),
  }));

export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(
  source: NodeJS.ProcessEnv = process.env,
): WorkerEnv {
  return workerEnvSchema.parse(source);
}
