import { getSummary } from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { requireSession, respond } from "@/lib/http";

export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    return await getSummary(getDb().db, session, 30);
  });
}
