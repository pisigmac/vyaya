import { z } from "zod";
import {
  intField,
  logLevelField,
  nodeEnvField,
  optionalString,
  optionalUrl,
  portField,
} from "../shared.js";

/** Optional non-negative int; used where a short alias env var can serve as a
 *  fallback for the canonical MOCK_OPENAI_* name. */
const optionalInt = (min = 0) => z.coerce.number().int().min(min).optional();
const optionalRate = z.coerce.number().min(0).max(1).optional();

export const mockOpenAiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    MOCK_OPENAI_PORT: portField(8788),
    MOCK_OPENAI_LATENCY_MS: optionalInt(),
    /** Short alias; MOCK_OPENAI_LATENCY_MS wins when both are set. */
    MOCK_LATENCY_MS: optionalInt(),
    MOCK_OPENAI_LATENCY_JITTER_MS: intField(0, { min: 0 }),
    MOCK_OPENAI_FAILURE_RATE: optionalRate,
    /** Short alias; MOCK_OPENAI_FAILURE_RATE wins when both are set. */
    MOCK_FAIL_RATE: optionalRate,
    MOCK_OPENAI_SEED: intField(42),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.MOCK_OPENAI_PORT,
    latencyMs: env.MOCK_OPENAI_LATENCY_MS ?? env.MOCK_LATENCY_MS ?? 50,
    latencyJitterMs: env.MOCK_OPENAI_LATENCY_JITTER_MS,
    failureRate: env.MOCK_OPENAI_FAILURE_RATE ?? env.MOCK_FAIL_RATE ?? 0,
    seed: env.MOCK_OPENAI_SEED,
  }));

export type MockOpenAiEnv = z.output<typeof mockOpenAiEnvSchema>;

export function loadMockOpenAiEnv(
  source: NodeJS.ProcessEnv = process.env,
): MockOpenAiEnv {
  return mockOpenAiEnvSchema.parse(source);
}

export const mockDeskIdEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    /**
     * DEV ONLY guard: the mock refuses to start unless AUTH_MODE=dev is set
     * explicitly. It defaults to "deskid" here (unlike the web/proxy schemas,
     * where "dev" is a convenience default) so that a missing AUTH_MODE can
     * never silently activate a mock identity provider.
     */
    AUTH_MODE: z.enum(["dev", "deskid"]).default("deskid"),
    MOCK_DESKID_PORT: portField(8091),
    MOCK_DESKID_ISSUER: optionalString,
    /** Fallback issuer when MOCK_DESKID_ISSUER is unset. */
    DESKID_ISSUER: optionalString,
    MOCK_DESKID_PRIVATE_KEY_PEM: optionalString,
    MOCK_DESKID_PUBLIC_KEY_PEM: optionalString,
    /** Directory holding the generated keypair. Defaults to ./keys. */
    MOCK_DESKID_KEYS_DIR: optionalString,
    /** Where the OAuth stub redirects browsers with a freshly issued token. */
    AUTH_SPA_CALLBACK_URL: optionalUrl,
    MOCK_DESKID_TOKEN_TTL_SEC: intField(3600, { min: 60 }),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    authMode: env.AUTH_MODE,
    port: env.MOCK_DESKID_PORT,
    issuer:
      env.MOCK_DESKID_ISSUER ??
      env.DESKID_ISSUER ??
      `http://localhost:${env.MOCK_DESKID_PORT}`,
    privateKeyPem: env.MOCK_DESKID_PRIVATE_KEY_PEM,
    publicKeyPem: env.MOCK_DESKID_PUBLIC_KEY_PEM,
    keysDir: env.MOCK_DESKID_KEYS_DIR ?? "keys",
    spaCallbackUrl:
      env.AUTH_SPA_CALLBACK_URL ?? "http://localhost:3000/auth/callback",
    tokenTtlSec: env.MOCK_DESKID_TOKEN_TTL_SEC,
  }));

export type MockDeskIdEnv = z.output<typeof mockDeskIdEnvSchema>;

export function loadMockDeskIdEnv(
  source: NodeJS.ProcessEnv = process.env,
): MockDeskIdEnv {
  return mockDeskIdEnvSchema.parse(source);
}
