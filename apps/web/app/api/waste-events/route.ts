import { listWasteEvents } from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { parseQuery, requireSession, respond } from "@/lib/http";
import { wasteEventsQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  return respond(async () => {
    const session = await requireSession();
    const query = parseQuery(request, wasteEventsQuerySchema);
    return await listWasteEvents(getDb().db, session, query);
  });
}
