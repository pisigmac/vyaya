import { getTrend } from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { parseQuery, requireSession, respond } from "@/lib/http";
import { trendQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  return respond(async () => {
    const session = await requireSession();
    const query = parseQuery(request, trendQuerySchema);
    return { days: query.days, points: await getTrend(getDb().db, session, query.days) };
  });
}
