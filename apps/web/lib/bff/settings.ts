import { eq } from "drizzle-orm";
import { withWorkspace, type VyayaDatabase } from "@vyaya/db/client";
import * as schema from "@vyaya/db/schema";
import type { UpdateWorkspaceBody } from "../schemas";
import type { SessionPayload } from "../session";

/** Workspace settings: body logging opt-in, report recipient, tag allowlist. */

export interface WorkspaceSettings {
  name: string;
  slug: string;
  logBodiesEnabled: boolean;
  reportEmail: string | null;
  featureTags: string[];
}

export async function getWorkspaceSettings(
  db: VyayaDatabase,
  session: SessionPayload,
): Promise<WorkspaceSettings> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, session.workspaceId))
      .limit(1);
    const tags = await tx
      .select({ tag: schema.featureTagAllowlist.tag })
      .from(schema.featureTagAllowlist)
      .where(eq(schema.featureTagAllowlist.workspaceId, session.workspaceId));
    const ws = rows[0];
    return {
      name: ws?.name ?? "workspace",
      slug: ws?.slug ?? "",
      logBodiesEnabled: ws?.logBodiesEnabled ?? false,
      reportEmail: ws?.reportEmail ?? null,
      featureTags: tags.map((t) => t.tag).sort(),
    };
  });
}

export async function updateWorkspaceSettings(
  db: VyayaDatabase,
  session: SessionPayload,
  body: UpdateWorkspaceBody,
): Promise<WorkspaceSettings> {
  await withWorkspace(db, session.workspaceId, async (tx) => {
    const patch: Partial<{
      logBodiesEnabled: boolean;
      reportEmail: string | null;
    }> = {};
    if (body.logBodiesEnabled !== undefined) {
      patch.logBodiesEnabled = body.logBodiesEnabled;
    }
    if (body.reportEmail !== undefined) {
      patch.reportEmail =
        body.reportEmail === null || body.reportEmail === ""
          ? null
          : body.reportEmail;
    }
    if (Object.keys(patch).length > 0) {
      await tx
        .update(schema.workspaces)
        .set(patch)
        .where(eq(schema.workspaces.id, session.workspaceId));
    }
    if (body.featureTags !== undefined) {
      // Replace the allowlist wholesale: editor submits the full list.
      await tx
        .delete(schema.featureTagAllowlist)
        .where(
          eq(schema.featureTagAllowlist.workspaceId, session.workspaceId),
        );
      if (body.featureTags.length > 0) {
        await tx.insert(schema.featureTagAllowlist).values(
          [...new Set(body.featureTags)].map((tag) => ({
            workspaceId: session.workspaceId,
            tag,
          })),
        );
      }
    }
  });
  return getWorkspaceSettings(db, session);
}
