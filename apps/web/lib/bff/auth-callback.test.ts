import { describe, expect, it, vi } from "vitest";
import { deskIdClaimsSchema, generateSigningKeyForTests, signJwtForTests } from "@vyaya/core";
import { handleAuthCallback, type AuthCallbackDeps } from "./auth";
import type { SessionPayload } from "../session";

const ISSUER = "http://localhost:8091";

type Rows = Record<string, Record<string, unknown>[]>;

/** Minimal fake of the DrizzleDatabase surface the auth callback touches. */
function fakeDb(initial?: Partial<Rows>) {
  const rows: Rows = {
    users: initial?.users ?? [],
    workspaces: initial?.workspaces ?? [],
    orgs: initial?.orgs ?? [],
  };
  const db = {
    insert(table: { _: string }) {
      return {
        values(value: Record<string, unknown>) {
          rows[table._]!.push(value);
          return {
            onConflictDoNothing: () => Promise.resolve(),
            returning: () => Promise.resolve([value]),
          };
        },
      };
    },
    select() {
      return {
        from: (table: { _: string }) => ({
          where: () => ({
            limit: (n: number) => Promise.resolve(rows[table._]!.slice(0, n)),
          }),
        }),
      };
    },
  };
  return { db, rows };
}

function makeJwksCache(signingKey: ReturnType<typeof generateSigningKeyForTests>) {
  return {
    get: async (kid: string) => (kid === signingKey.kid ? signingKey.publicKeyPem : null),
    refresh: async () => 1,
    size: 1,
  };
}

function makeDeps(overrides: Partial<AuthCallbackDeps> = {}) {
  const signingKey = generateSigningKeyForTests();
  const { db, rows } = fakeDb();
  const deps: AuthCallbackDeps = {
    jwks: makeJwksCache(signingKey) as never,
    issuer: ISSUER,
    db: db as never,
    sessionSecret: "test-session-secret-test-session-secret",
    sessionTtlSec: 3600,
    deskIdBaseUrl: ISSUER,
    deskIdAdminToken: undefined,
    fetchFn: vi.fn(),
    ...overrides,
  };
  return { deps, signingKey, rows };
}

function mint(
  signingKey: ReturnType<typeof generateSigningKeyForTests>,
  claims: Record<string, unknown>,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtForTests({
    key: signingKey,
    claims: {
      sub: "user-1",
      email: "dev@vyaya.local",
      org_id: "org-1",
      workspace_id: null,
      aud: ["vyaya"],
      roles: { vyaya: "admin" },
      token_version: 1,
      iss: ISSUER,
      iat: now,
      exp: now + 3600,
      ...claims,
    },
  });
}

describe("handleAuthCallback", () => {
  it("verifies a valid token, provisions the user, and returns a session", async () => {
    const { deps, signingKey, rows } = makeDeps();
    const token = mint(signingKey, { sub: "user-new" });
    const result = await handleAuthCallback(token, deps);
    expect(result.sessionValue.split(".")).toHaveLength(2);
    const payload = JSON.parse(
      Buffer.from(result.sessionValue.split(".")[0]!, "base64url").toString("utf8"),
    ) as SessionPayload;
    expect(payload.sub).toBe("user-new");
    expect(payload.role).toBe("admin");
    expect(rows["users"]).toHaveLength(1);
    // First login auto-provisions a workspace.
    expect(rows["workspaces"]).toHaveLength(1);
    expect(payload.workspaceId).toBeTruthy();
  });

  it("rejects a token signed by an unknown key", async () => {
    const { deps } = makeDeps();
    const stranger = generateSigningKeyForTests();
    const token = mint(stranger, {});
    await expect(handleAuthCallback(token, deps)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { deps, signingKey } = makeDeps();
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtForTests({
      key: signingKey,
      claims: {
        sub: "user-1",
        email: "e@x.io",
        org_id: null,
        workspace_id: null,
        aud: ["vyaya"],
        roles: { vyaya: "admin" },
        token_version: 1,
        iss: ISSUER,
        iat: now - 7200,
        exp: now - 3600,
      },
    });
    await expect(handleAuthCallback(token, deps)).rejects.toThrow();
  });

  it("rejects claims that fail the DeskId schema", async () => {
    const { deps, signingKey } = makeDeps();
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtForTests({
      key: signingKey,
      claims: { sub: "user-1", iss: ISSUER, iat: now, exp: now + 60 },
    });
    await expect(handleAuthCallback(token, deps)).rejects.toThrow();
  });

  it("calls the DeskId auto-grant endpoint for vyaya on first login", async () => {
    const { deps, signingKey } = makeDeps();
    (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("{}", { status: 201 }),
    );
    await handleAuthCallback(mint(signingKey, { sub: "grant-me" }), deps);
    const grantCalls = (deps.fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/v1/admin/grants"),
    );
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]?.url).toBe(`${ISSUER}/v1/admin/grants`);
    expect(grantCalls[0]?.body).toMatchObject({
      user_id: "grant-me",
      audience: "vyaya",
    });
  });

  it("reuses the DeskId workspace claim on subsequent logins", async () => {
    const { deps, signingKey, rows } = makeDeps();
    rows["workspaces"]!.push({
      id: "ws-existing",
      deskid_workspace_id: "deskid-ws-1",
      name: "Existing",
      slug: "existing",
    });
    const token = mint(signingKey, { sub: "user-1", workspace_id: "deskid-ws-1" });
    const result = await handleAuthCallback(token, deps);
    const payload = JSON.parse(
      Buffer.from(result.sessionValue.split(".")[0]!, "base64url").toString("utf8"),
    ) as SessionPayload;
    expect(payload.workspaceId).toBe("ws-existing");
    expect(rows["workspaces"]).toHaveLength(1);
  });
});

describe("deskIdClaimsSchema", () => {
  it("accepts the documented DeskId claim shape", () => {
    const now = Math.floor(Date.now() / 1000);
    const parsed = deskIdClaimsSchema.safeParse({
      sub: "u",
      email: "e@x.io",
      org_id: null,
      workspace_id: null,
      aud: ["vyaya"],
      roles: { vyaya: "operator" },
      token_version: 2,
      iss: ISSUER,
      iat: now,
      exp: now + 60,
    });
    expect(parsed.success).toBe(true);
  });
});
