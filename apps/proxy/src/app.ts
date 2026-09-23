import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Logger } from "pino";
import {
  computeCost,
  estimateChatPromptTokens,
  estimateTokens,
  normalizeChatMessages,
  normalizeEmbeddingInput,
  promptHashHex,
  requestLogSchema,
  UnknownModelPriceError,
  type LogSink,
  type RequestLog,
  type RequestStatus,
  type RetryQueueMetrics,
  type SchemaValidationResult,
} from "@vyaya/core";
import {
  ApiKeyAuthenticator,
  AuthUnavailableError,
  type AuthResult,
} from "./auth.js";
import type { PostgresBodyStore } from "./bodies.js";
import { parseRequestFacts, type RequestFacts } from "./extract.js";
import type { FeatureTagChecker } from "./feature-tags.js";
import {
  API_KEY_HEADER,
  openAiError,
  parseVyayaHeaders,
  REQUEST_ID_HEADER,
} from "./headers.js";
import type { ProxyTracer } from "./otel.js";
import type { RateLimiter } from "./rate-limit.js";
import { validateResponseFormat } from "./schema-check.js";
import type { UsageRecorder } from "./stripe.js";
import {
  extractFromBufferedJson,
  extractFromSse,
  tapStream,
  type ExtractedResponse,
} from "./tap.js";

/**
 * apps/proxy — the observe-only LLM traffic proxy.
 *
 * Hard rules honored here (see BUILD_PROMPT.md PROXY CONTRACT):
 *   - Requests stream end-to-end. The response body is piped through a
 *     byte-faithful tap; logging happens after the client has the bytes.
 *   - Logging NEVER blocks, mutates, or fails a request. The sink is a
 *     core RetryQueueLogSink (fire-and-forget, backpressure drop).
 *   - Costs come from the versioned price table in @vyaya/core. Anything
 *     the client says about cost is ignored.
 *   - Fail-open for observability dependencies; fail-closed only for
 *     auth (we cannot attribute a request without a key) and the upstream
 *     itself.
 */

export interface ProxyAppDeps {
  logger: Logger;
  authenticator: ApiKeyAuthenticator;
  rateLimiter: RateLimiter;
  /** The retry-queue-wrapped sink (write never rejects). */
  sink: LogSink;
  queueMetrics: () => RetryQueueMetrics;
  bodyStore: PostgresBodyStore | null;
  usageRecorder: UsageRecorder;
  tracer: ProxyTracer;
  featureTags: FeatureTagChecker;
  upstreamBaseUrl: string;
  upstreamApiKey: string | undefined;
  /** Log bodies master switch (env LOG_BODIES); workspace opt-in checked too. */
  logBodies: boolean;
  fetchFn?: typeof fetch;
}

type ProxiedEndpoint = "/v1/chat/completions" | "/v1/embeddings";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Response headers we recompute (the tap changes framing, not bytes). */
const RESPONSE_STRIP = new Set([
  ...HOP_BY_HOP,
  // We request identity encoding from upstream; never forward a stale
  // encoding label for bytes we tapped.
  "content-encoding",
]);

interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
}

function elapsedMs(startedMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedMs));
}

function statusOf(upstreamStatus: number, completed: boolean): RequestStatus {
  if (!completed) return "client_disconnect";
  return upstreamStatus < 400 ? "success" : "error";
}

/** Header copy for the upstream call: drop hop-by-hop + client auth. */
function buildUpstreamHeaders(
  c: Context,
  upstreamApiKey: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization") continue; // client auth never crosses
    if (lower.startsWith("x-vyaya-")) continue; // consumed by the proxy
    if (lower === "accept-encoding") continue; // we require identity below
    out[lower] = value;
  }
  out["accept-encoding"] = "identity";
  if (upstreamApiKey !== undefined && upstreamApiKey !== "") {
    out["authorization"] = `Bearer ${upstreamApiKey}`;
  }
  return out;
}

function buildResponseHeaders(
  upstreamHeaders: Headers,
  requestId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  upstreamHeaders.forEach((value, name) => {
    if (RESPONSE_STRIP.has(name.toLowerCase())) return;
    out[name.toLowerCase()] = value;
  });
  out[REQUEST_ID_HEADER] = requestId;
  return out;
}

