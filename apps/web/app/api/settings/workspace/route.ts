import {
  getWorkspaceSettings,
  updateWorkspaceSettings,
} from "@/lib/bff/settings";
import { getDb } from "@/lib/db";
import { requireWrite } from "@/lib/errors";
import { parseBody, requireSession, respond } from "@/lib/http";
import { updateWorkspaceBodySchema } from "@/lib/schemas";

export async function GET() {
  return respond(async () => {
    const session = await requireSession();
    return await getWorkspaceSettings(getDb().db, session);
  });
}

export async function PATCH(request: Request) {
  return respond(async () => {
    const session = await requireSession();
    requireWrite(session);
    const body = await parseBody(request, updateWorkspaceBodySchema);
    return await updateWorkspaceSettings(getDb().db, session, body);
  });
}
