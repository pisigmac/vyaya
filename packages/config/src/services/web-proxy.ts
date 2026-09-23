import { z } from "zod";
import {
  boolField,
  hexKey32Field,
  intField,
  logLevelField,
  nodeEnvField,
  optionalString,
  optionalUrl,
  portField,
  requiredUrl,
} from "../shared.js";

const deskIdFields = {
  AUTH_MODE: z.enum(["dev", "deskid"]).default("dev"),
  DESKID_ISSUER: z.string().min(1),
  DESKID_JWKS_URL: requiredUrl,
};

export const webEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    WEB_PORT: portField(3000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: optionalString,
    ...deskIdFields,
    DESKID_BASE_URL: requiredUrl,
    AUTH_SPA_CALLBACK_URL: requiredUrl,
    SESSION_COOKIE_SECRET: z
      .string()
      .min(32, "SESSION_COOKIE_SECRET must be at least 32 characters"),
    /** Bearer token for DeskId admin APIs (grants). Empty for mock-deskid. */
    DESKID_ADMIN_TOKEN: optionalString,
    /** Session cookie lifetime. Default 12h. */
    SESSION_TTL_SEC: intField(43_200, { min: 300 }),
    /** Where the web BFF sends onboarding test requests (the proxy). */
    PROXY_BASE_URL: z.url().default("http://localhost:8787"),
    /**
     * Worker CLI entrypoint used by the DEV ONLY "run the classifier now"
     * endpoint (apps/web spawns it with --job classify --once). Unset = the
     * endpoint returns manual instructions instead.
     */
    WORKER_CLI_PATH: optionalString,
    /**
     * Where the worker writes report PDFs. The web app reads from the same
     * path to serve downloads (shared volume in compose).
     */
    REPORT_OUTPUT_DIR: z.string().default("reports"),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.WEB_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    auth: {
      mode: env.AUTH_MODE,
      deskIdIssuer: env.DESKID_ISSUER,
      deskIdJwksUrl: env.DESKID_JWKS_URL,
      deskIdBaseUrl: env.DESKID_BASE_URL,
      deskIdAdminToken: env.DESKID_ADMIN_TOKEN,
      spaCallbackUrl: env.AUTH_SPA_CALLBACK_URL,
      sessionCookieSecret: env.SESSION_COOKIE_SECRET,
      sessionTtlSec: env.SESSION_TTL_SEC,
    },
    proxyBaseUrl: env.PROXY_BASE_URL,
    workerCliPath: env.WORKER_CLI_PATH,
    reportOutputDir: env.REPORT_OUTPUT_DIR,
  }));

export type WebEnv = z.output<typeof webEnvSchema>;

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  return webEnvSchema.parse(source);
}

const upstreamFields = {
  UPSTREAM_MODE: z.enum(["openai", "kubemind"]).default("openai"),
  OPENAI_BASE_URL: z.url().default("http://localhost:8788"),
  OPENAI_API_KEY: optionalString,
  KUBEMIND_ROUTER_URL: optionalUrl,
};

const sentinelFields = {
  SENTINEL_ENABLED: boolField(false),
  SENTINEL_OTEL_URL: optionalUrl,
};

export const proxyEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    PROXY_PORT: portField(8787),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: optionalString,
    CLICKHOUSE_URL: optionalUrl,
    ...deskIdFields,
    MASTER_ENCRYPTION_KEY: hexKey32Field,
    LOG_BODIES: boolField(false),
    ...upstreamFields,
    RATE_LIMIT_REQUESTS_PER_MINUTE: intField(600, { min: 1 }),
    FEATURE_TAG_ALLOWLIST: z
      .string()
      .optional()
      .transform((v) =>
        v === undefined || v.trim() === ""
          ? []
          : v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
      ),
    STRIPE_ENABLED: boolField(false),
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_METER_EVENT_NAME: z.string().default("vyaya.llm_tokens"),
    ...sentinelFields,
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PROXY_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    clickhouseUrl: env.CLICKHOUSE_URL,
    auth: {
      mode: env.AUTH_MODE,
      deskIdIssuer: env.DESKID_ISSUER,
      deskIdJwksUrl: env.DESKID_JWKS_URL,
    },
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY,
    logBodies: env.LOG_BODIES,
    upstream: {
      mode: env.UPSTREAM_MODE,
      openAiBaseUrl: env.OPENAI_BASE_URL,
      openAiApiKey: env.OPENAI_API_KEY,
      kubemindRouterUrl: env.KUBEMIND_ROUTER_URL,
    },
    rateLimitRequestsPerMinute: env.RATE_LIMIT_REQUESTS_PER_MINUTE,
    featureTagAllowlist: env.FEATURE_TAG_ALLOWLIST,
    stripe: {
      enabled: env.STRIPE_ENABLED,
      secretKey: env.STRIPE_SECRET_KEY,
      meterEventName: env.STRIPE_METER_EVENT_NAME,
    },
    sentinel: {
      enabled: env.SENTINEL_ENABLED,
      otelUrl: env.SENTINEL_OTEL_URL,
    },
  }));

export type ProxyEnv = z.output<typeof proxyEnvSchema>;

export function loadProxyEnv(
  source: NodeJS.ProcessEnv = process.env,
): ProxyEnv {
  return proxyEnvSchema.parse(source);
}

export { upstreamFields, sentinelFields, deskIdFields };
