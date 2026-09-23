import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings,
} from "./settings";
import {
  makeSession,
  SEED_WORKSPACE_A,
  startSeededDb,
  stopDb,
  type DbFixture,
} from "../../tests/helpers";

let fixture: DbFixture;
const admin = makeSession(SEED_WORKSPACE_A, "admin");

beforeAll(async () => {
  fixture = await startSeededDb();
}, 240_000);

afterAll(async () => {
  await stopDb(fixture);
});

describe("workspace settings", () => {
  it("reads seeded settings", async () => {
    const settings = await getWorkspaceSettings(fixture.handle.db, admin);
    expect(settings.name).toBe("Acme Support");
    expect(settings.logBodiesEnabled).toBe(true); // workspace A opts in
    expect(settings.featureTags.sort()).toEqual(
      ["code-review", "docs-qa", "support-bot"].sort(),
    );
  });

  it("toggles body logging and sets/clears the report email", async () => {
    let s = await updateWorkspaceSettings(fixture.handle.db, admin, {
      logBodiesEnabled: false,
      reportEmail: "reports@acme.example",
    });
    expect(s.logBodiesEnabled).toBe(false);
    expect(s.reportEmail).toBe("reports@acme.example");

    s = await updateWorkspaceSettings(fixture.handle.db, admin, {
      reportEmail: "",
    });
    expect(s.reportEmail).toBeNull();
  });

  it("replaces the feature-tag allowlist wholesale", async () => {
    const s = await updateWorkspaceSettings(fixture.handle.db, admin, {
      featureTags: ["alpha", "beta"],
    });
    expect(s.featureTags).toEqual(["alpha", "beta"]);

    const cleared = await updateWorkspaceSettings(fixture.handle.db, admin, {
      featureTags: [],
    });
    expect(cleared.featureTags).toEqual([]);
  });
});
