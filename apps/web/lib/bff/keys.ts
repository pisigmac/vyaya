import { generateApiKey, hashApiKey } from "@vyaya/db";
import type { DrizzleDatabase } from "@vyaya/db";
import { apiKeys } from "@vyaya/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SessionPayload } from "../session";

/**
 * API key lifecycle. Plaintext is generated here, returned once, and only
 * the argon2id hash is persisted. All queries are workspace-scoped from
 * the session.
 */

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
}

type KeyRow = typeof apiKeys.$inferSelect;

function summarize(row: KeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    last4: row.last4,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  };
}

export async function listApiKeys(
  db: DrizzleDatabase,
  session: SessionPayload,
): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, session.workspaceId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(summarize);
}

export async function createApiKey(
  db: DrizzleDatabase,
  session: SessionPayload,
  name: string,
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  const { plaintext, last4 } = generateApiKey();
  const keyHash = await hashApiKey(plaintext);
  const [row] = await db
    .insert(apiKeys)
    .values({
      workspaceId: session.workspaceId,
      name,
      keyHash,
      last4,
    })
    .returning();
  return { key: summarize(row!), plaintext };
}

export async function revokeApiKey(
  db: DrizzleDatabase,
  session: SessionPayload,
  keyId: string,
): Promise<ApiKeySummary> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.workspaceId, session.workspaceId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning();
  if (row === undefined) throw new Error("key not found");
  return summarize(row);
}

/** Rotate: revoke the old key, mint a fresh one, return both ids + plaintext. */
export async function rotateApiKey(
  db: DrizzleDatabase,
  session: SessionPayload,
  keyId: string,
): Promise<{ key: ApiKeySummary; plaintext: string; rotatedFromId: string }> {
  const old = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, session.workspaceId)))
    .limit(1);
  if (old[0] === undefined) throw new Error("key not found");
  await revokeApiKey(db, session, keyId);
  const created = await createApiKey(db, session, `${old[0].name} (rotated)`);
  return { ...created, rotatedFromId: keyId };
}
