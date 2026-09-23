import type { ProxyEnv } from "@vyaya/config";
import {
  ClickHouseLogSink,
  RetryQueueLogSink,
  type WrappedDek,
} from "@vyaya/core";
import { createDb } from "@vyaya/db";
import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import type postgres from "postgres";
import type { ProxyAppDeps } from "./app.js";
import type { AuthStore, KeyCandidate, WorkspaceAuthInfo } from "./auth.js";
import { ApiKeyAuthenticator } from "./auth.js";
import { PostgresBodyStore } from "./bodies.js";
import { FeatureTagChecker, type FeatureTagStore } from "./feature-tags.js";
import { createTracer, type ProxyTracer } from "./otel.js";
import {
  InMemorySlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";
import { WorkspacePostgresLogSink } from "./sinks.js";
import {
  HttpStripeApi,
  NoopUsageRecorder,
  StubStripeApi,
  StripeUsageRecorder,
  type OutboxInsertFn,
  type UsageRecorder,
} from "./stripe.js";

/**
 * Wiring: build every dependency of createProxyApp from validated env.
 * Kept separate from app.ts so tests can inject fakes for any boundary
 * (auth store, limiter, sink, fetch, tracer) without a database.
 */

export interface ProxyRuntime {
  deps: ProxyAppDeps;
  queue: RetryQueueLogSink;
  close(): Promise<void>;
}

/** Raw-SQL auth store over the DATABASE_URL connection. */
export class DbAuthStore implements AuthStore {
  readonly #client: postgres.Sql;

  constructor(client: postgres.Sql) {
    this.#client = client;
  }

  async findKeyCandidates(last4: string): Promise<KeyCandidate[]> {
    const rows = await this.#client<
      {
        id: string;
        workspace_id: string;
        key_hash: string;
        revoked_at: Date | null;
      }[]
    >`SELECT id::text, workspace_id::text, key_hash, revoked_at
      FROM api_keys
      WHERE key_prefix = 'vy_live' AND last4 = ${last4}`;
    return rows.map((r) => ({
      keyId: r.id,
      workspaceId: r.workspace_id,
      keyHash: r.key_hash,
      revokedAt: r.revoked_at,
    }));
  }

  async getWorkspaceAuthInfo(workspaceId: string): Promise<WorkspaceAuthInfo | null> {
    const rows = await this.#client<
      { log_bodies_enabled: boolean; wrapped_dek: WrappedDek | string | null }[]
    >`SELECT log_bodies_enabled, wrapped_dek FROM workspaces WHERE id = ${workspaceId}`;
    const row = rows[0];
    if (row === undefined) return null;
    // Defensive: depending on insert path (prepared vs simple), a jsonb
    // value may read back as its text form; normalize to the object shape.
    const wrappedDek =
      typeof row.wrapped_dek === "string"
        ? (JSON.parse(row.wrapped_dek) as WrappedDek)
        : row.wrapped_dek;
    return { logBodiesEnabled: row.log_bodies_enabled, wrappedDek };
  }
}

class DbFeatureTagStore implements FeatureTagStore {
  readonly #client: postgres.Sql;

  constructor(client: postgres.Sql) {
    this.#client = client;
  }

  async listTags(workspaceId: string): Promise<string[]> {
    const rows = await this.#client<{ tag: string }[]>`
      SELECT tag FROM feature_tag_allowlist WHERE workspace_id = ${workspaceId}`;
    return rows.map((r) => r.tag);
  }
}

function resolveUpstreamBaseUrl(env: ProxyEnv): string {
  if (env.upstream.mode === "kubemind") {
    // Per-workspace upstream overrides need a workspaces column the schema
    // does not have yet; v1 is env-only. See docs/ASSUMPTIONS.md.
    if (env.upstream.kubemindRouterUrl === undefined) {
      throw new Error("UPSTREAM_MODE=kubemind requires KUBEMIND_ROUTER_URL");
    }
    return env.upstream.kubemindRouterUrl;
  }
  return env.upstream.openAiBaseUrl;
}

export async function buildProxyRuntime(env: ProxyEnv): Promise<ProxyRuntime> {
  const logger: Logger = pino({
    level: env.logLevel,
    base: { service: "vyaya-proxy" },
    // Defense in depth: these must never appear even if a caller slips.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-vyaya-key",
        "body",
        "promptBody",
        "responseBody",
        "*.key",
      ],
      censor: "[redacted]",
    },
  });

  const { client } = createDb({ databaseUrl: env.databaseUrl });

  const innerSink =
    env.clickhouseUrl !== undefined
      ? new ClickHouseLogSink({ url: env.clickhouseUrl })
      : new WorkspacePostgresLogSink(client);
  const queue = new RetryQueueLogSink(innerSink);
  queue.start();

  const authenticator = new ApiKeyAuthenticator(new DbAuthStore(client));

  let rateLimiter: RateLimiter;
  if (env.redisUrl !== undefined) {
    const redis = new Redis(env.redisUrl, {
      // Commands must fail fast: rate limiting fails OPEN, so slow Redis
      // must not stall the request path.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
      commandTimeout: 500,
      lazyConnect: false,
    });
    redis.on("error", (err) => logger.warn({ err }, "redis connection error"));
    rateLimiter = new RedisSlidingWindowRateLimiter({
      limit: env.rateLimitRequestsPerMinute,
      windowMs: 60_000,
      redis,
      logger,
    });
  } else {
    rateLimiter = new InMemorySlidingWindowRateLimiter({
      limit: env.rateLimitRequestsPerMinute,
      windowMs: 60_000,
    });
  }

  const bodyStore = env.logBodies
    ? new PostgresBodyStore(client, env.masterEncryptionKey, logger)
    : null;
  bodyStore?.start();

  let usageRecorder: UsageRecorder = new NoopUsageRecorder();
  if (env.stripe.enabled) {
    const insertOutbox: OutboxInsertFn = async (row) => {
      // unsafe + prepare:false + ::jsonb for payload — see bodies.ts note.
      await client.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [
          row.workspaceId,
        ]);
        await tx.unsafe(
          `INSERT INTO stripe_meter_events
            (workspace_id, request_id, event_name, idempotency_key, payload)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            row.workspaceId,
            row.requestId,
            row.eventName,
            row.idempotencyKey,
            JSON.stringify(row.payload),
          ],
          { prepare: false },
        );
      });
    };
    usageRecorder = new StripeUsageRecorder({
      api:
        env.stripe.secretKey !== undefined
          ? new HttpStripeApi({ secretKey: env.stripe.secretKey })
          : new StubStripeApi(),
      eventName: env.stripe.meterEventName,
      insertOutbox,
      logger,
    });
  }

  const tracer = await createTracer({
    enabled: env.sentinel.enabled,
    otelUrl: env.sentinel.otelUrl,
    serviceName: "vyaya-proxy",
    logger,
  });

  return {
    deps: {
      logger,
      authenticator,
      rateLimiter,
      sink: queue,
      queueMetrics: () => queue.metrics(),
      bodyStore,
      usageRecorder,
      tracer,
      featureTags: new FeatureTagChecker(
        new DbFeatureTagStore(client),
        env.featureTagAllowlist,
      ),
      upstreamBaseUrl: resolveUpstreamBaseUrl(env),
      upstreamApiKey: env.upstream.openAiApiKey,
      logBodies: env.logBodies,
    },
    queue,
    async close() {
      bodyStore?.stop();
      queue.stop();
      await queue.flush().catch(() => {});
      await bodyStore?.flush().catch(() => {});
      await rateLimiter.close();
      await tracer.shutdown();
      await client.end({ timeout: 5 });
    },
  };
}
