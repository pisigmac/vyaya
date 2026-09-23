import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * Proxy API keys (X-Vyaya-Key).
 *
 * Format: `vy_live_<64 lowercase hex chars>` (32 random bytes). The
 * "vy_live" prefix makes keys identifiable in logs and secret scanners;
 * only the last 4 characters are ever shown in the UI. At rest only the
 * argon2id hash is stored (RFC 9106 first-choice parameters). Plaintext is
 * returned exactly once at creation time.
 */

export const API_KEY_PREFIX = "vy_live";
const KEY_RANDOM_BYTES = 32;
const KEY_PATTERN = /^vy_live_[0-9a-f]{64}$/;

export interface GeneratedApiKey {
  /** Full key — show once, never store. */
  plaintext: string;
  prefix: string;
  last4: string;
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${API_KEY_PREFIX}_${randomBytes(KEY_RANDOM_BYTES).toString("hex")}`;
  return {
    plaintext,
    prefix: API_KEY_PREFIX,
    last4: plaintext.slice(-4),
  };
}

/** Cheap format check so the proxy can reject garbage before hashing. */
export function isPlausibleApiKey(candidate: string): boolean {
  return KEY_PATTERN.test(candidate);
}

/**
 * Hash a plaintext key with argon2id (@node-rs/argon2 defaults:
 * argon2id v=19, 19 MiB memory, 2 iterations, 1 lane — the RFC 9106
 * recommended parameter set for memory-constrained servers). Output is the
 * standard encoded form ($argon2id$v=19$m=...,t=...,p=...$salt$hash).
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  if (!isPlausibleApiKey(plaintext)) {
    throw new ApiKeyFormatError(plaintext.slice(0, 12));
  }
  return hash(plaintext);
}

/** Constant-time-ish verification via the argon2id encoded hash. */
export async function verifyApiKey(
  encodedHash: string,
  candidate: string,
): Promise<boolean> {
  if (!isPlausibleApiKey(candidate)) return false;
  try {
    return await verify(encodedHash, candidate);
  } catch {
    // Malformed stored hash — treat as non-match, never throw to callers.
    return false;
  }
}

export class ApiKeyFormatError extends Error {
  constructor(keyPreview: string) {
    super(
      `invalid API key format near ${JSON.stringify(keyPreview)}… — expected ${API_KEY_PREFIX}_<64 hex chars>`,
    );
    this.name = "ApiKeyFormatError";
  }
}
