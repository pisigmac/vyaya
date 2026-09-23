import { describe, expect, it } from "vitest";
import {
  ApiKeyFormatError,
  generateApiKey,
  hashApiKey,
  isPlausibleApiKey,
  verifyApiKey,
} from "./api-keys.js";

describe("api key hashing", () => {
  it("generates vy_live_ keys with 64 hex chars and a matching last4", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).toMatch(/^vy_live_[0-9a-f]{64}$/);
    expect(a.prefix).toBe("vy_live");
    expect(a.last4).toBe(a.plaintext.slice(-4));
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  it("hashes with argon2id and verifies the right key", async () => {
    const { plaintext } = generateApiKey();
    const encoded = await hashApiKey(plaintext);
    expect(encoded.startsWith("$argon2id$v=19$")).toBe(true);
    expect(encoded).not.toContain(plaintext);
    expect(await verifyApiKey(encoded, plaintext)).toBe(true);
  });

  it("rejects a wrong key without throwing", async () => {
    const { plaintext } = generateApiKey();
    const encoded = await hashApiKey(plaintext);
    // Flip one hex char deterministically (never a no-op replacement).
    const wrong = plaintext[8] === "a"
      ? `${plaintext.slice(0, 8)}b${plaintext.slice(9)}`
      : `${plaintext.slice(0, 8)}a${plaintext.slice(9)}`;
    expect(isPlausibleApiKey(wrong)).toBe(true); // format fine, value wrong
    expect(await verifyApiKey(encoded, wrong)).toBe(false);
  });

  it("rejects malformed candidates before touching argon2", async () => {
    const { plaintext } = generateApiKey();
    const encoded = await hashApiKey(plaintext);
    expect(await verifyApiKey(encoded, "vy_live_short")).toBe(false);
    expect(await verifyApiKey(encoded, "sk-live-abc")).toBe(false);
    expect(await verifyApiKey(encoded, "")).toBe(false);
  });

  it("throws on hashing a malformed key (never store a weak format)", async () => {
    await expect(hashApiKey("not-a-vyaya-key")).rejects.toThrow(ApiKeyFormatError);
  });

  it("returns false for a corrupted stored hash instead of throwing", async () => {
    const { plaintext } = generateApiKey();
    expect(await verifyApiKey("$argon2id$v=19$garbage", plaintext)).toBe(false);
    expect(await verifyApiKey("", plaintext)).toBe(false);
  });
});
