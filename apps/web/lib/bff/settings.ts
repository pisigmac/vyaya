import { EnvelopeCipher } from "@vyaya/core";
import type { DrizzleDatabase } from "@vyaya/db";
import { workspaces } from "@vyaya/db";
import { eq } from "drizzle-orm";
import type { SessionPayload } from "../session";

/**
 * Workspace settings: name + the body-logging opt-in. Opting in generates
 * a fresh workspace DEK and stores it wrapped (AES-256-GCM under the env
 * master key); opting out clears it. The proxy reads both fields on auth.
 */

export interface WorkspaceSettings {
  name: string;
  slug: string;
  logBodiesEnabled: boolean;
}

export interface UpdateWorkspaceInput {
  name: string;
  logBodiesEnabled: boolean;
}

export interface SettingsDeps {
  masterKeyHex: string;
}

type WorkspaceRow = typeof workspaces.$inferSelect;

function toSettings(row: WorkspaceRow): WorkspaceSettings {
  return {
    name: row.name,
    slug: row.slug,
    logBodiesEnabled: row.logBodiesEnabled,
  };
}

export async function getWorkspaceSettings(
  db: DrizzleDatabase,
  session: SessionPayload,
): Promise<WorkspaceSettings> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1);
  if (rows[0] === undefined) throw new Error("workspace not found");
  return toSettings(rows[0]);
}

export async function updateWorkspaceSettings(
  db: DrizzleDatabase,
  session: SessionPayload,
  input: UpdateWorkspaceInput,
  deps: SettingsDeps,
): Promise<WorkspaceSettings> {
  const current = await getWorkspaceSettings(db, session);
  let wrappedDek: unknown = undefined;
  if (input.logBodiesEnabled && !current.logBodiesEnabled) {
    const cipher = new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(deps.masterKeyHex));
    wrappedDek = cipher.wrapDek(EnvelopeCipher.generateDek());
  } else if (!input.logBodiesEnabled && current.logBodiesEnabled) {
    wrappedDek = null;
  }
  const patch: Record<string, unknown> = {
    name: input.name,
    logBodiesEnabled: input.logBodiesEnabled,
  };
  if (wrappedDek !== undefined) patch["wrappedDek"] = wrappedDek;
  const rows = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, session.workspaceId))
    .returning();
  if (rows[0] === undefined) throw new Error("workspace not found");
  return toSettings(rows[0]);
}
