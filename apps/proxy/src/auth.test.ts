import { describe, expect, it } from "vitest";
import { hashApiKey } from "@vyaya/db";
import { ApiKeyAuthenticator, AuthUnavailableError } from "./auth.js";
import { FeatureTagChecker } from "./feature-tags.js";
import {
  FakeAuthStore,
  FakeTagStore,
  TEST_WORKSPACE_ID,
} from "./test-utils.js";

describe("ApiKeyAuthenticator", () => {
  it("resolves a valid key to its workspace", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store);
    const result = await auth.authenticate(store.plaintext);
    expect(result?.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(result?.keyId).toBeTruthy();
  });

  it("rejects malformed keys without hitting the store", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store);
    expect(await auth.authenticate("not-a-key")).toBeNull();
    expect(await auth.authenticate("vy_live_zzzz")).toBeNull();
    expect(store.candidatesCalls).toBe(0);
  });

  it("rejects unknown keys", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store);
    const other = await FakeAuthStore.create();
    expect(await auth.authenticate(other.plaintext)).toBeNull();
  });

  it("rejects revoked keys", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store.revokedStore());
    expect(await auth.authenticate(store.plaintext)).toBeNull();
  });

  it("rejects a key with a wrong secret even when last4 collides", async () => {
    const store = await FakeAuthStore.create();
    const tampered = `${store.plaintext.slice(0, -4)}0000`;
    // Point the lookup at the tampered key's last4 while the stored hash
    // belongs to the real key.
    const hash = await hashApiKey(store.plaintext);
    const colliding = {
      findKeyCandidates: () =>
        Promise.resolve([
          {
            keyId: "k",
            workspaceId: TEST_WORKSPACE_ID,
            keyHash: hash,
            revokedAt: null,
          },
        ]),
      getWorkspaceAuthInfo: () =>
        Promise.resolve({ logBodiesEnabled: false, wrappedDek: null }),
    };
    const auth = new ApiKeyAuthenticator(colliding);
    expect(await auth.authenticate(tampered)).toBeNull();
  });

  it("caches positives and negatives (store hit once per key)", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store, { cacheTtlMs: 60_000 });
    await auth.authenticate(store.plaintext);
    await auth.authenticate(store.plaintext);
    expect(store.candidatesCalls).toBe(1);
    const other = await FakeAuthStore.create();
    await auth.authenticate(other.plaintext);
    await auth.authenticate(other.plaintext);
    expect(store.candidatesCalls).toBe(2);
  });

  it("throws AuthUnavailableError when the store is down and key uncached", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store);
    store.failNext = true;
    await expect(auth.authenticate(store.plaintext)).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("serves cached keys when the store goes down", async () => {
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store);
    await auth.authenticate(store.plaintext); // warm cache
    store.failNext = true;
    const result = await auth.authenticate(store.plaintext);
    expect(result?.workspaceId).toBe(TEST_WORKSPACE_ID);
  });

  it("cache entries expire", async () => {
    let now = 0;
    const store = await FakeAuthStore.create();
    const auth = new ApiKeyAuthenticator(store, { cacheTtlMs: 100, now: () => now });
    await auth.authenticate(store.plaintext);
    now += 200;
    await auth.authenticate(store.plaintext);
    expect(store.candidatesCalls).toBe(2);
  });
});

describe("FeatureTagChecker", () => {
  it("workspace rows win when present", async () => {
    const store = new FakeTagStore();
    store.tags = ["chat", "support"];
    const checker = new FeatureTagChecker(store, ["env-only"]);
    expect(await checker.resolve(TEST_WORKSPACE_ID, "chat")).toBe("chat");
    expect(await checker.resolve(TEST_WORKSPACE_ID, "env-only")).toBeNull();
  });

  it("falls back to the env allowlist when the workspace has no rows", async () => {
    const checker = new FeatureTagChecker(new FakeTagStore(), ["env-only"]);
    expect(await checker.resolve(TEST_WORKSPACE_ID, "env-only")).toBe("env-only");
    expect(await checker.resolve(TEST_WORKSPACE_ID, "other")).toBeNull();
  });

  it("allows everything when neither store nor env restricts", async () => {
    const checker = new FeatureTagChecker(new FakeTagStore(), []);
    expect(await checker.resolve(TEST_WORKSPACE_ID, "anything")).toBe("anything");
    expect(await checker.resolve(TEST_WORKSPACE_ID, null)).toBeNull();
  });

  it("drops the tag when the store is down (request must not fail)", async () => {
    const store = new FakeTagStore();
    const checker = new FeatureTagChecker(store, []);
    store.failNext = true;
    expect(await checker.resolve(TEST_WORKSPACE_ID, "x")).toBeNull();
  });
});
