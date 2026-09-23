import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { jwksFor, rotateKeyring, type KeyringHolder } from "./keys.js";
import { issueToken, type VyayaRole } from "./token.js";
import type { MockDeskIdStore } from "./store.js";

/**
 * DEV ONLY mock DeskId issuer. Refuses to boot unless AUTH_MODE=dev
 * (asserted in index.ts via assertDevMode). Issues RS256 JWTs that verify
 * through @vyaya/core's real verify + jwks-cache path.
 */

export function assertDevMode(authMode: string): void {
  if (authMode !== "dev") {
    throw new Error(
      `mock-deskid is DEV ONLY and refuses to start: AUTH_MODE must be "dev" (got ${JSON.stringify(authMode)})`,
    );
  }
}

export interface MockDeskIdDeps {
  issuer: string;
  spaCallbackUrl: string;
  tokenTtlSec: number;
  keyring: KeyringHolder;
  store: MockDeskIdStore;
  /** Injectable clock in ms (tests). Defaults to Date.now. */
  now?: () => number;
}

const roleSchema = z.enum(["admin", "operator", "viewer"]);

const oauthQuerySchema = z.object({
  sub: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  workspace_id: z.string().min(1).optional(),
  role: roleSchema.optional(),
});

const devTokenSchema = z.object({
  sub: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  org_id: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
  role: roleSchema.optional(),
  audiences: z.array(z.string().min(1)).optional(),
  token_version: z.number().int().nonnegative().optional(),
});

const grantSchema = z.object({
  user_id: z.string().min(1),
  audience: z.string().min(1).default("vyaya"),
  role: roleSchema.default("admin"),
});

export function createApp(deps: MockDeskIdDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  const issue = (overrides: {
    sub?: string;
    email?: string;
    orgId?: string | null;
    workspaceId?: string | null;
    role?: VyayaRole;
    tokenVersion?: number;
  }) => {
    const resolvedSub = overrides.sub ?? randomUUID();
    deps.store.ensureUser(resolvedSub, overrides.email ?? "dev-user@vyaya.local");
    return issueToken({
      key: deps.keyring.keyring.current,
      issuer: deps.issuer,
      ttlSec: deps.tokenTtlSec,
      now,
      sub: resolvedSub,
      ...(overrides.email !== undefined ? { email: overrides.email } : {}),
      ...(overrides.orgId !== undefined ? { orgId: overrides.orgId } : {}),
      ...(overrides.workspaceId !== undefined
        ? { workspaceId: overrides.workspaceId }
        : {}),
      ...(overrides.role !== undefined ? { role: overrides.role } : {}),
      ...(overrides.tokenVersion !== undefined
        ? { tokenVersion: overrides.tokenVersion }
        : {}),
      audiences: deps.store.audiencesFor(resolvedSub),
    });
  };

  app.get("/healthz", (c) =>
    c.json({ status: "ok", service: "mock-deskid", mode: "dev" }),
  );

  app.get("/.well-known/jwks.json", (c) => c.json(jwksFor(deps.keyring.keyring)));

  // Dev-only OAuth stubs: no real provider, straight to the SPA callback
  // with a freshly issued token, mirroring DeskId's redirect contract.
  app.get("/v1/oauth/:provider/start", (c) => {
    const provider = c.req.param("provider");
    if (provider !== "google" && provider !== "github") {
      return c.json({ error: `unknown provider ${JSON.stringify(provider)}` }, 404);
    }
    const query = oauthQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: "invalid query parameters" }, 400);
    }
    const { token } = issue({
      ...(query.data.sub !== undefined ? { sub: query.data.sub } : {}),
      ...(query.data.email !== undefined ? { email: query.data.email } : {}),
      ...(query.data.org_id !== undefined ? { orgId: query.data.org_id } : {}),
      ...(query.data.workspace_id !== undefined
        ? { workspaceId: query.data.workspace_id }
        : {}),
      ...(query.data.role !== undefined ? { role: query.data.role } : {}),
    });
    const url = new URL(deps.spaCallbackUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("provider", provider);
    return c.redirect(url.toString(), 302);
  });

  // Mint a token directly (tests, e2e scripts, curl).
  app.post("/v1/dev/token", async (c) => {
    const parsed = devTokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid token request" }, 400);
    }
    const body = parsed.data;
    const resolvedSub = body.sub ?? randomUUID();
    deps.store.ensureUser(resolvedSub, body.email ?? "dev-user@vyaya.local");
    for (const audience of body.audiences ?? []) {
      deps.store.grant(resolvedSub, audience, body.role ?? "admin");
    }
    const { token, claims } = issueToken({
      key: deps.keyring.keyring.current,
      issuer: deps.issuer,
      ttlSec: deps.tokenTtlSec,
      now,
      sub: resolvedSub,
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.org_id !== undefined ? { orgId: body.org_id } : {}),
      ...(body.workspace_id !== undefined
        ? { workspaceId: body.workspace_id }
        : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.token_version !== undefined
        ? { tokenVersion: body.token_version }
        : {}),
      audiences: deps.store.audiencesFor(resolvedSub),
    });
    return c.json({ token, claims });
  });

  // Auto-grant an audience to a user (mirrors DeskId POST /v1/admin/grants).
  app.post("/v1/admin/grants", async (c) => {
    const parsed = grantSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid grant request" }, 400);
    }
    const event = deps.store.grant(
      parsed.data.user_id,
      parsed.data.audience,
      parsed.data.role,
    );
    return c.json(
      {
        granted: true,
        user_id: parsed.data.user_id,
        audience: parsed.data.audience,
        event_id: event.id,
      },
      201,
    );
  });

  // Reconciliation feed for the worker (DESKID_RECONCILE_ENABLED).
  app.get("/v1/admin/reconciliation/events", (c) => {
    const sinceParam = c.req.query("since_id");
    const sinceId = sinceParam === undefined ? 0 : Number.parseInt(sinceParam, 10);
    if (!Number.isFinite(sinceId) || sinceId < 0) {
      return c.json({ error: "since_id must be a non-negative integer" }, 400);
    }
    return c.json(deps.store.eventsSince(sinceId));
  });

  // Key-ring rotation knob: current -> previous, fresh key -> current.
  // JWKS keeps advertising both, so in-flight tokens keep verifying.
  app.post("/v1/admin/rotate-keys", (c) => {
    const next = rotateKeyring(deps.keyring);
    return c.json({
      rotated: true,
      current_kid: next.current.kid,
      previous_kid: next.previous?.kid ?? null,
    });
  });

  return app;
}
