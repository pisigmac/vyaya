import { serve, type ServerType } from "@hono/node-server";
import { schema } from "@vyaya/db";
import { createApp } from "@vyaya/mock-deskid/app";
import { generateSigningKey } from "@vyaya/mock-deskid/keys";
import { MockDeskIdStore } from "@vyaya/mock-deskid/store";
import { getFreePort } from "@vyaya/db/test-support/embedded-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDeskIdReconcile } from "./deskid-reconcile.js";
import { setupBareDb, silentLogger, type SeededDb } from "../test-utils.js";

/**
 * deskid-reconcile job, integration-tested against the real mock-deskid
 * HTTP server: grant/user events flow into user_grants_cache and the
 * reconciliation cursor advances exactly once per event.
 */

const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";

describe("deskid-reconcile", () => {
  let seeded: SeededDb;
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    seeded = await setupBareDb();
    const app = createApp({
      issuer: "http://mock-deskid.test",
      spaCallbackUrl: "http://localhost:3000/auth/callback",
      tokenTtlSec: 3600,
      keyring: { keyring: { current: generateSigningKey(), previous: null }, keysDir: null },
      store: new MockDeskIdStore(),
    });
    const port = await getFreePort();
    server = serve({ fetch: app.fetch, port });
    baseUrl = `http://127.0.0.1:${port}`;

    // user.created for USER_1 (dev token mint calls ensureUser), then two
    // grants across two users.
    const tokenRes = await fetch(`${baseUrl}/v1/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: USER_1, email: "one@example.com" }),
    });
    expect(tokenRes.status).toBe(200);
    const grant = async (userId: string, role: string) => {
      const res = await fetch(`${baseUrl}/v1/admin/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: userId, audience: "vyaya", role }),
      });
      expect(res.status).toBe(201);
    };
    await grant(USER_1, "admin");
    await grant(USER_2, "viewer"); // grant arrives before any user.created
  }, 180_000);

  afterAll(async () => {
    server?.close();
    await seeded?.close();
  });

  function deps(overrides: Partial<Parameters<typeof runDeskIdReconcile>[0]> = {}) {
    return {
      db: seeded.db,
      enabled: true,
      baseUrl,
      adminToken: undefined,
      logger: silentLogger,
      ...overrides,
    };
  }

  it("is a no-op when DESKID_RECONCILE_ENABLED is off", async () => {
    const result = await runDeskIdReconcile(deps({ enabled: false }));
    expect(result.outcome).toBe("disabled");
    expect(result.eventsApplied).toBe(0);
  });

  it("applies user + grant events to the cache and advances the cursor", async () => {
    const result = await runDeskIdReconcile(deps());
    expect(result.outcome).toBe("applied");
    expect(result.eventsApplied).toBe(3);
    expect(result.cursor).toBe(3);

    const rows = await seeded.db.db.select().from(schema.userGrantsCache);
    expect(rows).toHaveLength(2);
    const byUser = new Map(rows.map((r) => [r.deskidSub, r]));
    expect(byUser.get(USER_1)?.role).toBe("admin");
    expect(byUser.get(USER_1)?.email).toBe("one@example.com");
    expect(byUser.get(USER_1)?.audience).toBe("vyaya");
    expect(byUser.get(USER_2)?.role).toBe("viewer");
    // USER_2's grant preceded any user.created: no email yet.
    expect(byUser.get(USER_2)?.email).toBeNull();
  });

  it("is idempotent: a second poll applies nothing and keeps the cursor", async () => {
    const result = await runDeskIdReconcile(deps());
    expect(result.eventsApplied).toBe(0);
    expect(result.cursor).toBe(3);
    const rows = await seeded.db.db.select().from(schema.userGrantsCache);
    expect(rows).toHaveLength(2);
  });

  it("picks up new events since the cursor (role change + late email)", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: USER_2, audience: "vyaya", role: "operator" }),
    });
    expect(res.status).toBe(201);
    const tokenRes = await fetch(`${baseUrl}/v1/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: USER_2, email: "two@example.com" }),
    });
    expect(tokenRes.status).toBe(200);

    const result = await runDeskIdReconcile(deps());
    expect(result.eventsApplied).toBe(1); // only the new grant (ensureUser is a no-op for known users)
    expect(result.cursor).toBe(4);

    const rows = await seeded.db.db.select().from(schema.userGrantsCache);
    const user2 = rows.find((r) => r.deskidSub === USER_2);
    expect(user2?.role).toBe("operator");
  });

  it("sends the admin token when configured", async () => {
    let seenAuth: string | null = null;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return fetch(String(url), init);
    }) as typeof fetch;
    const result = await runDeskIdReconcile(deps({ adminToken: "adm_test", fetchFn }));
    expect(result.outcome).toBe("applied");
    expect(seenAuth).toBe("Bearer adm_test");
  });

  it("throws when the feed is not 2xx", async () => {
    const fetchFn = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(runDeskIdReconcile(deps({ fetchFn }))).rejects.toThrow("503");
  });
});
