import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyApiKey } from "@vyaya/db/api-keys";
import { HttpError, requireWrite } from "../errors";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "./keys";
import {
  makeSession,
  SEED_WORKSPACE_A,
  SEED_WORKSPACE_B,
  startSeededDb,
  stopDb,
  type DbFixture,
} from "../../tests/helpers";

let fixture: DbFixture;
const admin = makeSession(SEED_WORKSPACE_A, "admin");
const viewer = makeSession(SEED_WORKSPACE_A, "viewer");

beforeAll(async () => {
  fixture = await startSeededDb();
}, 240_000);

afterAll(async () => {
  await stopDb(fixture);
});

describe("api keys", () => {
  it("creates a key: plaintext once, argon2id hash at rest, last4 listed", async () => {
    const created = await createApiKey(fixture.handle.db, admin, "ci-bot");
    expect(created.plaintext).toMatch(/^vy_live_[0-9a-f]{64}$/);
    expect(created.last4).toBe(created.plaintext.slice(-4));

    const rows = await fixture.handle.client`
      SELECT key_hash, last4 FROM api_keys WHERE id = ${created.id}
    `;
    expect(rows[0]?.key_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.key_hash).not.toContain(created.plaintext);
    expect(await verifyApiKey(rows[0]!.key_hash, created.plaintext)).toBe(true);

    const listed = await listApiKeys(fixture.handle.db, admin);
    const found = listed.find((k) => k.id === created.id);
    expect(found?.name).toBe("ci-bot");
    expect(found?.revokedAt).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
  });

  it("revokes a key (soft delete, audit row stays)", async () => {
    const created = await createApiKey(fixture.handle.db, admin, "to-revoke");
    const revoked = await revokeApiKey(fixture.handle.db, admin, created.id);
    expect(revoked.revokedAt).not.toBeNull();
    // Second revoke is a 404, not a silent no-op.
    await expect(
      revokeApiKey(fixture.handle.db, admin, created.id),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("rotates: old key revoked, new plaintext verifies, name preserved", async () => {
    const created = await createApiKey(fixture.handle.db, admin, "rotating");
    const rotated = await rotateApiKey(fixture.handle.db, admin, created.id);
    expect(rotated.id).not.toBe(created.id);
    expect(rotated.name).toBe("rotating");
    expect(rotated.plaintext).toMatch(/^vy_live_[0-9a-f]{64}$/);
    expect(rotated.last4).not.toBe(created.last4);

    const rows = await fixture.handle.client`
      SELECT key_hash, revoked_at FROM api_keys WHERE id IN (${created.id}, ${rotated.id})
      ORDER BY created_at
    `;
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.revoked_at !== null);
    const newRow = rows.find((r) => r.revoked_at === null);
    expect(oldRow).toBeDefined();
    expect(newRow).toBeDefined();
    expect(await verifyApiKey(newRow!.key_hash, rotated.plaintext)).toBe(true);
  });

  it("cannot touch another workspace's keys (RLS + explicit filter)", async () => {
    const foreign = makeSession(SEED_WORKSPACE_B, "admin");
    const created = await createApiKey(fixture.handle.db, admin, "mine");
    await expect(
      revokeApiKey(fixture.handle.db, foreign, created.id),
    ).rejects.toBeInstanceOf(HttpError);
    const listed = await listApiKeys(fixture.handle.db, foreign);
    expect(listed.find((k) => k.id === created.id)).toBeUndefined();
  });
});

describe("RBAC", () => {
  it("viewer cannot write (the guard every mutating route calls)", () => {
    expect(() => requireWrite(viewer)).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => requireWrite(makeSession(SEED_WORKSPACE_A, "operator"))).not.toThrow();
    expect(() => requireWrite(admin)).not.toThrow();
  });
});
