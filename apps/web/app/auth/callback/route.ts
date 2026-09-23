import { NextResponse, type NextRequest } from "next/server";
import { handleAuthCallback } from "@/lib/bff/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getJwksCache } from "@/lib/jwks";
import { callbackQuerySchema } from "@/lib/schemas";
import { sessionSetCookie } from "@/lib/session";

/**
 * OAuth callback. DeskId (or mock-deskid in AUTH_MODE=dev) redirects here
 * with ?token=<RS256 JWT>. The token is verified statelessly against the
 * cached JWKS, the user is provisioned (workspace auto-created on first
 * login), and a signed session cookie is set.
 *
 * Also mounted at /api/auth/callback (thin re-export).
 */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const url = new URL(request.url);
  const parsed = callbackQuerySchema.safeParse({
    token: url.searchParams.get("token") ?? "",
    provider: url.searchParams.get("provider") ?? undefined,
  });

  const fail = (reason: string) => {
    const target = new URL("/login", request.url);
    target.searchParams.set("error", reason);
    return NextResponse.redirect(target);
  };

  if (!parsed.success) return fail("missing_token");

  try {
    const result = await handleAuthCallback(parsed.data.token, {
      jwks: getJwksCache(),
      issuer: env.auth.deskIdIssuer,
      db: getDb().db,
      sessionSecret: env.auth.sessionCookieSecret,
      sessionTtlSec: env.auth.sessionTtlSec,
      deskIdBaseUrl: env.auth.deskIdBaseUrl,
      deskIdAdminToken: env.auth.deskIdAdminToken,
    });
    const res = NextResponse.redirect(new URL(result.redirectTo, request.url));
    res.headers.append(
      "Set-Cookie",
      sessionSetCookie(result.sessionValue, {
        ttlSec: env.auth.sessionTtlSec,
        secure: env.nodeEnv === "production",
      }),
    );
    return res;
  } catch {
    return fail("invalid_token");
  }
}
