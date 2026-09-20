import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Next.js "proxy" (the file formerly known as middleware): gate the authed
 * sections. API routes authenticate themselves in their handlers; this only
 * covers pages, and the layout re-checks server-side anyway.
 */
export async function proxy(request: NextRequest) {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  let session = null;
  try {
    session = await verifySession(value, getEnv().auth.sessionCookieSecret);
  } catch {
    session = null;
  }
  if (session) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/dashboard/:path*", "/settings/:path*", "/onboarding/:path*"],
};
