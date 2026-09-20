import type { DeskIdClaims, JwksCache } from "@vyaya/core";
import { verifyDeskIdJwt } from "@vyaya/core";
import type { DrizzleDatabase } from "@vyaya/db";
import { orgs, users, workspaces } from "@vyaya/db";
import { eq } from "drizzle-orm";
import { sealSession } from "../session";

/**
 * OAuth callback handler. The token arrives from DeskId (mock in dev);
 * verification is fully stateless through the cached JWKS. On first login
 * we provision the user row and auto-create a workspace (auto-granting
 * the vyaya audience at DeskId, mirroring the product's single-workspace
 * v1 model — see docs/ASSUMPTIONS.md).
 */

export interface AuthCallbackDeps {
  jwks: JwksCache;
  issuer: string;
  db: DrizzleDatabase;
  sessionSecret: string;
  sessionTtlSec: number;
  deskIdBaseUrl: string;
  deskIdAdminToken: string | undefined;
  fetchFn?: typeof fetch;
}

export interface AuthCallbackResult {
  /** Sealed session cookie value. */
  sessionValue: string;
  /** Where to send the browser next. */
  redirectTo: string;
}

export async function handleAuthCallback(
  token: string,
  deps: AuthCallbackDeps,
): Promise<AuthCallbackResult> {
  const claims = await verifyDeskIdJwt(token, {
    issuer: deps.issuer,
    jwks: deps.jwks,
  });
  const db = deps.db;

  await db
    .insert(users)
    .values({
      id: claims.sub,
      email: claims.email,
      deskidOrgId: claims.org_id,
    })
    .onConflictDoNothing();

  const workspaceId = await resolveWorkspace(db, claims);
  await ensureVyayaGrant(claims, deps);

  const sessionValue = sealSession(
    {
      sub: claims.sub,
      email: claims.email,
      role: claims.roles["vyaya"] ?? "viewer",
      workspaceId,
      tokenVersion: claims.token_version,
    },
    deps.sessionSecret,
    deps.sessionTtlSec,
  );
  return { sessionValue, redirectTo: "/dashboard" };
}

/** Map the DeskId workspace claim to a local workspace, creating both on first login. */
async function resolveWorkspace(
  db: DrizzleDatabase,
  claims: DeskIdClaims,
): Promise<string> {
  if (claims.workspace_id !== null) {
    const existing = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.deskidWorkspaceId, claims.workspace_id))
      .limit(1);
    if (existing[0] !== undefined) return existing[0].id;
  }
  // First login: auto-provision org + workspace. Slugs get a short suffix
  // from the user id so collisions can't happen.
  const suffix = claims.sub.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
  const orgId = claims.org_id ?? `org-${claims.sub}`;
  await db
    .insert(orgs)
    .values({ id: orgId, name: `${claims.email}'s org`, slug: `org-${suffix}` })
    .onConflictDoNothing();
  const [created] = await db
    .insert(workspaces)
    .values({
      orgId,
      deskidWorkspaceId: claims.workspace_id,
      name: "My workspace",
      slug: `ws-${suffix}`,
    })
    .returning();
  return created!.id;
}

/** Best-effort auto-grant of the vyaya audience at DeskId (first login). */
async function ensureVyayaGrant(
  claims: DeskIdClaims,
  deps: AuthCallbackDeps,
): Promise<void> {
  if (claims.aud.includes("vyaya")) return;
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    await fetchFn(`${deps.deskIdBaseUrl.replace(/\/$/, "")}/v1/admin/grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.deskIdAdminToken !== undefined && deps.deskIdAdminToken !== ""
          ? { authorization: `Bearer ${deps.deskIdAdminToken}` }
          : {}),
      },
      body: JSON.stringify({ user_id: claims.sub, audience: "vyaya", role: "admin" }),
    });
  } catch {
    // Grant is also reconciled by the worker; a missed call is not fatal.
  }
}
