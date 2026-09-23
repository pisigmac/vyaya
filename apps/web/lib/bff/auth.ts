import { verifyDeskIdJwt, type JwksCache } from "@vyaya/core";
import type { VyayaDatabase } from "@vyaya/db/client";
import { grantVyayaAudience, provisionWorkspaceForClaims } from "../provision";
import {
  signSession,
  type SessionPayload,
} from "../session";

/**
 * Auth-callback logic behind GET /auth/callback (and the /api/auth/callback
 * alias). Kept framework-free so vitest can exercise it directly against
 * mock-deskid-issued tokens and a seeded database.
 */

export interface AuthCallbackDeps {
  jwks: JwksCache;
  issuer: string;
  db: VyayaDatabase;
  sessionSecret: string;
  sessionTtlSec: number;
  deskIdBaseUrl: string;
  deskIdAdminToken?: string | undefined;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface AuthCallbackResult {
  sessionValue: string;
  payload: SessionPayload;
  /** Where the browser should land next. */
  redirectTo: "/onboarding" | "/dashboard";
  createdWorkspace: boolean;
}

export class AuthCallbackError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "AuthCallbackError";
    this.reason = reason;
  }
}

export async function handleAuthCallback(
  token: string,
  deps: AuthCallbackDeps,
): Promise<AuthCallbackResult> {
  let claims;
  try {
    claims = await verifyDeskIdJwt(token, {
      issuer: deps.issuer,
      jwks: deps.jwks,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "verification failed";
    throw new AuthCallbackError("invalid_token", reason);
  }

  const provisioned = await provisionWorkspaceForClaims(deps.db, claims);

  if (provisioned.createdWorkspace) {
    // Best-effort: future tokens for this user should carry aud "vyaya".
    // Failure is fine — mock-deskid already issues it, and DeskId deploys
    // can set AUTH_DEFAULT_AUDIENCES at bootstrap (docs/INTEGRATIONS.md).
    await grantVyayaAudience({
      deskIdBaseUrl: deps.deskIdBaseUrl,
      adminToken: deps.deskIdAdminToken,
      userId: claims.sub,
      role: provisioned.role,
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
  }

  const now = deps.now ?? Date.now;
  const payload: SessionPayload = {
    v: 1,
    sub: claims.sub,
    email: claims.email,
    userId: provisioned.userId,
    workspaceId: provisioned.workspaceId,
    orgId: claims.org_id,
    role: provisioned.role,
    exp: Math.floor(now() / 1000) + deps.sessionTtlSec,
  };
  const sessionValue = await signSession(payload, deps.sessionSecret);

  return {
    sessionValue,
    payload,
    redirectTo: provisioned.createdWorkspace ? "/onboarding" : "/dashboard",
    createdWorkspace: provisioned.createdWorkspace,
  };
}
