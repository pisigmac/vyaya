/**
 * X-Vyaya-* header parsing. Every header is optional and validated
 * defensively: a malformed observability header must never fail the
 * proxied request (observe-only contract).
 */

/** Request-id header the client may set for correlation (retries). */
export const REQUEST_ID_HEADER = "x-vyaya-request-id";
export const SESSION_HEADER = "x-vyaya-session";
export const TAG_HEADER = "x-vyaya-tag";
export const RETRY_ATTEMPT_HEADER = "x-vyaya-retry-attempt";
export const RETRY_OF_HEADER = "x-vyaya-retry-of";
export const CONSUMED_HEADER = "x-vyaya-consumed";
export const API_KEY_HEADER = "x-vyaya-key";

/** Safe token charset for client-supplied correlation ids. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface VyayaHeaders {
  /** Client-supplied request id, when present and well-formed. */
  clientRequestId: string | null;
  sessionId: string | null;
  /** Raw X-Vyaya-Tag value before allowlist validation. */
  featureTagRaw: string | null;
  retryAttempt: number;
  retryOf: string | null;
  /** X-Vyaya-Consumed: explicit downstream-consumption signal. */
  consumedSignal: boolean | null;
}

type HeaderGetter = (name: string) => string | undefined;

function shortText(raw: string | undefined, maxLen: number): string | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > maxLen) return null;
  return v;
}

export function parseVyayaHeaders(get: HeaderGetter): VyayaHeaders {
  const clientRequestIdRaw = get(REQUEST_ID_HEADER);
  const clientRequestId =
    clientRequestIdRaw !== undefined && REQUEST_ID_PATTERN.test(clientRequestIdRaw)
      ? clientRequestIdRaw
      : null;
  const retryAttemptRaw = get(RETRY_ATTEMPT_HEADER);
  let retryAttempt = 0;
  if (retryAttemptRaw !== undefined) {
    const n = Number.parseInt(retryAttemptRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10_000) retryAttempt = n;
  }
  const consumedRaw = get(CONSUMED_HEADER)?.trim().toLowerCase();
  const consumedSignal =
    consumedRaw === undefined || consumedRaw === ""
      ? null
      : !(consumedRaw === "false" || consumedRaw === "0" || consumedRaw === "no");
  return {
    clientRequestId,
    sessionId: shortText(get(SESSION_HEADER), 256),
    featureTagRaw: shortText(get(TAG_HEADER), 128),
    retryAttempt,
    retryOf: shortText(get(RETRY_OF_HEADER), 128),
    consumedSignal,
  };
}

/** OpenAI-shaped error body; the proxy speaks OpenAI on failure paths. */
export function openAiError(
  message: string,
  type: string,
  code: string | null = null,
): { error: { message: string; type: string; param: null; code: string | null } } {
  return { error: { message, type, param: null, code } };
}
