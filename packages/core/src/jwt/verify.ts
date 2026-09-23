import { createVerify } from "node:crypto";
import { deskIdClaimsSchema } from "../schemas.js";
import type { DeskIdClaims } from "../types.js";
import { JwksCache, UnknownKeyIdError } from "./jwks-cache.js";

/**
 * Stateless DeskId RS256 JWT verification (JSON + RS256, NOT OIDC).
 *
 * Checks per request: RS256 signature against the JWKS key matching
 * header.kid, iss == configured issuer, aud contains "vyaya", exp > now.
 * No call to DeskId happens here — keys come from the cached JWKS.
 */

export type JwtFailureReason =
  | "malformed"
  | "unsupported_alg"
  | "missing_kid"
  | "unknown_kid"
  | "bad_signature"
  | "invalid_claims"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired";

export class JwtVerificationError extends Error {
  readonly reason: JwtFailureReason;
  constructor(reason: JwtFailureReason, message: string) {
    super(message);
    this.name = "JwtVerificationError";
    this.reason = reason;
  }
}

export interface VerifyDeskIdJwtOptions {
  /** Expected iss claim (DESKID_ISSUER). */
  issuer: string;
  /** Expected audience entry; defaults to "vyaya". */
  audience?: string;
  /** Cached JWKS key source. */
  jwks: JwksCache;
  /** Injectable clock in ms (tests). Defaults to Date.now. */
  now?: () => number;
  /** Allowed clock skew in seconds for exp. Defaults to 0. */
  clockToleranceSec?: number;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

export async function verifyDeskIdJwt(
  token: string,
  options: VerifyDeskIdJwtOptions,
): Promise<DeskIdClaims> {
  const audience = options.audience ?? "vyaya";
  const now = options.now ?? Date.now;
  const toleranceMs = (options.clockToleranceSec ?? 0) * 1000;

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new JwtVerificationError(
      "malformed",
      "JWT must have exactly three non-empty segments",
    );
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJsonSegment<JwtHeader>(headerB64, "header");
  if (header.alg !== "RS256") {
    throw new JwtVerificationError(
      "unsupported_alg",
      `expected alg RS256, got ${JSON.stringify(header.alg)}`,
    );
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new JwtVerificationError("missing_kid", "JWT header has no kid");
  }

  let key;
  try {
    key = await options.jwks.getPublicKey(header.kid);
  } catch (err) {
    if (err instanceof UnknownKeyIdError) {
      throw new JwtVerificationError(
        "unknown_kid",
        `no JWKS key for kid ${JSON.stringify(header.kid)}`,
      );
    }
    throw err;
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  let signatureValid = false;
  try {
    signatureValid = verifier.verify(key, signatureB64, "base64url");
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new JwtVerificationError(
      "bad_signature",
      "RS256 signature verification failed",
    );
  }

  const payload = decodeJsonSegment<unknown>(payloadB64, "payload");
  const parsed = deskIdClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new JwtVerificationError(
      "invalid_claims",
      `JWT claims failed validation: ${parsed.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ")}`,
    );
  }
  const claims = parsed.data;

  if (claims.iss !== options.issuer) {
    throw new JwtVerificationError(
      "wrong_issuer",
      `expected iss ${JSON.stringify(options.issuer)}, got ${JSON.stringify(claims.iss)}`,
    );
  }
  if (!claims.aud.includes(audience)) {
    throw new JwtVerificationError(
      "wrong_audience",
      `audience ${JSON.stringify(audience)} not present in aud`,
    );
  }
  if (claims.exp * 1000 + toleranceMs <= now()) {
    throw new JwtVerificationError("expired", "token has expired");
  }

  const result: DeskIdClaims = {
    sub: claims.sub,
    email: claims.email,
    org_id: claims.org_id,
    workspace_id: claims.workspace_id,
    aud: claims.aud,
    roles: claims.roles,
    token_version: claims.token_version,
    iss: claims.iss,
    exp: claims.exp,
  };
  if (claims.iat !== undefined) result.iat = claims.iat;
  return result;
}

function decodeJsonSegment<T>(segment: string, name: string): T {
  let text: string;
  try {
    text = Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    throw new JwtVerificationError(
      "malformed",
      `JWT ${name} is not valid base64url`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JwtVerificationError("malformed", `JWT ${name} is not valid JSON`);
  }
}
