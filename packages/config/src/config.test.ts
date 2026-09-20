import { describe, expect, it } from "vitest";
import {
  loadDbEnv,
  loadMockDeskIdEnv,
  loadMockOpenAiEnv,
  loadProxyEnv,
  loadWebEnv,
  loadWorkerEnv,
} from "./index.js";

const MASTER_KEY = "a".repeat(64);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://vyaya:vyaya@localhost:5432/vyaya",
    DESKID_ISSUER: "http://localhost:8091",
    DESKID_JWKS_URL: "http://localhost:8091/.well-known/jwks.json",
    DESKID_BASE_URL: "http://localhost:8091",
    AUTH_SPA_CALLBACK_URL: "http://localhost:3000/auth/callback",
    SESSION_COOKIE_SECRET: "x".repeat(32),
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
  };
}

describe("loadProxyEnv", () => {
  it("applies documented defaults", () => {
    const env = loadProxyEnv(baseEnv());
    expect(env.port).toBe(8787);
    expect(env.auth.mode).toBe("dev");
    expect(env.logBodies).toBe(false);
    expect(env.upstream.mode).toBe("openai");
    expect(env.upstream.openAiBaseUrl).toBe("http://localhost:8788");
    expect(env.stripe.enabled).toBe(false);
    expect(env.sentinel.enabled).toBe(false);
    expect(env.rateLimitRequestsPerMinute).toBe(600);
    expect(env.featureTagAllowlist).toEqual([]);
    expect(env.clickhouseUrl).toBeUndefined();
  });

  it("rejects a missing DATABASE_URL", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    expect(() => loadProxyEnv(env)).toThrow();
  });

  it("rejects a malformed MASTER_ENCRYPTION_KEY", () => {
    expect(() =>
      loadProxyEnv({ ...baseEnv(), MASTER_ENCRYPTION_KEY: "not-hex" }),
    ).toThrow();
  });

  it("parses booleans and csv allowlist", () => {
    const env = loadProxyEnv({
      ...baseEnv(),
      LOG_BODIES: "true",
      STRIPE_ENABLED: "1",
      FEATURE_TAG_ALLOWLIST: " search , chat ,, ",
    });
    expect(env.logBodies).toBe(true);
    expect(env.stripe.enabled).toBe(true);
    expect(env.featureTagAllowlist).toEqual(["search", "chat"]);
  });

  it("rejects invalid boolean strings", () => {
    expect(() =>
      loadProxyEnv({ ...baseEnv(), LOG_BODIES: "maybe" }),
    ).toThrow();
  });
});

describe("loadWorkerEnv", () => {
  it("applies taxonomy detector thresholds by default", () => {
    const env = loadWorkerEnv(baseEnv());
    expect(env.detectors.retryStormMinAttempts).toBe(3);
    expect(env.detectors.retryStormWindowMs).toBe(60_000);
    expect(env.detectors.overprovisionedMinCalls).toBe(50);
    expect(env.detectors.overprovisionedMaxRatio).toBe(0.3);
    expect(env.retention.bodyDays).toBe(7);
    expect(env.retention.metadataDays).toBe(400);
    expect(env.deskId.reconcileEnabled).toBe(false);
    expect(env.jobs.classifyIntervalMs).toBe(86_400_000);
    expect(env.jobs.classifyBatchSize).toBe(5_000);
    expect(env.jobs.weeklyReportIntervalMs).toBe(21_600_000);
    expect(env.jobs.retentionSweepIntervalMs).toBe(3_600_000);
    expect(env.reportOutputDir).toBe("reports");
  });

  it("parses job interval and report overrides", () => {
    const env = loadWorkerEnv({
      ...baseEnv(),
      CLASSIFY_INTERVAL_MS: "60000",
      CLASSIFY_BATCH_SIZE: "25",
      WEEKLY_REPORT_INTERVAL_MS: "30000",
      RETENTION_SWEEP_INTERVAL_MS: "45000",
      REPORT_OUTPUT_DIR: "/tmp/vyaya-reports",
    });
    expect(env.jobs.classifyIntervalMs).toBe(60_000);
    expect(env.jobs.classifyBatchSize).toBe(25);
    expect(env.jobs.weeklyReportIntervalMs).toBe(30_000);
    expect(env.jobs.retentionSweepIntervalMs).toBe(45_000);
    expect(env.reportOutputDir).toBe("/tmp/vyaya-reports");
    expect(() =>
      loadWorkerEnv({ ...baseEnv(), CLASSIFY_INTERVAL_MS: "100" }),
    ).toThrow();
    expect(() =>
      loadWorkerEnv({ ...baseEnv(), CLASSIFY_BATCH_SIZE: "0" }),
    ).toThrow();
  });

  it("allows threshold overrides from env", () => {
    const env = loadWorkerEnv({
      ...baseEnv(),
      RETRY_STORM_MIN_ATTEMPTS: "5",
      OVERPROVISIONED_MAX_RATIO: "0.25",
    });
    expect(env.detectors.retryStormMinAttempts).toBe(5);
    expect(env.detectors.overprovisionedMaxRatio).toBe(0.25);
  });
});

