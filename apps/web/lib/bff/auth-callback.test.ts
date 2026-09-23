import { createPublicKey, createSign, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwksCache } from "@vyaya/core";
import { generateSigningKey, type SigningKey } from "@vyaya/mock-deskid/keys";
import { issueToken } from "@vyaya/mock-deskid/token";
import {
  AuthCallbackError,
  handleAuthCallback,
  type AuthCallbackDeps,
} from "./auth";
import { verifySession } from "../session";
import { provisionWorkspaceForClaims } from "../provision";
import {
  makeSession,
  startSeededDb,
  stopDb,
  type DbFixture,
} from "../../tests/helpers";

/**
 * Auth callback against mock-deskid-issued RS256 tokens. The JWKS cache is
 * fed by the mock's real keyring through an injected fetcher, so the full
 * verify path (signature, iss, aud, exp) runs exactly as in production.
 */

const ISSUER = "http://mock-deskid.test";
const SECRET = "session-secret-for-tests-32-bytes-minimum";

let fixture: DbFixture;
let key: SigningKey;
let grantCalls: { url: string; body: unknown }[];

function jwksFor(k: SigningKey) {
  const jwk = createPublicKey(k.publicKeyPem).export({ format: "jwk" });
  return {
    keys: [
      { ...jwk, kty: jwk.kty ?? "RSA", kid: k.kid, alg: "RS256", use: "sig" },
    ],
  };
}

function deps(): AuthCallbackDeps {
  grantCalls = [];
  return {
    jwks: new JwksCache({
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
      ttlMs: 60_000,
      fetcher: async () => jwksFor(key),
    }),
    issuer: ISSUER,
    db: fixture.handle.db,
    sessionSecret: SECRET,
    sessionTtlSec: 3600,
    deskIdBaseUrl: ISSUER,
    deskIdAdminToken: "admin-token",
    fetchFn: (async (url: string | URL, init?: RequestInit) => {
      grantCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response("{}", { status: 201 });
    }) as typeof fetch,
  };
}

interface MintOptions {
  sub?: string;
  email?: string;
  orgId?: string | null;
  workspaceId?: string | null;
  role?: "admin" | "operator" | "viewer";
  now?: () => number;
}

function mint(overrides: MintOptions = {}): string {
  return issueToken({ key, issuer: ISSUER, ttlSec: 3600, ...overrides }).token;
}

