import { JwksCache } from "@vyaya/core";
import { getEnv } from "./env";

/**
 * Process-wide JWKS cache (5-minute TTL, auto-refresh on unknown kid per
 * the DeskId contract). Verification never calls DeskId per request — this
 * cache is the only network path to the JWKS document.
 */
let cached: JwksCache | null = null;

export function getJwksCache(): JwksCache {
  cached ??= new JwksCache({
    jwksUrl: getEnv().auth.deskIdJwksUrl,
    ttlMs: 5 * 60 * 1000,
  });
  return cached;
}

/** Test hook. */
export function resetJwksCache(): void {
  cached = null;
}
