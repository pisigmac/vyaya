import { getSession, respond } from "@/lib/http";

/** Who am I? Used by client components to render role-aware UI. */
export async function GET() {
  return respond(async () => {
    const session = await getSession();
    if (!session) {
      return Response.json({ error: "not signed in" }, { status: 401 });
    }
    return {
      user: {
        sub: session.sub,
        email: session.email,
        role: session.role,
        workspaceId: session.workspaceId,
      },
    };
  });
}