describe("loadWebEnv", () => {
  it("loads with defaults", () => {
    const env = loadWebEnv(baseEnv());
    expect(env.port).toBe(3000);
    expect(env.auth.spaCallbackUrl).toBe(
      "http://localhost:3000/auth/callback",
    );
  });

  it("rejects short session secrets", () => {
    expect(() =>
      loadWebEnv({ ...baseEnv(), SESSION_COOKIE_SECRET: "short" }),
    ).toThrow();
  });

  it("applies web-specific defaults and overrides", () => {
    const env = loadWebEnv(baseEnv());
    expect(env.proxyBaseUrl).toBe("http://localhost:8787");
    expect(env.auth.sessionTtlSec).toBe(43_200);
    expect(env.auth.deskIdAdminToken).toBeUndefined();
    expect(env.reportOutputDir).toBe("reports");
    const overridden = loadWebEnv({
      ...baseEnv(),
      PROXY_BASE_URL: "http://proxy:8787",
      SESSION_TTL_SEC: "3600",
      DESKID_ADMIN_TOKEN: "admintoken",
      WORKER_CLI_PATH: "/srv/worker/dist/index.js",
    });
    expect(overridden.proxyBaseUrl).toBe("http://proxy:8787");
    expect(overridden.auth.sessionTtlSec).toBe(3600);
    expect(overridden.auth.deskIdAdminToken).toBe("admintoken");
    expect(overridden.workerCliPath).toBe("/srv/worker/dist/index.js");
  });
});

describe("mocks and db", () => {
  it("loadMockOpenAiEnv applies defaults", () => {
    const env = loadMockOpenAiEnv({});
    expect(env.port).toBe(8788);
    expect(env.seed).toBe(42);
    expect(env.failureRate).toBe(0);
  });

  it("loadMockDeskIdEnv derives issuer from port", () => {
    const env = loadMockDeskIdEnv({});
    expect(env.port).toBe(8091);
    expect(env.issuer).toBe("http://localhost:8091");
  });

  it("loadMockOpenAiEnv honors short aliases, canonical names win", () => {
    const alias = loadMockOpenAiEnv({
      MOCK_LATENCY_MS: "120",
      MOCK_FAIL_RATE: "0.5",
    });
    expect(alias.latencyMs).toBe(120);
    expect(alias.failureRate).toBe(0.5);
    const both = loadMockOpenAiEnv({
      MOCK_OPENAI_LATENCY_MS: "30",
      MOCK_LATENCY_MS: "120",
      MOCK_OPENAI_FAILURE_RATE: "0.1",
      MOCK_FAIL_RATE: "0.5",
    });
    expect(both.latencyMs).toBe(30);
    expect(both.failureRate).toBe(0.1);
  });

  it("loadMockDeskIdEnv defaults authMode to deskid (mock must opt in)", () => {
    const env = loadMockDeskIdEnv({});
    expect(env.authMode).toBe("deskid");
    expect(env.keysDir).toBe("keys");
    expect(env.tokenTtlSec).toBe(3600);
    expect(env.spaCallbackUrl).toBe("http://localhost:3000/auth/callback");
  });

  it("loadMockDeskIdEnv falls back to DESKID_ISSUER for the issuer claim", () => {
    const env = loadMockDeskIdEnv({
      AUTH_MODE: "dev",
      DESKID_ISSUER: "https://id.example.com",
    });
    expect(env.authMode).toBe("dev");
    expect(env.issuer).toBe("https://id.example.com");
    const explicit = loadMockDeskIdEnv({
      AUTH_MODE: "dev",
      DESKID_ISSUER: "https://id.example.com",
      MOCK_DESKID_ISSUER: "http://localhost:8091",
    });
    expect(explicit.issuer).toBe("http://localhost:8091");
  });

  it("loadDbEnv requires a postgres URL", () => {
    expect(() => loadDbEnv({ DATABASE_URL: "mysql://nope" })).toThrow();
    const env = loadDbEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/vyaya",
    });
    expect(env.postgres.user).toBe("vyaya");
    expect(env.postgres.port).toBe(5432);
  });
});
