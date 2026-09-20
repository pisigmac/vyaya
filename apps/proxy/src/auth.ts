import { isPlausibleApiKey, verifyApiKey } from "@vyaya/db";
import type { WrappedDek } from "@vyaya/core";

/**
 * X-Vyaya-Key authentication.
 *
 * Keys are `vy_live_<64 hex>`; only the argon2id hash is stored. Lookup is
 * by the stored `last4` hint (a handful of candidates at most), then
 * argon2id verification picks the match. Results (positive AND negative)
 * are cached in memory with a short TTL so the hot path stays well inside
 * the 10ms p95 budget and a database blip does not take auth down for
 * recently-seen keys.
 *
 * Trade-off, documented in docs/ASSUMPTIONS.md: revocation takes up to
 * `cacheTtlMs` to propagate.
 */

export interface KeyCandidate {
  keyId: string;
  workspaceId: string;
  keyHash: string;
  revokedAt: Date | null;
}

export interface WorkspaceAuthInfo {
  logBodiesEnabled: boolean;
  wrappedDek: WrappedDek | null;
}

/** Persistence boundary; the Drizzle/postgres.js implementation lives in deps.ts. */
export interface AuthStore {
  findKeyCandidates(last4: string): Promise<KeyCandidate[]>;
  getWorkspaceAuthInfo(workspaceId: string): Promise<WorkspaceAuthInfo | null>;
}

export interface AuthResult {
  keyId: string;
  workspaceId: string;
  logBodiesEnabled: boolean;
  wrappedDek: WrappedDek | null;
}

/** Thrown when the auth store cannot be reached and the key is not cached. */
export class AuthUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "AuthUnavailableError";
  }
}

export interface AuthenticatorOptions {
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  result: AuthResult | null;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;

export class ApiKeyAuthenticator {
  readonly #store: AuthStore;
  readonly #cacheTtlMs: number;
  readonly #negativeTtlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(store: AuthStore, options: AuthenticatorOptions = {}) {
    this.#store = store;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#negativeTtlMs = options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Resolve a plaintext key to its workspace context.
   * Returns null for unknown/revoked/malformed keys; throws
   * AuthUnavailableError only when the store is down AND the key is not in
   * cache.
   */
  async authenticate(plaintext: string): Promise<AuthResult | null> {
    if (!isPlausibleApiKey(plaintext)) return null;
    const cached = this.#cache.get(plaintext);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }
    let result: AuthResult | null;
    try {
      result = await this.#lookup(plaintext);
    } catch (err) {
      throw new AuthUnavailableError("api key store unavailable", err);
    }
    this.#cache.set(plaintext, {
      result,
      expiresAt: now + (result === null ? this.#negativeTtlMs : this.#cacheTtlMs),
    });
    return result;
  }

  async #lookup(plaintext: string): Promise<AuthResult | null> {
    const last4 = plaintext.slice(-4);
    const candidates = await this.#store.findKeyCandidates(last4);
    for (const candidate of candidates) {
      if (candidate.revokedAt !== null) continue;
      const match = await verifyApiKey(candidate.keyHash, plaintext);
      if (!match) continue;
      const ws = await this.#store.getWorkspaceAuthInfo(candidate.workspaceId);
      if (ws === null) return null;
      return {
        keyId: candidate.keyId,
        workspaceId: candidate.workspaceId,
        logBodiesEnabled: ws.logBodiesEnabled,
        wrappedDek: ws.wrappedDek,
      };
    }
    return null;
  }

  /** Test/operations introspection. */
  cacheSize(): number {
    return this.#cache.size;
  }
}
