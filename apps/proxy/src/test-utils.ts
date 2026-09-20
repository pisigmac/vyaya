/**
 * Shared test harness for the proxy: real HTTP servers on ephemeral ports
 * (mock-openai as upstream + the proxy itself), a collecting LogSink, and a
 * fake auth store with a real argon2id-hashed key.
 */
import { serve, type ServerType } from "@hono/node-server";
import type { LogSink, RequestLog, WrappedDek } from "@vyaya/core";
import { generateApiKey, hashApiKey } from "@vyaya/db";
import { createApp as createMockApp } from "@vyaya/mock-openai/app";
import { pino, type Logger } from "pino";
import type { AddressInfo } from "node:net";
import { createProxyApp, type ProxyAppDeps } from "./app.js";
import { ApiKeyAuthenticator, type AuthStore } from "./auth.js";
import type { PostgresBodyStore } from "./bodies.js";
import { FeatureTagChecker, type FeatureTagStore } from "./feature-tags.js";
import { createNoopTracer } from "./otel.js";
import { InMemorySlidingWindowRateLimiter } from "./rate-limit.js";
import { NoopUsageRecorder, type UsageRecorder } from "./stripe.js";

export const TEST_WORKSPACE_ID = "00000000-0000-4000-a000-00000000c001";
export const TEST_KEY_ID = "00000000-0000-4000-a000-00000000c002";

export const silentLogger: Logger = pino({ level: "silent" });

/** LogSink that records every write; can be told to fail (backend DOWN). */
export class CollectingSink implements LogSink {
  logs: RequestLog[] = [];
  failing = false;
  writes = 0;

  write(log: RequestLog): Promise<void> {
    this.writes += 1;
    if (this.failing) return Promise.reject(new Error("sink down"));
    this.logs.push(log);
    return Promise.resolve();
  }

  healthy(): boolean {
    return !this.failing;
  }
}

export class FakeAuthStore implements AuthStore {
  readonly plaintext: string;
  readonly hash: string;
  workspaceInfo = {
    logBodiesEnabled: false,
    wrappedDek: null as WrappedDek | null,
  };
  candidatesCalls = 0;
  failNext = false;

  private constructor(plaintext: string, hash: string) {
    this.plaintext = plaintext;
    this.hash = hash;
  }

  static async create(): Promise<FakeAuthStore> {
    const key = generateApiKey();
    const hash = await hashApiKey(key.plaintext);
    return new FakeAuthStore(key.plaintext, hash);
  }

  findKeyCandidates(last4: string) {
    this.candidatesCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("db down"));
    }
    if (this.plaintext.slice(-4) !== last4) return Promise.resolve([]);
    return Promise.resolve([
      {
        keyId: TEST_KEY_ID,
        workspaceId: TEST_WORKSPACE_ID,
        keyHash: this.hash,
        revokedAt: null as Date | null,
      },
    ]);
  }

  getWorkspaceAuthInfo() {
    return Promise.resolve(this.workspaceInfo);
  }

  /** Mark the stored key revoked. */
  revokedStore(): AuthStore {
    const self = this;
    return {
      findKeyCandidates: (last4: string) =>
        self.findKeyCandidates(last4).then((rows) =>
          rows.map((r) => ({ ...r, revokedAt: new Date() })),
        ),
      getWorkspaceAuthInfo: () => self.getWorkspaceAuthInfo(),
    };
  }
}

export class FakeTagStore implements FeatureTagStore {
  tags: string[] = [];
  failNext = false;

  listTags(): Promise<string[]> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("tag store down"));
    }
    return Promise.resolve(this.tags);
  }
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  fetch: (req: Request) => Response | Promise<Response>,
): Promise<RunningServer> {
  const server: ServerType = serve({ fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export async function startMockUpstream(config?: {
  latencyMs?: number;
  seed?: number;
}): Promise<RunningServer> {
  const app = createMockApp({
    latencyMs: config?.latencyMs ?? 0,
    latencyJitterMs: 0,
    failureRate: 0,
    seed: config?.seed ?? 42,
  });
  return startHttpServer(app.fetch);
}

export interface TestProxyOptions {
  sink?: LogSink;
  queueMetrics?: () => import("@vyaya/core").RetryQueueMetrics;
  authStore?: AuthStore;
  authenticator?: ApiKeyAuthenticator;
  rateLimiter?: InMemorySlidingWindowRateLimiter;
  tagStore?: FeatureTagStore;
  envAllowlist?: string[];
  usageRecorder?: UsageRecorder;
  bodyStore?: PostgresBodyStore | null;
  logBodies?: boolean;
  upstream: RunningServer;
  fetchFn?: typeof fetch;
}

export interface TestProxy extends RunningServer {
  sink: CollectingSink;
  authStore: FakeAuthStore;
  tagStore: FakeTagStore;
  apiKey: string;
  limiter: InMemorySlidingWindowRateLimiter;
  deps: ProxyAppDeps;
}

export async function startTestProxy(options: TestProxyOptions): Promise<TestProxy> {
  const sink = options.sink instanceof CollectingSink || options.sink === undefined
    ? (options.sink ?? new CollectingSink())
    : options.sink;
  const authStore = options.authStore ?? (await FakeAuthStore.create());
  const authenticator =
    options.authenticator ?? new ApiKeyAuthenticator(authStore);
  const tagStore = options.tagStore ?? new FakeTagStore();
  const limiter =
    options.rateLimiter ??
    new InMemorySlidingWindowRateLimiter({ limit: 10_000, windowMs: 60_000 });
  const deps: ProxyAppDeps = {
    logger: silentLogger,
    authenticator,
    rateLimiter: limiter,
    sink,
    queueMetrics: options.queueMetrics ?? (() => ({
      enqueued: 0,
      written: 0,
      droppedBackpressure: 0,
      droppedExhausted: 0,
      writeFailures: 0,
      flushCount: 0,
      queueDepth: 0,
    })),
    bodyStore: options.bodyStore ?? null,
    usageRecorder: options.usageRecorder ?? new NoopUsageRecorder(),
    tracer: createNoopTracer(),
    featureTags: new FeatureTagChecker(tagStore, options.envAllowlist ?? []),
    upstreamBaseUrl: options.upstream.url,
    upstreamApiKey: undefined,
    logBodies: options.logBodies ?? false,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  };
  const app = createProxyApp(deps);
  const server = await startHttpServer(app.fetch);
  return {
    ...server,
    sink: sink as CollectingSink,
    authStore: authStore as FakeAuthStore,
    tagStore: tagStore as FakeTagStore,
    apiKey: (authStore as FakeAuthStore).plaintext,
    limiter,
    deps,
  };
}

export function chatRequestBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Summarize Q3 spend anomalies." },
    ],
    ...extra,
  };
}

export async function postToProxy(
  proxy: TestProxy,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${proxy.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vyaya-key": proxy.apiKey,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Wait until a condition holds (poll 25ms), else throw. */
export async function eventually(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