/** Mint a token with arbitrary claims (wrong aud/iss/exp tests). */
function mintRaw(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(key.privateKeyPem, "base64url")}`;
}

beforeAll(async () => {
  fixture = await startSeededDb(false); // migrations only
  key = generateSigningKey();
}, 240_000);

afterAll(async () => {
  await stopDb(fixture);
});

describe("handleAuthCallback", () => {
  it("verifies a mock-deskid token, provisions a workspace, grants audience", async () => {
    const token = mint({
      sub: "user-new-1",
      email: "new@vyaya.local",
      orgId: "org-new-1",
      role: "admin",
    });
    const result = await handleAuthCallback(token, deps());
    expect(result.createdWorkspace).toBe(true);
    expect(result.redirectTo).toBe("/onboarding");

    // Session cookie round-trips through the real verify path.
    const session = await verifySession(result.sessionValue, SECRET);
    expect(session?.sub).toBe("user-new-1");
    expect(session?.workspaceId).toBe(result.payload.workspaceId);
    expect(session?.role).toBe("admin");

    // Audience grant fired exactly once, at DeskId's admin endpoint.
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]?.url).toBe(`${ISSUER}/v1/admin/grants`);
    expect(grantCalls[0]?.body).toMatchObject({
      user_id: "user-new-1",
      audience: "vyaya",
      role: "admin",
    });
  });

  it("is idempotent: a second login creates nothing new", async () => {
    const token = mint({
      sub: "user-new-2",
      email: "second@vyaya.local",
      orgId: "org-new-2",
    });
    const first = await handleAuthCallback(token, deps());
    const second = await handleAuthCallback(token, deps());
    expect(first.createdWorkspace).toBe(true);
    expect(second.createdWorkspace).toBe(false);
    expect(second.redirectTo).toBe("/dashboard");
    expect(second.payload.workspaceId).toBe(first.payload.workspaceId);
    expect(second.payload.userId).toBe(first.payload.userId);
    // Grant only happens on workspace creation.
    expect(grantCalls).toHaveLength(0);

    const users = await fixture.handle.client`
      SELECT COUNT(*)::int AS n FROM users WHERE deskid_sub = 'user-new-2'
    `;
    expect(users[0]?.n).toBe(1);
  });

  it("joins an existing workspace when org_id matches", async () => {
    // Pre-create a workspace bound to a DeskId org (as the worker would).
    const orgId = "org-existing";
    const workspaceId = randomUUID();
    await fixture.handle.client`
      INSERT INTO workspaces (id, name, slug, deskid_org_id)
      VALUES (${workspaceId}, 'Existing Co', ${`existing-${workspaceId.slice(0, 8)}`}, ${orgId})
    `;
    const token = mint({ sub: "user-joiner", email: "j@co.example", orgId });
    const result = await handleAuthCallback(token, deps());
    expect(result.createdWorkspace).toBe(false);
    expect(result.payload.workspaceId).toBe(workspaceId);
  });

  it("rejects tampered signatures", async () => {
    const token = mint({ sub: "user-tampered" });
    const [h, b] = token.split(".");
    const forged = `${h}.${b}.${Buffer.from("forged").toString("base64url")}`;
    await expect(handleAuthCallback(forged, deps())).rejects.toBeInstanceOf(
      AuthCallbackError,
    );
  });

  it("rejects expired tokens", async () => {
    const past = Date.UTC(2020, 0, 1);
    const token = mint({ sub: "user-expired", now: () => past });
    await expect(handleAuthCallback(token, deps())).rejects.toBeInstanceOf(
      AuthCallbackError,
    );
  });

  it("rejects wrong issuer and missing audience", async () => {
    const base = {
      sub: "user-x",
      email: "x@x.example",
      org_id: null,
      workspace_id: null,
      roles: { vyaya: "admin" },
      token_version: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const wrongIss = mintRaw({ ...base, iss: "http://evil.test", aud: ["vyaya"] });
    await expect(handleAuthCallback(wrongIss, deps())).rejects.toBeInstanceOf(
      AuthCallbackError,
    );
    const wrongAud = mintRaw({ ...base, iss: ISSUER, aud: ["other-app"] });
    await expect(handleAuthCallback(wrongAud, deps())).rejects.toBeInstanceOf(
      AuthCallbackError,
    );
  });

  it("rejects tokens signed by an unknown kid", async () => {
    const otherKey = generateSigningKey();
    const token = issueToken({
      key: otherKey,
      issuer: ISSUER,
      ttlSec: 3600,
      sub: "user-unknown-kid",
    }).token;
    // The cache refreshes on unknown kid, still doesn't find it -> rejected.
    await expect(handleAuthCallback(token, deps())).rejects.toBeInstanceOf(
      AuthCallbackError,
    );
  });
});

describe("provisionWorkspaceForClaims", () => {
  it("syncs email and role changes on later logins", async () => {
    const sub = "user-sync";
    const first = await handleAuthCallback(
      mint({ sub, email: "old@vyaya.local", role: "admin" }),
      deps(),
    );
    const second = await handleAuthCallback(
      mint({
        sub,
        email: "new@vyaya.local",
        orgId: "ignored-once-provisioned",
        role: "viewer",
      }),
      deps(),
    );
    expect(second.payload.workspaceId).toBe(first.payload.workspaceId);
    expect(second.payload.role).toBe("viewer");
    const rows = await fixture.handle.client`
      SELECT email, role FROM users WHERE deskid_sub = ${sub}
    `;
    expect(rows[0]).toMatchObject({ email: "new@vyaya.local", role: "viewer" });
  });

  it("maps a claims-only session onto the seed workspace shape", async () => {
    // Direct provision with claims referencing a seeded-style user proves
    // the claims -> workspace mapping used by every BFF handler.
    const claims = {
      sub: makeSession("placeholder").sub,
      email: "admin@acme.example",
      org_id: null,
      workspace_id: null,
      aud: ["vyaya"],
      roles: { vyaya: "admin" as const },
      token_version: 1,
      iss: ISSUER,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    // Seed isn't loaded in this file (migrations only) — provision creates.
    const result = await provisionWorkspaceForClaims(fixture.handle.db, claims);
    expect(result.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.role).toBe("admin");
  });
});
