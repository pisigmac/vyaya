import { createHash, randomUUID } from "node:crypto";

/**
 * Response body tap: passes every upstream byte through to the client
 * untouched while accumulating a bounded text copy for observability
 * (usage extraction, schema validation, opt-in body logging).
 *
 * This is the latency-critical path: chunks are forwarded synchronously as
 * they arrive; nothing here awaits the sink, the DB, or Redis.
 *
 * Cancellation: when the client disconnects, cancel() propagates to the
 * upstream reader (aborting the upstream read) and the outcome resolves
 * with completed=false — the request is logged as client_disconnect.
 */

export interface TapOutcome {
  /** Decoded response text, truncated at maxBytes. */
  bodyText: string;
  /** False when the stream failed or the client cancelled. */
  completed: boolean;
  terminal: "completed" | "client_disconnect" | "upstream_error";
  /** Total bytes seen (not capped). */
  bytes: number;
  /** True when the text copy was truncated at maxBytes. */
  truncated: boolean;
}

export interface TapResult {
  stream: ReadableStream<Uint8Array>;
  done: Promise<TapOutcome>;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function tapStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TapResult {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let accumulated = 0;
  let bytes = 0;
  let truncated = false;

  let resolveDone!: (outcome: TapOutcome) => void;
  let settled = false;
  const done = new Promise<TapOutcome>((resolve) => {
    resolveDone = resolve;
  });

  const accumulate = (chunk: Uint8Array): void => {
    bytes += chunk.byteLength;
    if (accumulated >= maxBytes) {
      truncated = true;
      return;
    }
    parts.push(decoder.decode(chunk, { stream: true }));
    accumulated += chunk.byteLength;
    if (accumulated > maxBytes) truncated = true;
  };

  const finish = (terminal: TapOutcome["terminal"]): void => {
    if (settled) return;
    settled = true;
    parts.push(decoder.decode());
    resolveDone({ bodyText: parts.join(""), completed: terminal === "completed", terminal, bytes, truncated });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (settled) return;
        if (ended) {
          controller.close();
          finish("completed");
          return;
        }
        if (value !== undefined) accumulate(value);
        if (value !== undefined) controller.enqueue(value);
      } catch (err) {
        if (settled) return;
        finish("upstream_error");
        controller.error(err);
      }
    },
    async cancel(reason) {
      // Settle before awaiting cancellation: pending reads may resolve and
      // upstream cancellation may hang or reject.
      finish("client_disconnect");
      try {
        await reader.cancel(reason);
      } catch {
        // Upstream already gone; the outcome below is what matters.
      }
    },
  });

  return { stream, done };
}

/** Extract a single SSE "data:" payload stream from accumulated text. */
export function* iterSseDataPayloads(text: string): Generator<string> {
  // SSE events are separated by blank lines; only data: lines carry JSON.
  for (const event of text.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  }
}

export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ExtractedResponse {
  usage: ExtractedUsage | null;
  /** Assistant content text (chat only), null for embeddings/errors. */
  contentText: string | null;
  /** Model reported by the upstream response, when present. */
  model: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function usageFrom(obj: unknown): ExtractedUsage | null {
  if (typeof obj !== "object" || obj === null) return null;
  const usage = (obj as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const prompt = num(u["prompt_tokens"]);
  const completion = num(u["completion_tokens"]);
  if (prompt === null) return null;
  return { promptTokens: prompt, completionTokens: completion ?? 0 };
}

/** Parse a buffered (non-SSE) chat/embeddings JSON response. */
export function extractFromBufferedJson(bodyText: string): ExtractedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { usage: null, contentText: null, model: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { usage: null, contentText: null, model: null };
  }
  const obj = parsed as Record<string, unknown>;
  const model = typeof obj["model"] === "string" ? obj["model"] : null;
  let contentText: string | null = null;
  const choices = obj["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.["message"];
    if (typeof message === "object" && message !== null) {
      const content = (message as Record<string, unknown>)["content"];
      if (typeof content === "string") contentText = content;
    }
  }
  return { usage: usageFrom(obj), contentText, model };
}

/**
 * Parse an accumulated SSE stream (OpenAI chat.completion.chunk shape):
 * usage from the final chunk when stream_options.include_usage was set,
 * assistant content from delta accumulation.
 */
export function extractFromSse(bodyText: string): ExtractedResponse {
  let usage: ExtractedUsage | null = null;
  let model: string | null = null;
  const contentParts: string[] = [];
  for (const payload of iterSseDataPayloads(bodyText)) {
    if (payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof chunk !== "object" || chunk === null) continue;
    const obj = chunk as Record<string, unknown>;
    if (model === null && typeof obj["model"] === "string") {
      model = obj["model"];
    }
    const u = usageFrom(obj);
    if (u !== null) usage = u;
    const choices = obj["choices"];
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (typeof choice !== "object" || choice === null) continue;
        const delta = (choice as Record<string, unknown>)["delta"];
        if (typeof delta !== "object" || delta === null) continue;
        const content = (delta as Record<string, unknown>)["content"];
        if (typeof content === "string") contentParts.push(content);
      }
    }
  }
  return {
    usage,
    contentText: contentParts.length > 0 ? contentParts.join("") : null,
    model,
  };
}

/** Stable id fallback for clients that do not send X-Vyaya-Request-Id. */
export function newRequestId(): string {
  return randomUUID();
}

/** sha256 hex helper for tests/diagnostics. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
