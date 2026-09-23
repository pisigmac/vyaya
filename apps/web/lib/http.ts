import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getEnv } from "./env";
import { HttpError, unauthorized } from "./errors";
import {
  SESSION_COOKIE,
  verifySession,
  type SessionPayload,
} from "./session";

/**
 * Glue between framework-free BFF logic (lib/bff/*) and Next.js route
 * handlers. Handles: session extraction, zod validation, error mapping.
 */

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const value = jar.get(SESSION_COOKIE)?.value;
  return verifySession(value, getEnv().auth.sessionCookieSecret);
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw unauthorized();
  return session;
}

/** Parse a JSON body with zod; 400 on anything else. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(
        400,
        err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    throw err;
  }
}

/** Parse a URL query string with zod. */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) raw[key] = value;
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(
        400,
        err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    throw err;
  }
}

export function jsonOk(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** Map thrown HttpError/ZodError/unknown to a JSON error response. */
export function jsonError(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: err.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  // Never leak internals. No stack traces, no bind values, no bodies.
  console.error(
    JSON.stringify({ level: "error", msg: "unhandled route error" }),
  );
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

/**
 * Run a handler body with uniform error mapping. Return values that aren't
 * Response objects are JSON-serialized.
 */
export async function respond(
  fn: () => Promise<Response | unknown>,
): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : NextResponse.json(out);
  } catch (err) {
    return jsonError(err);
  }
}
