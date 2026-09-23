import { listReports } from "@/lib/bff/reports";
import { getDb } from "@/lib/db";
import { requireSession, respond } from "@/lib/http";

export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    return { reports: await listReports(getDb().db, session) };
  });
}
