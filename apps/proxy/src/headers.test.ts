import { describe, expect, it } from "vitest";
import { parseVyayaHeaders } from "./headers.js";

describe("parseVyayaHeaders", () => {
  const get =
    (headers: Record<string, string>) =>
    (name: string): string | undefined =>
      headers[name];

  it("parses a full header set", () => {
    const parsed = parseVyayaHeaders(
      get({
        "x-vyaya-request-id": "req-abc_123",
        "x-vyaya-session": "sess-9",
        "x-vyaya-tag": "support",
        "x-vyaya-retry-attempt": "2",
        "x-vyaya-retry-of": "req-first",
        "x-vyaya-consumed": "false",
      }),
    );
    expect(parsed).toEqual({
      clientRequestId: "req-abc_123",
      sessionId: "sess-9",
      featureTagRaw: "support",
      retryAttempt: 2,
      retryOf: "req-first",
      consumedSignal: false,
    });
  });

  it("defaults when headers are absent", () => {
    const parsed = parseVyayaHeaders(() => undefined);
    expect(parsed.clientRequestId).toBeNull();
    expect(parsed.sessionId).toBeNull();
    expect(parsed.featureTagRaw).toBeNull();
    expect(parsed.retryAttempt).toBe(0);
    expect(parsed.retryOf).toBeNull();
    expect(parsed.consumedSignal).toBeNull();
  });

  it("rejects malformed request ids (falls back to generated)", () => {
    for (const bad of ["", "has spaces", "x".repeat(200), "semi;colon", "-lead"]) {
      expect(parseVyayaHeaders(get({ "x-vyaya-request-id": bad })).clientRequestId).toBeNull();
    }
  });

  it("rejects nonsense retry attempts", () => {
    for (const bad of ["-1", "abc", "99999999"]) {
      expect(parseVyayaHeaders(get({ "x-vyaya-retry-attempt": bad })).retryAttempt).toBe(0);
    }
  });

  it("treats only explicit false-ish values as not consumed", () => {
    expect(parseVyayaHeaders(get({ "x-vyaya-consumed": "false" })).consumedSignal).toBe(false);
    expect(parseVyayaHeaders(get({ "x-vyaya-consumed": "0" })).consumedSignal).toBe(false);
    expect(parseVyayaHeaders(get({ "x-vyaya-consumed": "no" })).consumedSignal).toBe(false);
    expect(parseVyayaHeaders(get({ "x-vyaya-consumed": "true" })).consumedSignal).toBe(true);
    expect(parseVyayaHeaders(get({ "x-vyaya-consumed": "whatever" })).consumedSignal).toBe(true);
  });

  it("caps long header values", () => {
    expect(parseVyayaHeaders(get({ "x-vyaya-session": "s".repeat(300) })).sessionId).toBeNull();
    expect(parseVyayaHeaders(get({ "x-vyaya-tag": "t".repeat(200) })).featureTagRaw).toBeNull();
  });
});
