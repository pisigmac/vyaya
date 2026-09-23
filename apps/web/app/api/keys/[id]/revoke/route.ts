import { z } from "zod";
import { revokeApiKey } from "@/lib/bff/keys";
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
    return { key: await revokeApiKey(getDb().db, session, id) };
  });
}
