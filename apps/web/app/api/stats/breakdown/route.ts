import { getBreakdown } from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { parseQuery, requireSession, respond } from "@/lib/http";
import { breakdownQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  return respond(async () => {
    const session = await requireSession();
    const query = parseQuery(request, breakdownQuerySchema);
    return {
      dimension: query.dimension,
      days: query.days,
      slices: await getBreakdown(getDb().db, session, query.dimension, query.days),
    };
  });
}