function resolveTokens(
  facts: RequestFacts,
  extracted: ExtractedResponse,
  endpoint: ProxiedEndpoint,
): UsageTokens {
  if (extracted.usage !== null) return extracted.usage;
  // No usage reported (stream without include_usage, or error body).
  // Estimate deterministically and document; never trust client claims.
  if (endpoint === "/v1/chat/completions") {
    const promptTokens =
      facts.messages !== null ? estimateChatPromptTokens(facts.messages) : 0;
    const completionTokens =
      extracted.contentText !== null ? estimateTokens(extracted.contentText) : 0;
    return { promptTokens, completionTokens };
  }
  const input = facts.embeddingInput;
  const text =
    input === null ? "" : typeof input === "string" ? input : input.join("\n");
  return { promptTokens: estimateTokens(text), completionTokens: 0 };
}

function resolveCost(
  model: string,
  tokens: UsageTokens,
  occurredAtMs: number,
  log: Logger,
): { total: number; input: number; output: number } {
  try {
    const cost = computeCost({
      model,
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      at: new Date(occurredAtMs),
    });
    return {
      total: cost.totalCostUsd,
      input: cost.inputCostUsd,
      output: cost.outputCostUsd,
    };
  } catch (err) {
    if (err instanceof UnknownModelPriceError) {
      log.warn({ model }, "no price table entry for model; cost logged as 0");
      return { total: 0, input: 0, output: 0 };
    }
    throw err;
  }
}

function resolvePromptHash(
  facts: RequestFacts,
  bodyText: string,
  endpoint: ProxiedEndpoint,
): string {
  if (endpoint === "/v1/chat/completions" && facts.messages !== null) {
    return promptHashHex(normalizeChatMessages(facts.messages));
  }
  if (endpoint === "/v1/embeddings" && facts.embeddingInput !== null) {
    return promptHashHex(normalizeEmbeddingInput(facts.embeddingInput));
  }
  // Unparseable body: hash the raw bytes so retries still cluster.
  return promptHashHex(bodyText);
}

