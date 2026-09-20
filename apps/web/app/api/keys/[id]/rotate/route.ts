import { z } from "zod";
import { rotateApiKey } from "@/lib/bff/keys";
import { getDb } from "@/lib/db";
import { requireWrite } from "@/lib/errors";
import { requireSession, respond } from "@/lib/http";

const idSchema = z.uuid();

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const session = await requireSession();
    requireWrite(session);
    const id = idSchema.parse((await ctx.params).id);
    // New plaintext appears in this response exactly once.
    return Response.json(await rotateApiKey(getDb().db, session, id), {
      status: 201,
    });
  });
}
