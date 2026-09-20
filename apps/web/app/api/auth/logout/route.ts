import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { sessionClearCookie } from "@/lib/session";

/** Log out: clear the session cookie and go back to the landing page. */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const res = NextResponse.redirect(new URL("/", request.url));
  res.headers.append(
    "Set-Cookie",
    sessionClearCookie(env.nodeEnv === "production"),
  );
  return res;
}
