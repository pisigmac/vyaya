import { createApiKey, listApiKeys } from "@/lib/bff/keys";
import { getDb } from "@/lib/db";
import { requireWrite } from "@/lib/errors";
import { parseBody, requireSession, respond } from "@/lib/http";
import { createKeyBodySchema } from "@/lib/schemas";

export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    return { keys: await listApiKeys(getDb().db, session) };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    const session = await requireSession();
    requireWrite(session);
    const body = await parseBody(request, createKeyBodySchema);
    // Plaintext is in this response exactly once. It is never stored.
    return Response.json(await createApiKey(getDb().db, session, body.name), {
      status: 201,
    });
  });
}
