import { describe, expect, it } from "vitest";
import {
  AUTH_TAG_BYTES,
  EnvelopeCipher,
  EnvelopeDecryptError,
  EnvelopeKeyError,
  IV_BYTES,
} from "./envelope.js";

const MASTER_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeCipher(): EnvelopeCipher {
  return new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(MASTER_HEX));
}

/** Flip one character in a base64 payload field. */
function tamper(value: string): string {
  const idx = Math.max(0, Math.floor(value.length / 2));
  const replacement = value[idx] === "A" ? "B" : "A";
  return value.slice(0, idx) + replacement + value.slice(idx + 1);
}

describe("EnvelopeCipher key handling", () => {
  it("accepts a valid 64-hex master key", () => {
    expect(() => makeCipher()).not.toThrow();
  });

  it("rejects malformed master key hex", () => {
    expect(() => EnvelopeCipher.masterKeyFromHex("zzzz")).toThrow(
      EnvelopeKeyError,
    );
    expect(() => EnvelopeCipher.masterKeyFromHex("ab".repeat(16))).toThrow(
      EnvelopeKeyError,
    );
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => new EnvelopeCipher(Buffer.alloc(16))).toThrow(
      EnvelopeKeyError,
    );
  });

  it("generates 32-byte DEKs", () => {
    const dek = EnvelopeCipher.generateDek();
    expect(dek.length).toBe(32);
    expect(EnvelopeCipher.generateDek().equals(dek)).toBe(false);
  });
});

describe("EnvelopeCipher round trips", () => {
  it("encrypts and decrypts text bodies", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const secret = "prompt: write a haiku about token waste";
    const payload = cipher.encryptText(dek, secret);
    expect(payload.ciphertext).not.toContain(secret);
    expect(Buffer.from(payload.iv, "base64").length).toBe(IV_BYTES);
    expect(Buffer.from(payload.authTag, "base64").length).toBe(AUTH_TAG_BYTES);
    expect(cipher.decryptText(dek, payload)).toBe(secret);
  });

  it("round-trips binary bodies", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const data = Buffer.from([0, 1, 2, 250, 251, 252, 13, 37]);
    const payload = cipher.encrypt(dek, data);
    expect(cipher.decrypt(dek, payload).equals(data)).toBe(true);
  });

  it("round-trips with AAD binding", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const aad = Buffer.from("workspace-123");
    const payload = cipher.encryptText(dek, "hello", aad);
    expect(cipher.decryptText(dek, payload, aad)).toBe("hello");
  });

  it("wraps and unwraps a workspace DEK with the master key", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const wrapped = cipher.wrapDek(dek);
    expect(Buffer.from(wrapped.wrappedKey, "base64").equals(dek)).toBe(false);
    expect(cipher.unwrapDek(wrapped).equals(dek)).toBe(true);
  });

  it("produces different ciphertexts for identical plaintexts (random IV)", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const a = cipher.encryptText(dek, "same input");
    const b = cipher.encryptText(dek, "same input");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe("EnvelopeCipher tamper resistance", () => {
  it("rejects tampered ciphertext", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const payload = cipher.encryptText(dek, "do not touch");
    expect(() =>
      cipher.decrypt(dek, { ...payload, ciphertext: tamper(payload.ciphertext) }),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects tampered auth tag", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const payload = cipher.encryptText(dek, "do not touch");
    expect(() =>
      cipher.decrypt(dek, { ...payload, authTag: tamper(payload.authTag) }),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects tampered IV", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const payload = cipher.encryptText(dek, "do not touch");
    expect(() =>
      cipher.decrypt(dek, { ...payload, iv: tamper(payload.iv) }),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects a wrong DEK", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const payload = cipher.encryptText(dek, "workspace A body");
    expect(() =>
      cipher.decrypt(EnvelopeCipher.generateDek(), payload),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects mismatched AAD", () => {
    const cipher = makeCipher();
    const dek = EnvelopeCipher.generateDek();
    const payload = cipher.encryptText(
      dek,
      "bound body",
      Buffer.from("workspace-1"),
    );
    expect(() =>
      cipher.decrypt(dek, payload, Buffer.from("workspace-2")),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects unwrapping a DEK with the wrong master key", () => {
    const cipherA = makeCipher();
    const cipherB = new EnvelopeCipher(
      EnvelopeCipher.masterKeyFromHex("f".repeat(64)),
    );
    const wrapped = cipherA.wrapDek(EnvelopeCipher.generateDek());
    expect(() => cipherB.unwrapDek(wrapped)).toThrow(EnvelopeDecryptError);
  });

  it("rejects unwrapping a tampered wrapped key", () => {
    const cipher = makeCipher();
    const wrapped = cipher.wrapDek(EnvelopeCipher.generateDek());
    expect(() =>
      cipher.unwrapDek({ ...wrapped, wrappedKey: tamper(wrapped.wrappedKey) }),
    ).toThrow(EnvelopeDecryptError);
  });

  it("rejects a wrong-sized DEK at encrypt/decrypt time", () => {
    const cipher = makeCipher();
    const short = Buffer.alloc(16);
    expect(() => cipher.encryptText(short, "x")).toThrow(EnvelopeKeyError);
    expect(() => cipher.wrapDek(short)).toThrow(EnvelopeKeyError);
  });
});
