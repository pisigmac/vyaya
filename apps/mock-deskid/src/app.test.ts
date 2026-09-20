import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deskIdClaimsSchema,
  JwksCache,
  verifyDeskIdJwt,
  JwtVerificationError,
  type Jwks,
} from "@vyaya/core";
import { assertDevMode, createApp, type MockDeskIdDeps } from "./app.js";
import {
  deriveKid,
  generateSigningKey,
  jwksFor,
  loadKeyring,
  type KeyringHolder,
} from "./keys.js";
import { MockDeskIdStore } from "./store.js";

const ISSUER = "http://localhost:8091";
const SPA_CALLBACK = "http://localhost:3000/auth/callback";

function makeDeps(overrides: Partial<MockDeskIdDeps> = {}): MockDeskIdDeps {
  const keyring: KeyringHolder = {
    keyring: { current: generateSigningKey(), previous: null },
    keysDir: null,
  };
  return {
    issuer: ISSUER,
    spaCallbackUrl: SPA_CALLBACK,
    tokenTtlSec: 3600,
    keyring,
    store: new MockDeskIdStore(),
    ...overrides,
  };
}

function decodePayload(token: string): unknown {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
}

function decodeHeader(token: string): { alg: string; kid: string } {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"));
}

/** JwksCache wired to the app via an injected fetcher (no network). */
function jwksCacheFor(app: ReturnType<typeof createApp>): JwksCache {
  return new JwksCache({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    ttlMs: 60_000,
    fetcher: async (): Promise<Jwks> =>
      (await app.request("/.well-known/jwks.json")).json() as Promise<Jwks>,
  });
}

async function mintToken(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown> = {},
): Promise<{ token: string; claims: Record<string, unknown> }> {
  const res = await app.request("/v1/dev/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string; claims: Record<string, unknown> }>;
}

describe("mock-deskid: claim shape", () => {
  it("issues tokens matching the DeskId claim contract", async () => {
    const app = createApp(makeDeps());
    const { token } = await mintToken(app, {
      sub: "user-1",
      email: "dev@vyaya.local",
      org_id: "org-1",
      workspace_id: "ws-1",
      role: "operator",
    });
    const payload = decodePayload(token);
    const parsed = deskIdClaimsSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sub).toBe("user-1");
    expect(parsed.data.email).toBe("dev@vyaya.local");
    expect(parsed.data.org_id).toBe("org-1");
    expect(parsed.data.workspace_id).toBe("ws-1");
    expect(parsed.data.aud).toContain("vyaya");
    expect(parsed.data.roles["vyaya"]).toBe("operator");
    expect(parsed.data.token_version).toBe(1);
    expect(parsed.data.iss).toBe(ISSUER);
    expect(parsed.data.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(decodeHeader(token).alg).toBe("RS256");
  });
});

describe("mock-deskid: JWKS", () => {
  it("advertises the signing key by kid", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as Jwks;
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(deps.keyring.keyring.current.kid);
    expect(jwks.keys[0]?.kty).toBe("RSA");
    expect(jwks.keys[0]?.alg).toBe("RS256");
    expect(jwks.keys[0]?.use).toBe("sig");
  });

  it("advertises current and previous keys after rotation", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const oldKid = deps.keyring.keyring.current.kid;
    const res = await app.request("/v1/admin/rotate-keys", { method: "POST" });
    expect(res.status).toBe(200);
    const rotated = await res.json();
    expect(rotated.previous_kid).toBe(oldKid);
    expect(rotated.current_kid).not.toBe(oldKid);
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as Jwks;
    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).toContain(oldKid);
    expect(kids).toContain(rotated.current_kid);
    expect(jwks.keys).toHaveLength(2);
  });
});

describe("mock-deskid: verification through @vyaya/core", () => {
  it("a freshly issued token verifies through the real JWKS cache path", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const jwks = jwksCacheFor(app);
    const { token } = await mintToken(app, { sub: "user-42" });
    const claims = await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    expect(claims.sub).toBe("user-42");
    expect(claims.roles["vyaya"]).toBe("admin");
    expect(jwks.size).toBe(1);
  });

  it("unknown kid after rotation triggers a JWKS refresh and verifies", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const jwks = jwksCacheFor(app);

    // Prime the cache with the pre-rotation key.
    const first = await mintToken(app, { sub: "before-rotation" });
    await verifyDeskIdJwt(first.token, { issuer: ISSUER, jwks });
    expect(jwks.size).toBe(1);

    // Rotate: new tokens carry a kid the cache has never seen.
    await app.request("/v1/admin/rotate-keys", { method: "POST" });
    const second = await mintToken(app, { sub: "after-rotation" });
    const claims = await verifyDeskIdJwt(second.token, { issuer: ISSUER, jwks });
    expect(claims.sub).toBe("after-rotation");
    expect(jwks.size).toBe(2);

    // Tokens signed with the previous key still verify (overlap window).
    const oldClaims = await verifyDeskIdJwt(first.token, {
      issuer: ISSUER,
      jwks,
    });
    expect(oldClaims.sub).toBe("before-rotation");
  });

  it("rejects a token signed by an unknown key after refresh", async () => {
    const app = createApp(makeDeps());
    const jwks = jwksCacheFor(app);
    const stranger = createApp(makeDeps()); // different keypair entirely
    const { token } = await mintToken(stranger);
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "unknown_kid" });
  });

  it("rejects the wrong issuer", async () => {
    const app = createApp(makeDeps());
    const jwks = jwksCacheFor(app);
    const { token } = await mintToken(app);
    await expect(
      verifyDeskIdJwt(token, { issuer: "https://someone-else.example", jwks }),
    ).rejects.toBeInstanceOf(JwtVerificationError);
  });
});

