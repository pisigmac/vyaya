/**
 * Session cookie: JWT-in-cookie (compact HS256-style: base64url payload +
 * HMAC-SHA256 signature), signed with SESSION_COOKIE_SECRET.
 *
 * Documented choice (per build spec): signed, not encrypted. The payload
 * carries only identity claims (sub, email, role, workspace ids) — no
 * secrets — so integrity + HttpOnly is sufficient and debugging stays sane.
 * Encryption can be layered on later without changing the cookie name.
 *
 * Implemented on Web Crypto (crypto.subtle) so the exact same code runs in
 * Next.js proxy.ts, route handlers, server components and vitest.
 */

export type VyayaRole = "admin" | "operator" | "viewer";

export interface SessionPayload {
  v: 1;
  /** DeskId sub claim (globally unique user id). */
  sub: string;
  email: string;
  /** Local users.id for API-key ownership joins. */
  userId: string;
  /** Local Vyaya workspace UUID resolved at login. */
  workspaceId: string;
  /** DeskId org_id claim, when present. */
  orgId: string | null;
  /** roles.vyaya from the DeskId token. */
  role: VyayaRole;
  /** Expiry, epoch seconds. */
  exp: number;
}

export const SESSION_COOKIE = "vyaya_session";

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(
  value: string | undefined,
  secret: string,
  now: () => number = Date.now,
): Promise<SessionPayload | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = Uint8Array.from(Buffer.from(sig, "base64url"));
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    typeof payload.sub !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp * 1000 <= now()) return null;
  return payload;
}

export interface SessionCookieOptions {
  ttlSec: number;
  secure: boolean;
}

/** Set-Cookie value for the session cookie. */
export function sessionSetCookie(
  value: string,
  options: SessionCookieOptions,
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.ttlSec}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie value that clears the session cookie (logout). */
export function sessionClearCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