export function createProxyApp(deps: ProxyAppDeps): Hono {
  const app = new Hono();
  const fetchFn = deps.fetchFn ?? fetch;

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      service: "vyaya-proxy",
      queue: deps.queueMetrics(),
    }),
  );

  app.post("/v1/chat/completions", (c) => proxyHandler(c, "/v1/chat/completions"));
  app.post("/v1/embeddings", (c) => proxyHandler(c, "/v1/embeddings"));

  return app;

  async function proxyHandler(
    c: Context,
    endpoint: ProxiedEndpoint,
  ): Promise<Response> {
    const startedMs = performance.now();
    const occurredAtMs = Date.now();
    const headers = parseVyayaHeaders((name) => c.req.header(name));
    const requestId = headers.clientRequestId ?? randomUUID();
    const log = deps.logger.child({ requestId });

    // --- Auth (fail-closed: an unattributable request cannot be metered) ---
    const apiKey = c.req.header(API_KEY_HEADER);
    if (apiKey === undefined || apiKey.trim() === "") {
      return c.json(
        openAiError("missing X-Vyaya-Key header", "invalid_request_error", "missing_api_key"),
        401,
      );
    }
    let auth: AuthResult;
    try {
      const resolved = await deps.authenticator.authenticate(apiKey.trim());
      if (resolved === null) {
        return c.json(
          openAiError("invalid or revoked API key", "invalid_request_error", "invalid_api_key"),
          401,
        );
      }
      auth = resolved;
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        log.warn("auth store unavailable");
        return c.json(
          openAiError("authentication backend unavailable", "server_error", "auth_unavailable"),
          503,
        );
      }
      throw err;
    }

    // --- Rate limit (per API key, sliding window) ---
    const rl = await deps.rateLimiter.consume(`apikey:${auth.keyId}`);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify(
          openAiError("rate limit exceeded", "rate_limit_error", "rate_limit_exceeded"),
        ),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))),
            [REQUEST_ID_HEADER]: requestId,
          },
        },
      );
    }

    // --- Read + best-effort parse of the request body ---
    const bodyText = await c.req.text();
    const facts = parseRequestFacts(bodyText, endpoint);

    // --- Feature tag allowlist (rejected tags are dropped, never fatal) ---
    const featureTag = await deps.featureTags.resolve(
      auth.workspaceId,
      headers.featureTagRaw,
    );
    if (headers.featureTagRaw !== null && featureTag === null) {
      log.warn({ tag: headers.featureTagRaw }, "feature tag rejected by allowlist");
    }

    const span = deps.tracer.startSpan(`proxy ${endpoint}`, {
      "vyaya.workspace_id": auth.workspaceId,
      "vyaya.request_id": requestId,
      "llm.model": facts.model,
      "http.endpoint": endpoint,
    });

    let finalized = false;
    /** Fire-and-forget logging continuation. Never throws to the client. */
    const finalize = (input: {
      status: RequestStatus;
      latencyMs: number;
      extracted: ExtractedResponse;
      completed: boolean;
      responseBody: string | null;
    }): void => {
      if (finalized) return;
      finalized = true;
      try {
        // Retain provider-reported usage even on a failed stream. Without
        // usage evidence, incomplete attempts record zero rather than estimates.
        const tokens =
          input.extracted.usage ?? (input.status !== "success"
            ? { promptTokens: 0, completionTokens: 0 }
            : resolveTokens(facts, input.extracted, endpoint));
        const cost = resolveCost(facts.model, tokens, occurredAtMs, log);
        const schemaValidation: SchemaValidationResult =
          input.status === "success"
            ? validateResponseFormat(facts.responseFormat, input.extracted.contentText)
            : "not_requested";
        const responseConsumed =
          input.completed && headers.consumedSignal !== false;

        const record: RequestLog = {
          requestId,
          workspaceId: auth.workspaceId,
          occurredAtMs,
          model: facts.model,
          endpoint,
          latencyMs: input.latencyMs,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          maxTokens: facts.maxTokens,
          costUsd: cost.total,
          inputCostUsd: cost.input,
          outputCostUsd: cost.output,
          promptHash: resolvePromptHash(facts, bodyText, endpoint),
          sessionId: headers.sessionId,
          featureTag,
          status: input.status,
          schemaValidation,
          retryAttempt: headers.retryAttempt,
          retryOf: headers.retryOf,
          responseConsumed,
          promptText: null,
        };
        const parsed = requestLogSchema.safeParse(record);
        if (!parsed.success) {
          log.error("request log failed schema validation; dropped");
          return;
        }
        // RetryQueueLogSink.write resolves immediately (fire-and-forget).
        deps.sink
          .write(record)
          .catch((err) => log.warn({ err }, "sink write rejected (unexpected)"));

        if (
          deps.logBodies &&
          deps.bodyStore !== null &&
          auth.logBodiesEnabled &&
          auth.wrappedDek !== null
        ) {
          deps.bodyStore.store({
            requestId,
            workspaceId: auth.workspaceId,
            promptBody: bodyText,
            responseBody: input.responseBody,
            wrappedDek: auth.wrappedDek,
          });
        }

        deps.usageRecorder.record({
          workspaceId: auth.workspaceId,
          requestId,
          totalTokens: tokens.promptTokens + tokens.completionTokens,
          atMs: occurredAtMs,
        });
        span.setAttribute("vyaya.status", input.status);
        span.setAttribute("vyaya.latency_ms", input.latencyMs);
      } catch (err) {
        log.warn({ err }, "post-response logging continuation failed");
      } finally {
        span.end();
      }
    };

    // --- Forward upstream ---
    let upstream: Response;
    try {
      upstream = await fetchFn(`${deps.upstreamBaseUrl}${endpoint}`, {
        method: "POST",
        headers: buildUpstreamHeaders(c, deps.upstreamApiKey),
        body: bodyText,
      });
    } catch (err) {
      log.warn({ err }, "upstream fetch failed");
      finalize({
        status: "error",
        latencyMs: elapsedMs(startedMs),
        extracted: { usage: null, contentText: null, model: null },
        completed: false,
        responseBody: null,
      });
      return c.json(
        openAiError("upstream unavailable", "server_error", "upstream_unavailable"),
        502,
      );
    }

    const upstreamBody = upstream.body;
    if (upstreamBody === null) {
      finalize({
        status: statusOf(upstream.status, true),
        latencyMs: elapsedMs(startedMs),
        extracted: { usage: null, contentText: null, model: null },
        completed: true,
        responseBody: null,
      });
      return new Response(null, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream.headers, requestId),
      });
    }

    const tap = tapStream(upstreamBody);
    void tap.done.then((outcome) => {
      const isSse =
        facts.stream ||
        (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      const extracted = isSse
        ? extractFromSse(outcome.bodyText)
        : extractFromBufferedJson(outcome.bodyText);
      finalize({
        status: outcome.terminal === "upstream_error"
          ? "error"
          : statusOf(upstream.status, outcome.completed),
        latencyMs: elapsedMs(startedMs),
        extracted,
        completed: outcome.completed,
        responseBody: outcome.bodyText.length > 0 ? outcome.bodyText : null,
      });
    });

    return new Response(tap.stream, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream.headers, requestId),
    });
  }
}
