import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JwksCache, UnknownKeyIdError, type Jwks } from "./jwks-cache.js";
import { JwtVerificationError, verifyDeskIdJwt } from "./verify.js";

const ISSUER = "https://deskid.test";
const JWKS_URL = "https://deskid.test/.well-known/jwks.json";

interface TestKey {
  kid: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { kid, publicKey, privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

function signJwt(
  key: TestKey,
  payload: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...headerOverrides };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${h}.${p}`);
  signer.end();
  const sig = signer.sign(key.privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user-uuid-1",
    email: "dev@vyaya.test",
    org_id: "org-1",
    workspace_id: "ws-1",
    aud: ["vyaya"],
    roles: { vyaya: "admin" },
    token_version: 1,
    iss: ISSUER,
    iat: 1_700_000_000,
    exp: 4_000_000_000, // far future
    ...overrides,
  };
}

/** Fake JWKS fetcher serving a controllable key set and counting fetches. */
function fakeFetcher(keys: TestKey[]) {
  const state = { fetches: 0 };
  const fetcher = async (_url: string): Promise<Jwks> => {
    state.fetches += 1;
    return { keys: keys.map((k) => k.jwk) };
  };
  return { fetcher, state };
}

describe("verifyDeskIdJwt", () => {
  it("verifies a valid token and returns typed claims", async () => {
    const key = makeKey("kid-1");
    const { fetcher, state } = fakeFetcher([key]);
    const jwks = new JwksCache({ jwksUrl: JWKS_URL, ttlMs: 300_000, fetcher });
    const token = signJwt(key, validPayload());
    const claims = await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    expect(claims.sub).toBe("user-uuid-1");
    expect(claims.workspace_id).toBe("ws-1");
    expect(claims.aud).toEqual(["vyaya"]);
    expect(claims.roles["vyaya"]).toBe("admin");
    expect(state.fetches).toBe(1);
  });

  it("serves the second verification from cache (no refetch)", async () => {
    const key = makeKey("kid-1");
    const { fetcher, state } = fakeFetcher([key]);
    const jwks = new JwksCache({ jwksUrl: JWKS_URL, ttlMs: 300_000, fetcher });
    const token = signJwt(key, validPayload());
    await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    expect(state.fetches).toBe(1);
  });

  it("rejects wrong audience", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload({ aud: ["someone-else"] }));
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "wrong_audience" });
  });

  it("accepts aud given as a bare string", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload({ aud: "vyaya" }));
    const claims = await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    expect(claims.aud).toEqual(["vyaya"]);
  });

  it("rejects wrong issuer", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload({ iss: "https://evil.test" }));
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "wrong_issuer" });
  });

  it("rejects expired tokens", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const nowMs = 1_800_000_000_000;
    const token = signJwt(
      key,
      validPayload({ exp: Math.floor(nowMs / 1000) - 60 }),
    );
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks, now: () => nowMs }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("refreshes JWKS on unknown kid and succeeds after rotation", async () => {
    const oldKey = makeKey("kid-old");
    const newKey = makeKey("kid-new");
    const servedKeys = [oldKey];
    const state = { fetches: 0 };
    const fetcher = async (): Promise<Jwks> => {
      state.fetches += 1;
      return { keys: servedKeys.map((k) => k.jwk) };
    };
    const jwks = new JwksCache({ jwksUrl: JWKS_URL, ttlMs: 300_000, fetcher });
    // Prime cache with the old key.
    await jwks.getPublicKey("kid-old");
    expect(state.fetches).toBe(1);
    // DeskId rotates: new tokens carry kid-new, JWKS now serves both.
    servedKeys.push(newKey);
    const token = signJwt(newKey, validPayload());
    const claims = await verifyDeskIdJwt(token, { issuer: ISSUER, jwks });
    expect(claims.sub).toBe("user-uuid-1");
    expect(state.fetches).toBe(2); // one extra fetch on unknown kid
  });

  it("fails with unknown_kid when the kid never appears", async () => {
    const key = makeKey("kid-1");
    const ghost = makeKey("kid-ghost");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(ghost, validPayload());
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "unknown_kid" });
    await expect(jwks.getPublicKey("kid-ghost")).rejects.toBeInstanceOf(
      UnknownKeyIdError,
    );
  });

  it("rejects tampered signatures", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload());
    const [h, p, sig] = token.split(".") as [string, string, string];
    const forged = `${h}.${Buffer.from(
      JSON.stringify(validPayload({ workspace_id: "ws-attacker" })),
    ).toString("base64url")}.${sig}`;
    await expect(
      verifyDeskIdJwt(forged, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "bad_signature" });
    const mangled = `${h}.${p}.${"A".repeat(sig.length)}`;
    await expect(
      verifyDeskIdJwt(mangled, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "bad_signature" });
  });

  it("rejects malformed tokens", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    await expect(
      verifyDeskIdJwt("not-a-jwt", { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "malformed" });
    await expect(
      verifyDeskIdJwt("a.b.c.d", { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "malformed" });
    const badJson = `${Buffer.from("nope").toString("base64url")}.x.y`;
    await expect(
      verifyDeskIdJwt(badJson, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "malformed" });
  });

  it("rejects non-RS256 algorithms", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload(), { alg: "HS256" });
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "unsupported_alg" });
  });

  it("rejects tokens without kid", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const h = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const p = Buffer.from(JSON.stringify(validPayload())).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${h}.${p}`);
    signer.end();
    const token = `${h}.${p}.${signer.sign(key.privateKey).toString("base64url")}`;
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "missing_kid" });
  });

  it("rejects structurally invalid claims", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const token = signJwt(key, validPayload({ token_version: "one" }));
    await expect(
      verifyDeskIdJwt(token, { issuer: ISSUER, jwks }),
    ).rejects.toMatchObject({ reason: "invalid_claims" });
  });

  it("is a JwtVerificationError with a reason code", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: fakeFetcher([key]).fetcher,
    });
    const err = await verifyDeskIdJwt("bad", { issuer: ISSUER, jwks }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JwtVerificationError);
  });
});

describe("JwksCache", () => {
  it("refreshes after TTL expiry", async () => {
    const key = makeKey("kid-1");
    const { fetcher, state } = fakeFetcher([key]);
    let now = 1_000_000;
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 60_000,
      fetcher,
      now: () => now,
    });
    await jwks.getPublicKey("kid-1");
    now += 30_000;
    await jwks.getPublicKey("kid-1");
    expect(state.fetches).toBe(1); // still within TTL
    now += 31_000;
    await jwks.getPublicKey("kid-1");
    expect(state.fetches).toBe(2); // TTL expired -> refresh
  });

  it("invalidate() forces a refetch", async () => {
    const key = makeKey("kid-1");
    const { fetcher, state } = fakeFetcher([key]);
    const jwks = new JwksCache({ jwksUrl: JWKS_URL, ttlMs: 300_000, fetcher });
    await jwks.getPublicKey("kid-1");
    jwks.invalidate();
    await jwks.getPublicKey("kid-1");
    expect(state.fetches).toBe(2);
  });

  it("skips non-RSA keys", async () => {
    const key = makeKey("kid-1");
    const jwks = new JwksCache({
      jwksUrl: JWKS_URL,
      ttlMs: 300_000,
      fetcher: async () => ({
        keys: [{ kty: "OKP", kid: "kid-okp", crv: "Ed25519", x: "abc" }, key.jwk],
      }),
    });
    expect(jwks.size).toBe(0);
    await jwks.getPublicKey("kid-1");
    expect(jwks.size).toBe(1);
  });
});
