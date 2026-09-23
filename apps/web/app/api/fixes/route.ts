import { getTopFixes } from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { requireSession, respond } from "@/lib/http";

export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    return { fixes: await getTopFixes(getDb().db, session, 30) };
  });
}
