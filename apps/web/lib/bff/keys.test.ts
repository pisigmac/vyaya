import { describe, expect, it } from "vitest";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "./keys";
import type { SessionPayload } from "../session";

type Rows = Record<string, Record<string, unknown>[]>;

function fakeDb() {
  const rows: Rows = { apiKeys: [], workspaces: [] };
  const db = {
    insert(table: { _: string }) {
      return {
        values(value: Record<string, unknown>) {
          rows[table._]!.push(value);
          return Promise.resolve();
        },
      };
    },
    select() {
      return {
        from: (table: { _: string }) => ({
          where: () => Promise.resolve(rows[table._]!),
          orderBy: () => Promise.resolve(rows[table._]!),
        }),
      };
    },
    update(table: { _: string }) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: () => {
              const row = rows[table._]![0];
              if (row) Object.assign(row, patch);
              return {
                returning: () => Promise.resolve(row ? [row] : []),
              };
            },
          };
        },
      };
    },
  };
  return { db, rows };
}

const SESSION: SessionPayload = {
  sub: "user-1",
  email: "dev@vyaya.local",
  role: "admin",
  workspaceId: "ws-1",
  tokenVersion: 1,
};

describe("bff/keys", () => {
  it("createApiKey returns plaintext once and stores only the hash", async () => {
    const { db, rows } = fakeDb();
    const created = await createApiKey(db as never, SESSION, "prod");
    expect(created.plaintext).toMatch(/^vy_live_[0-9a-f]{64}$/);
    const stored = rows["apiKeys"]![0]!;
    expect(stored["keyHash"]).not.toContain(created.plaintext);
    expect(String(stored["keyHash"])).toContain("$argon2id$");
    expect(created.key.last4).toBe(created.plaintext.slice(-4));
    expect(created.key.name).toBe("prod");
  });

  it("listApiKeys returns summaries without hashes", async () => {
    const { db } = fakeDb();
    await createApiKey(db as never, SESSION, "a");
    await createApiKey(db as never, SESSION, "b");
    const keys = await listApiKeys(db as never, SESSION);
    expect(keys).toHaveLength(2);
    expect(JSON.stringify(keys)).not.toContain("argon2");
  });

  it("revokeApiKey stamps revokedAt; rotateApiKey replaces the key", async () => {
    const { db } = fakeDb();
    const created = await createApiKey(db as never, SESSION, "main");
    const revoked = await revokeApiKey(db as never, SESSION, created.key.id);
    expect(revoked.revokedAt).toBeTruthy();

    const fresh = await createApiKey(db as never, SESSION, "rotatable");
    const rotated = await rotateApiKey(db as never, SESSION, fresh.key.id);
    expect(rotated.plaintext).toMatch(/^vy_live_/);
    expect(rotated.rotatedFromId).toBe(fresh.key.id);
    expect(rotated.key.id).not.toBe(fresh.key.id);
  });
});
