import { loadWebEnv, type WebEnv } from "@vyaya/config";

/**
 * Memoized, validated web environment. All process.env access for the web
 * app happens inside @vyaya/config; this module just caches the result
 * (route handlers and server components call it per request).
 */
let cached: WebEnv | null = null;

export function getEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}

/** Test hook: drop the memoized env so a new process.env takes effect. */
export function resetEnvCache(): void {
  cached = null;
}
