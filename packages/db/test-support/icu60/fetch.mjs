#!/usr/bin/env node
/**
 * fetch.mjs — download the ICU 60 shared libraries needed by the zonky
 * Postgres 16 binaries that embedded-postgres ships (see README.md).
 *
 * Fetches libicu60_60.2-3ubuntu3.2_amd64.deb from the Ubuntu 18.04 security
 * pocket, verifies the .deb sha256, extracts the three library payloads, and
 * verifies each extracted library against its pinned sha256. Idempotent:
 * libraries already present with a matching checksum are kept as-is.
 *
 * Requirements: node >= 22, curl, ar, tar (all present on any dev box that
 * can run the e2e scripts). Usage:
 *
 *   node packages/db/test-support/icu60/fetch.mjs
 *
 * The test harness (src/test-support/embedded-pg.ts) invokes this
 * automatically when the libraries are missing; running it by hand is only
 * needed to pre-populate the directory.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const DEB_URL =
  "https://security.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_amd64.deb";
const DEB_SHA256 = "f01f61f57e63dc905e02e6441d10370fe0c79e43e70e6f5fe24b342fd2633209";

/** Pinned sha256 of each extracted library payload (soname -> hash). */
const LIBS = {
  "libicudata.so.60": "e03e645c9a71a5c173b356f1183e38f70001d417597f3459851a1c1d3c38bd5e",
  "libicui18n.so.60": "0e0e144ee7e0251725cb736e600b05ba16cff8fd7e63b6b18fe0a3d57b09de7f",
  "libicuuc.so.60": "608238deca39ccd769b87b6835d353c017dc5f01a79c7e8bb753000bb8c08a9a",
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function okOnDisk(name) {
  const path = join(HERE, name);
  return existsSync(path) && sha256(readFileSync(path)) === LIBS[name];
}

function main() {
  const missing = Object.keys(LIBS).filter((name) => !okOnDisk(name));
  if (missing.length === 0) {
    console.log("icu60: all libraries present and checksums match");
    return;
  }
  console.log(`icu60: fetching ${missing.length} missing/mismatched libraries`);
  console.log(`icu60: ${DEB_URL}`);

  const work = mkdtempSync(join(tmpdir(), "vyaya-icu60-"));
  try {
    const deb = join(work, "libicu60.deb");
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", deb, DEB_URL], {
      stdio: "inherit",
    });
    const debHash = sha256(readFileSync(deb));
    if (debHash !== DEB_SHA256) {
      throw new Error(
        `deb sha256 mismatch: got ${debHash}, want ${DEB_SHA256} — refusing to extract`,
      );
    }

    execFileSync("ar", ["x", deb, "data.tar.xz"], { cwd: work });
    execFileSync(
      "tar",
      [
        "-xf",
        join(work, "data.tar.xz"),
        "-C",
        work,
        ...missing.map((name) => `./usr/lib/x86_64-linux-gnu/${name}.2`),
      ],
    );

    for (const name of missing) {
      const extracted = join(work, "usr/lib/x86_64-linux-gnu", `${name}.2`);
      const buf = readFileSync(extracted);
      const hash = sha256(buf);
      if (hash !== LIBS[name]) {
        throw new Error(`${name} sha256 mismatch: got ${hash}, want ${LIBS[name]}`);
      }
      // Write-then-rename so a killed run never leaves a partial library.
      const target = join(HERE, name);
      writeFileSync(`${target}.tmp`, buf, { mode: 0o755 });
      renameSync(`${target}.tmp`, target);
      console.log(`icu60: ${name} OK (${hash.slice(0, 12)}…)`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
