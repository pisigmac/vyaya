import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DeskIdClaims } from "@vyaya/core";
import { withWorkspace, type VyayaDatabase } from "@vyaya/db/client";
import * as schema from "@vyaya/db/schema";
import type { VyayaRole } from "./session";

/**
 * Map verified DeskId claims to a local workspace, creating both the
 * workspace and the user row on first login. Idempotent: users.deskid_sub
 * is globally unique, so a second login (or a raced concurrent one) finds
 * the existing rows and changes nothing.
 *
 * Lookup order:
 *   1. users.deskid_sub — returning user; sync email/role from claims.
 *   2. workspaces.deskid_org_id == claims.org_id — new user joining an
 *      existing org workspace.
 *   3. Neither — auto-create a workspace (onboarding flow) and insert the
 *      user with their DeskId role (default admin for the first user).
 *
 * Reads in steps 1-2 are cross-tenant lookups by globally-unique keys and
 * run outside withWorkspace; writes in step 3 are workspace-scoped. The web
 * database role must be able to resolve a user by deskid_sub globally (the
 * dev superuser can; production role mapping is documented in
 * docs/DEPLOY.md and docs/ASSUMPTIONS.md).
 */

export interface ProvisionResult {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  role: VyayaRole;
  /** True when step 3 created a brand-new workspace (first login). */
  createdWorkspace: boolean;
}

function claimsRole(claims: DeskIdClaims): VyayaRole {
  const role = claims.roles["vyaya"];
  if (role === "admin" || role === "operator" || role === "viewer") {
    return role;
  }
  return "viewer";
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "workspace";
}

export async function provisionWorkspaceForClaims(
  db: VyayaDatabase,
  claims: DeskIdClaims,
): Promise<ProvisionResult> {
  const role = claimsRole(claims);

  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.deskidSub, claims.sub))
    .limit(1);
  const existingUser = existing[0];
  if (existingUser) {
    if (existingUser.email !== claims.email || existingUser.role !== role) {
      await db
        .update(schema.users)
        .set({ email: claims.email, role })
        .where(eq(schema.users.id, existingUser.id));
    }
    const ws = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, existingUser.workspaceId))
      .limit(1);
    return {
      userId: existingUser.id,
      workspaceId: existingUser.workspaceId,
      workspaceName: ws[0]?.name ?? "workspace",
      role,
      createdWorkspace: false,
    };
  }

  if (claims.org_id) {
    const orgWs = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.deskidOrgId, claims.org_id))
      .limit(1);
    const ws = orgWs[0];
    if (ws) {
      const inserted = await insertUser(db, ws.id, claims, role);
      return {
        userId: inserted,
        workspaceId: ws.id,
        workspaceName: ws.name,
        role,
        createdWorkspace: false,
      };
    }
  }

  // First login: auto-create the workspace. The id is generated up front so
  // the insert can run inside its own workspace-scoped transaction (RLS).
  const workspaceId = randomUUID();
  const localPart = claims.email.split("@")[0] ?? "workspace";
  const name = `${localPart}'s workspace`;
  const slug = `${slugify(localPart)}-${randomBytes(3).toString("hex")}`;
  const firstRole: VyayaRole = role === "viewer" ? "viewer" : role;

  const userId = await withWorkspace(db, workspaceId, async (tx) => {
    await tx.insert(schema.workspaces).values({
      id: workspaceId,
      name,
      slug,
      deskidOrgId: claims.org_id,
    });
    const rows = await tx
      .insert(schema.users)
      .values({
        workspaceId,
        deskidSub: claims.sub,
        email: claims.email,
        role: firstRole,
      })
      .returning({ id: schema.users.id });
    return rows[0]!.id;
  });

  return {
    userId,
    workspaceId,
    workspaceName: name,
    role: firstRole,
    createdWorkspace: true,
  };
}

async function insertUser(
  db: VyayaDatabase,
  workspaceId: string,
  claims: DeskIdClaims,
  role: VyayaRole,
): Promise<string> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .insert(schema.users)
      .values({
        workspaceId,
        deskidSub: claims.sub,
        email: claims.email,
        role,
      })
      .returning({ id: schema.users.id });
    return rows[0]!.id;
  });
}

/**
 * Best-effort DeskId audience grant after workspace auto-create, per the
 * DeskId contract (POST /v1/admin/grants). Never throws: onboarding must not
 * fail because the identity admin API hiccuped. Deployments can instead set
 * AUTH_DEFAULT_AUDIENCES=vyaya at DeskId bootstrap; both paths are
 * documented in docs/INTEGRATIONS.md.
 */
export async function grantVyayaAudience(options: {
  deskIdBaseUrl: string;
  adminToken?: string | undefined;
  userId: string;
  role: VyayaRole;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.adminToken) {
      headers["authorization"] = `Bearer ${options.adminToken}`;
    }
    const res = await fetchFn(
      `${options.deskIdBaseUrl.replace(/\/$/, "")}/v1/admin/grants`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          user_id: options.userId,
          audience: "vyaya",
          role: options.role,
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
