import { createHash } from "node:crypto";

/**
 * Canonical prompt normalization + hashing.
 *
 * The proxy hashes every request's prompt (SHA-256 of the normalized form)
 * so the retry_storm detector can cluster identical prompts without storing
 * plaintext. The worker recomputes hashes from decrypted bodies with the
 * same functions, so the normalization contract lives here, in the sole
 * cross-service package.
 *
 * Chat normalization: one line per message, "<role>:<flattened text>",
 * joined with "\n". Content part arrays are flattened to their text parts.
 * Embeddings normalization: the raw input string, or the batch joined with
 * "\n" for arrays.
 */

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

/** Canonical string form of a chat message list. */
export function normalizeChatMessages(
  messages: readonly NormalizableMessage[],
): string {
  return messages.map((m) => `${m.role}:${contentToText(m.content)}`).join("\n");
}

/** Canonical string form of an embeddings input (string or string[]). */
export function normalizeEmbeddingInput(input: string | readonly string[]): string {
  return typeof input === "string" ? input : input.join("\n");
}

/** SHA-256 hex of the normalized prompt — the request_logs.prompt_hash key. */
export function promptHashHex(normalizedPrompt: string): string {
  return createHash("sha256").update(normalizedPrompt, "utf8").digest("hex");
}

/** Rough deterministic token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimate prompt tokens for a chat message list when the upstream did not
 * report usage (e.g. a stream without stream_options.include_usage).
 * Mirrors the mock upstream's shape: 3 priming + 4 per-message overhead.
 */
export function estimateChatPromptTokens(
  messages: readonly NormalizableMessage[],
): number {
  let total = 3;
  for (const m of messages) {
    total += 4 + estimateTokens(contentToText(m.content));
  }
  return total;
}
