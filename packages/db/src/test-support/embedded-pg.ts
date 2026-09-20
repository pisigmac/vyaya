import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Shared harness for @vyaya/db integration tests: a real, user-space
 * Postgres 16 via embedded-postgres (initdb as the current user — no
 * docker, no sudo).
 *
 * The shipped zonky linux-x64 binaries link libicuuc.so.60 (Ubuntu 18.04
 * era). Hosts with a different ICU (e.g. Debian 12 ships ICU 72) get the
 * libraries under test-support/icu60 prepended to LD_LIBRARY_PATH. Those
 * libraries are NOT committed to git — they are fetched on demand by
 * test-support/icu60/fetch.mjs (checksum-pinned, see the README there),
 * which this harness invokes automatically when they are missing.
 * Hosts that already resolve libicuuc.so.60 are left untouched.
 */

const ICU60_DIR = fileURLToPath(new URL("../../test-support/icu60", import.meta.url));
const ICU60_LIBS = ["libicudata.so.60", "libicui18n.so.60", "libicuuc.so.60"];

function icu60Resolvable(): boolean {
  try {
    const out = execFileSync("ldconfig", ["-p"], { encoding: "utf8" });
    return out.includes("libicuuc.so.60");
  } catch {
    return false;
  }
}

function icu60LibsPresent(): boolean {
  return ICU60_LIBS.every((lib) => existsSync(join(ICU60_DIR, lib)));
}

function ensureIcu60Libs(): void {
  if (icu60LibsPresent()) return;
  // Downloads the Ubuntu libicu60 deb and verifies pinned sha256 checksums.
  execFileSync(process.execPath, [join(ICU60_DIR, "fetch.mjs")], {
    stdio: "inherit",
  });
}

export function ensureIcuLibraryPath(): void {
  if (icu60Resolvable()) return;
  ensureIcu60Libs();
  const existing = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = existing
    ? `${ICU60_DIR}:${existing}`
    : ICU60_DIR;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface EmbeddedPg {
  /** postgres:// URL for the freshly created `vyaya` database. */
  url: string;
  port: number;
  pg: EmbeddedPostgres;
  stop(): Promise<void>;
}

/**
 * initdb + start a throwaway cluster with user/password vyaya and a `vyaya`
 * database. Data lives in a temp dir and is removed on stop (persistent:
 * false).
 */
export async function startEmbeddedPostgres(): Promise<EmbeddedPg> {
  ensureIcuLibraryPath();
  const dir = mkdtempSync(join(tmpdir(), "vyaya-pgtest-"));
  const port = await getFreePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "vyaya",
    password: "vyaya",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vyaya");
  return {
    url: `postgres://vyaya:vyaya@127.0.0.1:${port}/vyaya`,
    port,
    pg,
    async stop() {
      await pg.stop();
    },
  };
}
