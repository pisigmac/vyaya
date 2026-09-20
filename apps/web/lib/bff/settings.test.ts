import { describe, expect, it } from "vitest";
import { getWorkspaceSettings, updateWorkspaceSettings } from "./settings";
import type { SessionPayload } from "../session";

type Rows = Record<string, Record<string, unknown>[]>;

function fakeDb() {
  const rows: Rows = {
    workspaces: [
      {
        id: "ws-1",
        name: "Acme",
        slug: "acme",
        logBodiesEnabled: false,
        wrappedDek: null,
      },
    ],
  };
  const db = {
    select() {
      return {
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(rows["workspaces"]!.slice(0, 1)) }),
        }),
      };
    },
    update() {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: () => {
              const row = rows["workspaces"]![0]!;
              Object.assign(row, patch);
              return { returning: () => Promise.resolve([row]) };
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

describe("bff/settings", () => {
  it("reads workspace settings", async () => {
    const { db } = fakeDb();
    const settings = await getWorkspaceSettings(db as never, SESSION);
    expect(settings.name).toBe("Acme");
    expect(settings.logBodiesEnabled).toBe(false);
  });

  it("opting into body logging generates a wrapped DEK", async () => {
    const { db, rows } = fakeDb();
    const updated = await updateWorkspaceSettings(
      db as never,
      SESSION,
      { name: "Acme", logBodiesEnabled: true },
      { masterKeyHex: "ab".repeat(32) },
    );
    expect(updated.logBodiesEnabled).toBe(true);
    const row = rows["workspaces"]![0]!;
    expect(row["wrappedDek"]).toBeTruthy();
    const wrapped = row["wrappedDek"] as { ciphertext: string };
    expect(wrapped.ciphertext.length).toBeGreaterThan(0);
  });

  it("opting out clears the DEK", async () => {
    const { db, rows } = fakeDb();
    await updateWorkspaceSettings(
      db as never,
      SESSION,
      { name: "Acme", logBodiesEnabled: true },
      { masterKeyHex: "ab".repeat(32) },
    );
    const updated = await updateWorkspaceSettings(
      db as never,
      SESSION,
      { name: "Acme", logBodiesEnabled: false },
      { masterKeyHex: "ab".repeat(32) },
    );
    expect(updated.logBodiesEnabled).toBe(false);
    expect(rows["workspaces"]![0]!["wrappedDek"]).toBeNull();
  });
});
