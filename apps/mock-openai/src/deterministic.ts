/**
 * Deterministic token-count + content engine for the mock upstream.
 *
 * Everything here is a pure function of (request content, seed). The same
 * request always produces the same usage numbers and the same completion
 * text, which is what makes Vyaya's cost math and detectors testable
 * without a real LLM. See README.md for the exact formulas.
 */

/** FNV-1a 32-bit hash. Stable across processes and platforms. */
export function fnv1a(input: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Rough deterministic token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface NormalizableMessage {
  role: string;
  content?: unknown;
}

/** Flatten an OpenAI message content value (string | parts array | null). */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join(" ");
  }
  return "";
}

/** Canonical string form of the message list; input to every hash. */
export function normalizeMessages(messages: NormalizableMessage[]): string {
  return messages.map((m) => `${m.role}:${contentToText(m.content)}`).join("\n");
}

/**
 * prompt_tokens = 3 (priming) + Σ (4 per-message overhead + estimateTokens)
 * + a seed-derived jitter of 0..4 tokens.
 */
export function promptTokensFor(normalized: string, seed: number): number {
  const lines = normalized.split("\n");
  let total = 3;
  for (const line of lines) {
    const text = line.slice(line.indexOf(":") + 1);
    total += 4 + estimateTokens(text);
  }
  return total + (fnv1a(normalized, seed) % 5);
}

/**
 * Desired completion length when the caller does not force one:
 * 16..63 tokens, a pure hash of the prompt.
 */
export function desiredCompletionTokens(normalized: string, seed: number): number {
  return 16 + (fnv1a(`completion|${normalized}`, seed) % 48);
}

/**
 * Deterministic `created` epoch seconds: a plausible-looking fixed base
 * plus a hash of the prompt. Real `Date.now()` here caused a second-boundary
 * race in the proxy's byte-identity test (direct vs proxied requests landing
 * in different seconds); the mock's contract is that identical input yields
 * byte-identical output, so the timestamp is hash-derived like the id.
 */
export function createdSeconds(normalized: string, seed: number): number {
  return 1_700_000_000 + (fnv1a(`created|${normalized}`, seed) % 31_536_000);
}

const WORD_LIST = [
  "audit", "token", "spend", "waste", "model", "prompt", "stream", "cache",
  "retry", "schema", "signal", "budget", "trace", "metric", "dollar", "query",
  "window", "ledger", "proxy", "worker", "report", "fix", "cost", "input",
  "output", "claim", "issuer", "session", "hash", "event", "table", "chart",
  "quota", "limit", "header", "body", "route", "queue", "sink", "store",
  "value", "field", "index", "grant", "role", "scope", "tenant", "badge",
  "trend", "alert", "email", "digest", "verify", "sign", "rotate", "persist",
  "detect", "measure", "reduce", "track", "count", "price", "plane", "answer",
] as const;

/** Deterministic completion text: exactly `tokens` whitespace-separated words. */
export function generateCompletionText(
  tokens: number,
  normalized: string,
  seed: number,
): string {
  const words: string[] = [];
  for (let i = 0; i < tokens; i++) {
    const idx = fnv1a(`${normalized}|w${i}`, seed) % WORD_LIST.length;
    words.push(WORD_LIST[idx] ?? "token");
  }
  return words.join(" ");
}

/** Deterministic chatcmpl id derived from the prompt. */
export function completionId(normalized: string, seed: number): string {
  const a = fnv1a(normalized, seed).toString(16).padStart(8, "0");
  const b = fnv1a(`id|${normalized}`, seed).toString(16).padStart(8, "0");
  return `chatcmpl-mock${a}${b}`;
}

/** xorshift32 PRNG returning floats in [-1, 1). Seeded per embedding input. */
export function seededFloats(count: number, seedState: number): number[] {
  let state = seedState >>> 0 || 0x9e3779b9;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(state / 0x80000000 - 1);
  }
  return out;
}

/** Deterministic embedding vector for one input string. */
export function embeddingFor(
  text: string,
  dimensions: number,
  seed: number,
): number[] {
  return seededFloats(dimensions, fnv1a(`embed|${text}`, seed));
}

// ---------------------------------------------------------------------------
// JSON Schema stub generation (response_format: json_schema)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function schemaType(schema: JsonSchema): string | undefined {
  const t = schema["type"];
  if (typeof t === "string") return t;
  if ("properties" in schema || "required" in schema) return "object";
  if ("items" in schema) return "array";
  return undefined;
}

/** Smallest value that satisfies the declared schema (stub quality). */
export function valueForSchema(schema: JsonSchema): unknown {
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[0];
  }
  switch (schemaType(schema)) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(properties)) {
        out[key] = valueForSchema(sub);
      }
      return out;
    }
    case "array": {
      const items = (schema["items"] ?? { type: "string" }) as JsonSchema;
      const minItems = typeof schema["minItems"] === "number" ? schema["minItems"] : 1;
      return Array.from({ length: Math.max(1, minItems) }, () =>
        valueForSchema(items),
      );
    }
    case "integer":
      return typeof schema["minimum"] === "number"
        ? Math.ceil(schema["minimum"])
        : 1;
    case "number":
      return typeof schema["minimum"] === "number" ? schema["minimum"] : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "string":
    default:
      return "mock";
  }
}

/**
 * A JSON value that violates the declared schema (wrong top-level type).
 * Used with X-Mock-Invalid-Schema-Response to exercise schema_failure_burn.
 */
export function invalidValueForSchema(schema: JsonSchema): unknown {
  switch (schemaType(schema)) {
    case "object":
      return 42;
    case "array":
      return { not: "an array" };
    case "string":
      return 42;
    case "number":
    case "integer":
      return "not a number";
    case "boolean":
      return "not a boolean";
    default:
      return { __vyaya_invalid_schema_response__: true };
  }
}
