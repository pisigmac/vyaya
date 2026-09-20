import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  verifySession,
  type SessionPayload,
} from "./session";

const SECRET = "test-secret-that-is-long-enough-32+chars";
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    v: 1,
    sub: "user-1",
    email: "dev@vyaya.local",
    userId: "00000000-0000-4000-a000-0000000000a1",
    workspaceId: "00000000-0000-4000-a000-00000000000a",
    orgId: null,
    role: "admin",
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  };
}

describe("session cookie", () => {
  it("round-trips a signed payload", async () => {
    const value = await signSession(payload(), SECRET);
    const back = await verifySession(value, SECRET, () => NOW);
    expect(back?.sub).toBe("user-1");
    expect(back?.role).toBe("admin");
  });

  it("rejects a tampered payload", async () => {
    const value = await signSession(payload(), SECRET);
    const [body, sig] = value.split(".");
    const tamperedPayload = payload({ role: "admin" });
    tamperedPayload.role = "viewer";
    const tamperedBody = Buffer.from(
      JSON.stringify(tamperedPayload),
      "utf8",
    ).toString("base64url");
    expect(await verifySession(`${tamperedBody}.${sig}`, SECRET, () => NOW)).toBeNull();
    expect(body).not.toBe(tamperedBody);
  });

  it("rejects a signature from a different secret", async () => {
    const value = await signSession(payload(), SECRET);
    expect(
      await verifySession(value, "another-secret-that-is-long-enough", () => NOW),
    ).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const value = await signSession(
      payload({ exp: Math.floor(NOW / 1000) - 1 }),
      SECRET,
    );
    expect(await verifySession(value, SECRET, () => NOW)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySession(undefined, SECRET, () => NOW)).toBeNull();
    expect(await verifySession("", SECRET, () => NOW)).toBeNull();
    expect(await verifySession("not-a-session", SECRET, () => NOW)).toBeNull();
    expect(await verifySession("a.b.c", SECRET, () => NOW)).toBeNull();
  });

  it("builds secure cookie headers", () => {
    const set = sessionSetCookie("v", { ttlSec: 60, secure: true });
    expect(set).toContain(`${SESSION_COOKIE}=v`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    const clear = sessionClearCookie(false);
    expect(clear).toContain("Max-Age=0");
    expect(clear).not.toContain("Secure");
  });
});