describe("mock-deskid: OAuth stubs", () => {
  it("google start redirects to the SPA callback with a fresh token", async () => {
    const app = createApp(makeDeps());
    const res = await app.request(
      "/v1/oauth/google/start?sub=oauth-user&role=viewer",
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(SPA_CALLBACK);
    expect(location.searchParams.get("provider")).toBe("google");
    const token = location.searchParams.get("token");
    expect(token).toBeTruthy();
    const claims = await verifyDeskIdJwt(token ?? "", {
      issuer: ISSUER,
      jwks: jwksCacheFor(app),
    });
    expect(claims.sub).toBe("oauth-user");
    expect(claims.roles["vyaya"]).toBe("viewer");
  });

  it("github start works and unknown providers 404", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/v1/oauth/github/start");
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("provider"),
    ).toBe("github");
    const missing = await app.request("/v1/oauth/gitlab/start");
    expect(missing.status).toBe(404);
  });
});

describe("mock-deskid: grants and reconciliation", () => {
  it("grants an audience and includes it in newly issued tokens", async () => {
    const app = createApp(makeDeps());
    const grant = await app.request("/v1/admin/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "user-9", audience: "kubemind" }),
    });
    expect(grant.status).toBe(201);
    const { token } = await mintToken(app, { sub: "user-9" });
    const claims = await verifyDeskIdJwt(token, {
      issuer: ISSUER,
      jwks: jwksCacheFor(app),
    });
    expect(claims.aud).toContain("vyaya");
    expect(claims.aud).toContain("kubemind");
  });

  it("reconciliation feed filters by since_id and reports latest_id", async () => {
    const app = createApp(makeDeps());
    await mintToken(app, { sub: "user-a" }); // user.created id=1
    await app.request("/v1/admin/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "user-a", audience: "kubemind" }),
    }); // grant.created id=2

    const all = (await (
      await app.request("/v1/admin/reconciliation/events?since_id=0")
    ).json()) as { events: { id: number; type: string; occurred_at: string; data: Record<string, unknown> }[]; latest_id: number };
    expect(all.events.map((e) => e.type)).toEqual(["user.created", "grant.created"]);
    expect(all.events[0]?.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(all.latest_id).toBe(2);

    const delta = (await (
      await app.request("/v1/admin/reconciliation/events?since_id=1")
    ).json()) as { events: { id: number; type: string }[]; latest_id: number };
    expect(delta.events).toHaveLength(1);
    expect(delta.events[0]?.type).toBe("grant.created");
    expect(delta.events[0]?.data).toMatchObject({
      user_id: "user-a",
      audience: "kubemind",
    });

    const bad = await app.request("/v1/admin/reconciliation/events?since_id=nope");
    expect(bad.status).toBe(400);
  });
});

describe("mock-deskid: DEV ONLY guard", () => {
  it("refuses to start unless AUTH_MODE=dev", () => {
    expect(() => assertDevMode("deskid")).toThrow(/DEV ONLY/);
    expect(() => assertDevMode("production")).toThrow(/DEV ONLY/);
    expect(() => assertDevMode("dev")).not.toThrow();
  });
});

describe("mock-deskid: keyring", () => {
  it("persists keys under keysDir and reloads the same kid", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-deskid-keys-"));
    const first = loadKeyring({ keysDir: dir });
    expect(existsSync(join(dir, "current.private.pem"))).toBe(true);
    const second = loadKeyring({ keysDir: dir });
    expect(second.keyring.current.kid).toBe(first.keyring.current.kid);
    // Private key material must not be world-readable.
    const mode = readFileSync(join(dir, "current.private.pem")); // readable by owner
    expect(mode.toString()).toContain("BEGIN PRIVATE KEY");
  });

  it("honors env-provided PEMs (base64 single-line) without touching disk", () => {
    const key = generateSigningKey();
    const holder = loadKeyring({
      keysDir: join(tmpdir(), "should-not-be-created"),
      privateKeyPem: Buffer.from(key.privateKeyPem).toString("base64"),
      publicKeyPem: Buffer.from(key.publicKeyPem).toString("base64"),
    });
    expect(holder.keysDir).toBeNull();
    expect(holder.keyring.current.kid).toBe(key.kid);
  });

  it("rejects a half-configured env keypair", () => {
    const key = generateSigningKey();
    expect(() =>
      loadKeyring({ keysDir: "x", privateKeyPem: key.privateKeyPem }),
    ).toThrow(/must be set together/);
  });

  it("jwksFor omits previous before the first rotation", () => {
    const jwks = jwksFor({ current: generateSigningKey(), previous: null });
    expect(jwks.keys).toHaveLength(1);
  });

  it("derives stable kids from public keys", () => {
    const key = generateSigningKey();
    expect(deriveKid(key.publicKeyPem)).toBe(key.kid);
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
