import { createPublicKey, type JsonWebKeyInput, type KeyObject } from "node:crypto";

/**
 * JWKS client with caching for DeskId's GET /.well-known/jwks.json.
 *
 * Policy (per DeskId contract): serve keys from cache; refresh the key set
 * when (a) the cache is older than the TTL, or (b) a requested kid is not in
 * the cache (key ring rotation). Never fetch per request otherwise.
 */

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

export interface Jwks {
  keys: Jwk[];
}

export type JwksFetcher = (jwksUrl: string) => Promise<Jwks>;

export class JwksFetchError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JwksFetchError";
  }
}

export class UnknownKeyIdError extends Error {
  readonly kid: string;
  constructor(kid: string) {
    super(`no JWKS key found for kid ${JSON.stringify(kid)}`);
    this.name = "UnknownKeyIdError";
    this.kid = kid;
  }
}

/** Default fetcher over global fetch. NoDeskId call happens per request —
 *  this only runs on cache miss / TTL expiry / unknown kid. */
export const defaultJwksFetcher: JwksFetcher = async (jwksUrl) => {
  let res: Response;
  try {
    res = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new JwksFetchError(`JWKS fetch failed for ${jwksUrl}`, err);
  }
  if (!res.ok) {
    throw new JwksFetchError(`JWKS fetch returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as Jwks;
  if (!body || !Array.isArray(body.keys)) {
    throw new JwksFetchError("JWKS response has no keys array");
  }
  return body;
};

export interface JwksCacheOptions {
  jwksUrl: string;
  /** Cache TTL in milliseconds before a forced refresh. */
  ttlMs: number;
  fetcher?: JwksFetcher;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export class JwksCache {
  readonly #jwksUrl: string;
  readonly #ttlMs: number;
  readonly #fetcher: JwksFetcher;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #fetchedAtMs: number | null = null;
  #inflightRefresh: Promise<void> | null = null;

  constructor(options: JwksCacheOptions) {
    this.#jwksUrl = options.jwksUrl;
    this.#ttlMs = options.ttlMs;
    this.#fetcher = options.fetcher ?? defaultJwksFetcher;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Resolve the public key for a token's kid, refreshing the JWKS once on
   * unknown kid or stale cache. Throws UnknownKeyIdError if the kid is still
   * missing after a refresh.
   */
  async getPublicKey(kid: string): Promise<KeyObject> {
    const fresh =
      this.#fetchedAtMs !== null && this.#now() - this.#fetchedAtMs < this.#ttlMs;
    if (fresh) {
      const hit = this.#keys.get(kid);
      if (hit !== undefined) return hit;
    }
    await this.#refresh();
    const key = this.#keys.get(kid);
    if (key === undefined) throw new UnknownKeyIdError(kid);
    return key;
  }

  /** Force the next lookup to refetch (e.g. after a verified rotation). */
  invalidate(): void {
    this.#fetchedAtMs = null;
  }

  /** Number of keys currently cached (observability/testing). */
  get size(): number {
    return this.#keys.size;
  }

  async #refresh(): Promise<void> {
    // Coalesce concurrent refreshes into one fetch.
    this.#inflightRefresh ??= this.#doRefresh().finally(() => {
      this.#inflightRefresh = null;
    });
    return this.#inflightRefresh;
  }

  async #doRefresh(): Promise<void> {
    const jwks = await this.#fetcher(this.#jwksUrl);
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks.keys) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      next.set(
        jwk.kid,
        createPublicKey({
          key: jwk as unknown as JsonWebKeyInput["key"],
          format: "jwk",
        }),
      );
    }
    this.#keys = next;
    this.#fetchedAtMs = this.#now();
  }
}
