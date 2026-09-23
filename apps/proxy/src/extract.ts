import { z } from "zod";
import type { DeclaredResponseFormat } from "./schema-check.js";

/**
 * Best-effort extraction of observability fields from the request body.
 * The proxy is observe-only: an unparseable body is still forwarded
 * untouched; we simply log with fallback fields (model "unknown").
 */

const responseFormatSchema = z
  .object({
    type: z.string(),
    json_schema: z
      .object({ schema: z.unknown() })
      .loose()
      .optional(),
  })
  .loose();

const chatFactsSchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z
      .array(z.object({ role: z.string(), content: z.unknown() }).loose())
      .optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    response_format: responseFormatSchema.optional(),
  })
  .loose();

const embeddingFactsSchema = z
  .object({
    model: z.string().min(1).optional(),
    input: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
  })
  .loose();

export interface RequestFacts {
  model: string;
  stream: boolean;
  maxTokens: number | null;
  /** Chat messages for prompt hashing, when parseable. */
  messages: { role: string; content: unknown }[] | null;
  /** Embeddings input for prompt hashing, when parseable. */
  embeddingInput: string | string[] | null;
  responseFormat: DeclaredResponseFormat | null;
}

const FALLBACK: RequestFacts = {
  model: "unknown",
  stream: false,
  maxTokens: null,
  messages: null,
  embeddingInput: null,
  responseFormat: null,
};

export function parseRequestFacts(
  bodyText: string,
  endpoint: "/v1/chat/completions" | "/v1/embeddings",
): RequestFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return FALLBACK;
  }
  if (endpoint === "/v1/chat/completions") {
    const r = chatFactsSchema.safeParse(parsed);
    if (!r.success) return FALLBACK;
    return {
      model: r.data.model ?? "unknown",
      stream: r.data.stream === true,
      maxTokens: r.data.max_completion_tokens ?? r.data.max_tokens ?? null,
      messages: r.data.messages ?? null,
      embeddingInput: null,
      responseFormat: (r.data.response_format as DeclaredResponseFormat | undefined) ?? null,
    };
  }
  const r = embeddingFactsSchema.safeParse(parsed);
  if (!r.success) return FALLBACK;
  return {
    model: r.data.model ?? "unknown",
    stream: false,
    maxTokens: r.data.max_completion_tokens ?? r.data.max_tokens ?? null,
    messages: null,
    embeddingInput: r.data.input ?? null,
    responseFormat: null,
  };
}
