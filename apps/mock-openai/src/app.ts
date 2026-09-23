import { Hono } from "hono";
import { z } from "zod";
import type { MockOpenAiEnv } from "@vyaya/config";
import {
  completionId,
  createdSeconds,
  desiredCompletionTokens,
  embeddingFor,
  estimateTokens,
  generateCompletionText,
  invalidValueForSchema,
  normalizeMessages,
  promptTokensFor,
  valueForSchema,
} from "./deterministic.js";

/**
 * apps/mock-openai — deterministic OpenAI-compatible upstream.
 *
 * Knobs (all optional, headers win over env):
 *   X-Mock-Latency-Ms               fixed latency for this request
 *   X-Mock-Fail                     "500" | "429" | any HTTP code | "timeout" | "invalid-json"
 *   X-Mock-Completion-Tokens        force completion_tokens
 *   X-Mock-Invalid-Schema-Response  return JSON that violates response_format
 */

const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "developer"]),
    content: z
      .union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
        z.null(),
      ])
      .optional(),
  })
  .loose();

const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z
    .object({
      type: z.literal("json_schema"),
      json_schema: z
        .object({
          name: z.string(),
          schema: z.record(z.string(), z.unknown()),
          strict: z.boolean().optional(),
        })
        .loose(),
    })
    .loose(),
]);

const chatRequestSchema = z
  .object({
    model: z.string().min(1).default("gpt-4o-mini"),
    messages: z.array(messageSchema).min(1),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).nullish(),
    response_format: responseFormatSchema.optional(),
  })
  .loose();

const embeddingsRequestSchema = z
  .object({
    model: z.string().min(1).default("text-embedding-3-small"),
    input: z.union([z.string(), z.array(z.string()).min(1)]),
    dimensions: z.number().int().min(1).max(1536).optional(),
  })
  .loose();

type ChatRequest = z.output<typeof chatRequestSchema>;

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface MockOpenAiDeps {
  /** Injectable clock in ms (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable RNG for failure-rate draws and jitter (tests). */
  random?: () => number;
}

/** How long a "timeout" failure holds the connection before giving up. */
const TIMEOUT_HOLD_MS = 30_000;

