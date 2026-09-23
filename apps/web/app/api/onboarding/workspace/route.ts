import { getFlowState } from "@/lib/bff/stats";
import { getWorkspaceSettings } from "@/lib/bff/settings";
import { getDb } from "@/lib/db";
import { requireSession, respond } from "@/lib/http";

/**
 * Onboarding status: workspace identity plus how far the first-run flow has
 * progressed (key issued? traffic seen? waste found?).
 */
export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    const db = getDb().db;
    const settings = await getWorkspaceSettings(db, session);
    const flow = await getFlowState(db, session);
    return {
      workspace: {
        id: session.workspaceId,
        name: settings.name,
        slug: settings.slug,
      },
      requestCount: flow.requestCount,
      wasteEventCount: flow.wasteEventCount,
    };
  });
}
