import { and, desc, eq, isNull } from "drizzle-orm";
import { withWorkspace, type VyayaDatabase } from "@vyaya/db/client";
import { generateApiKey, hashApiKey } from "@vyaya/db/api-keys";
import * as schema from "@vyaya/db/schema";
import { notFound } from "../errors";
import type { SessionPayload } from "../session";

/**
 * API key lifecycle for the settings screen and onboarding. Plaintext is
 * returned exactly once (create/rotate); rows store only the argon2id hash.
 * Revocation sets revoked_at — keys are never hard-deleted (audit trail).
 * Role checks happen in the route handlers via requireWrite().
 */

export interface ApiKeyView {
  id: string;
  name: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyView {
  /** Shown once, never stored. */
  plaintext: string;
}

function toView(row: {
  id: string;
  name: string;
  last4: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    last4: row.last4,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listApiKeys(
  db: VyayaDatabase,
  session: SessionPayload,
): Promise<ApiKeyView[]> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.workspaceId, session.workspaceId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows.map(toView);
  });
}

export async function createApiKey(
  db: VyayaDatabase,
  session: SessionPayload,
  name: string,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const keyHash = await hashApiKey(generated.plaintext);
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .insert(schema.apiKeys)
      .values({
        workspaceId: session.workspaceId,
        createdByUserId: session.userId,
        name,
        keyPrefix: generated.prefix,
        keyHash,
        last4: generated.last4,
      })
      .returning();
    const row = rows[0]!;
    return { ...toView(row), plaintext: generated.plaintext };
  });
}

export async function revokeApiKey(
  db: VyayaDatabase,
  session: SessionPayload,
  keyId: string,
): Promise<ApiKeyView> {
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const rows = await tx
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, keyId),
          eq(schema.apiKeys.workspaceId, session.workspaceId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw notFound("key not found or already revoked");
    return toView(row);
  });
}

/**
 * Rotation: revoke the old key and issue a fresh one with the same name in
 * a single transaction. The new plaintext is returned once.
 */
export async function rotateApiKey(
  db: VyayaDatabase,
  session: SessionPayload,
  keyId: string,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const keyHash = await hashApiKey(generated.plaintext);
  return withWorkspace(db, session.workspaceId, async (tx) => {
    const old = await tx
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, keyId),
          eq(schema.apiKeys.workspaceId, session.workspaceId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning();
    const oldRow = old[0];
    if (!oldRow) throw notFound("key not found or already revoked");
    const rows = await tx
      .insert(schema.apiKeys)
      .values({
        workspaceId: session.workspaceId,
        createdByUserId: session.userId,
        name: oldRow.name,
        keyPrefix: generated.prefix,
        keyHash,
        last4: generated.last4,
      })
      .returning();
    const row = rows[0]!;
    return { ...toView(row), plaintext: generated.plaintext };
  });
}