function openAiError(message: string, type: string, code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function truthyHeader(raw: string | undefined): boolean {
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export function createApp(
  config: Pick<
    MockOpenAiEnv,
    "latencyMs" | "latencyJitterMs" | "failureRate" | "seed"
  >,
  deps: MockOpenAiDeps = {},
) {
  void deps.now; // created is hash-derived (see deterministic.ts); clock kept for API compat
  const random = deps.random ?? Math.random;
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({ status: "ok", service: "mock-openai", seed: config.seed }),
  );

  app.post("/v1/chat/completions", async (c) => {
    const parsed = chatRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        openAiError(`invalid request: ${formatZodError(parsed.error)}`, "invalid_request_error"),
        400,
      );
    }
    const req = parsed.data;

    const failure = await resolveFailure(
      c.req.header("X-Mock-Fail"),
      c.req.raw.signal,
    );
    if (failure !== null) return failure;

    await applyLatency(c.req.header("X-Mock-Latency-Ms"));

    const normalized = normalizeMessages(req.messages);
    const promptTokens = promptTokensFor(normalized, config.seed);
    const forced = parseNonNegativeInt(c.req.header("X-Mock-Completion-Tokens"));
    const desired = forced ?? desiredCompletionTokens(normalized, config.seed);
    const cap = req.max_completion_tokens ?? req.max_tokens ?? null;
    const completionTokens = cap !== null ? Math.min(desired, cap) : desired;
    const finishReason = cap !== null && desired > cap ? "length" : "stop";

    const content = buildContent(
      req,
      normalized,
      completionTokens,
      truthyHeader(c.req.header("X-Mock-Invalid-Schema-Response")),
    );
    const usage: Usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    const id = completionId(normalized, config.seed);
    const created = createdSeconds(normalized, config.seed);

    if (req.stream === true) {
      return sseResponse({
        id,
        created,
        model: req.model,
        content,
        finishReason,
        usage,
        includeUsage: req.stream_options?.include_usage === true,
      });
    }

    return c.json({
      id,
      object: "chat.completion",
      created,
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  });

  app.post("/v1/embeddings", async (c) => {
    const parsed = embeddingsRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        openAiError(`invalid request: ${formatZodError(parsed.error)}`, "invalid_request_error"),
        400,
      );
    }
    const req = parsed.data;

    const failure = await resolveFailure(
      c.req.header("X-Mock-Fail"),
      c.req.raw.signal,
    );
    if (failure !== null) return failure;

    await applyLatency(c.req.header("X-Mock-Latency-Ms"));

    const inputs = typeof req.input === "string" ? [req.input] : req.input;
    const dimensions = req.dimensions ?? 1536;
    const data = inputs.map((text, index) => ({
      object: "embedding" as const,
      index,
      embedding: embeddingFor(text, dimensions, config.seed),
    }));
    const promptTokens = inputs.reduce((sum, text) => sum + estimateTokens(text), 0);
    return c.json({
      object: "list",
      model: req.model,
      data,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  });

  return app;

  // -------------------------------------------------------------------------

  function buildContent(
    req: ChatRequest,
    normalized: string,
    completionTokens: number,
    invalidSchema: boolean,
  ): string {
    const format = req.response_format;
    if (format?.type === "json_schema") {
      const schema = format.json_schema.schema;
      const value = invalidSchema
        ? invalidValueForSchema(schema)
        : valueForSchema(schema);
      return JSON.stringify(value);
    }
    if (format?.type === "json_object") {
      if (invalidSchema) return "{not valid json";
      return JSON.stringify({
        result: "mock",
        prompt_tokens: promptTokensFor(normalized, config.seed),
      });
    }
    return generateCompletionText(completionTokens, normalized, config.seed);
  }

  async function resolveFailure(
    header: string | undefined,
    signal: AbortSignal,
  ): Promise<Response | null> {
    const directive = header?.trim().toLowerCase();
    if (directive !== undefined && directive !== "") {
      if (directive === "timeout") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TIMEOUT_HOLD_MS);
          timer.unref?.();
          if (signal.aborted) {
            clearTimeout(timer);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        // Client already gave up (or 30s passed); nothing useful to send.
        return new Response(null, { status: 504 });
      }
      if (directive === "invalid-json") {
        return new Response("{this is not valid json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const status = Number.parseInt(directive, 10);
      if (Number.isFinite(status) && status >= 400 && status <= 599) {
        return new Response(
          JSON.stringify(openAiError(`injected failure (${status})`, "server_error")),
          { status, headers: { "content-type": "application/json" } },
        );
      }
      // Unknown directive: ignore, serve normally.
      return null;
    }
    if (config.failureRate > 0 && random() < config.failureRate) {
      return new Response(
        JSON.stringify(openAiError("injected failure (failure rate)", "server_error")),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    return null;
  }

  async function applyLatency(header: string | undefined): Promise<void> {
    const base = parseNonNegativeInt(header) ?? config.latencyMs;
    const jitter =
      config.latencyJitterMs > 0 ? Math.floor(random() * config.latencyJitterMs) : 0;
    const total = base + jitter;
    if (total > 0) await delay(total);
  }
}

interface SseParams {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason: string;
  usage: Usage;
  includeUsage: boolean;
}

/** OpenAI-style SSE stream: role chunk, content deltas, finish, usage, [DONE]. */
function sseResponse(params: SseParams): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = {
        id: params.id,
        object: "chat.completion.chunk",
        created: params.created,
        model: params.model,
      };
      push({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      // Split content into word-group deltas (~4 words per chunk).
      const words = params.content.split(" ");
      for (let i = 0; i < words.length; i += 4) {
        const group = words.slice(i, i + 4).join(" ");
        const suffix = i + 4 < words.length ? " " : "";
        push({
          ...base,
          choices: [
            { index: 0, delta: { content: group + suffix }, finish_reason: null },
          ],
        });
      }
      push({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: params.finishReason }],
      });
      if (params.includeUsage) {
        push({ ...base, choices: [], usage: params.usage });
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
