# test-support/icu60

ICU 60 shared libraries required by the zonky Postgres 16 binaries that
`embedded-postgres` ships (those binaries are built against Ubuntu 18.04's
`libicu60`; this build sandbox runs Debian 12 with ICU 72, whose
`libicuuc.so.72` cannot satisfy the `libicuuc.so.60` SONAME).

**The libraries are NOT committed to git** (binaries don't belong in the
repo). They are fetched on demand:

- Automatically: `src/test-support/embedded-pg.ts` runs `fetch.mjs` before
  spawning initdb/postgres whenever the libraries are missing (and the host
  can't already resolve `libicuuc.so.60`).
- Manually: `node packages/db/test-support/icu60/fetch.mjs`.

Source: `libicu60_60.2-3ubuntu3.2_amd64.deb` from the Ubuntu 18.04 security
pocket,
`https://security.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_amd64.deb`.
Only the three libraries the Postgres binaries actually link are kept:
`libicudata.so.60`, `libicui18n.so.60`, `libicuuc.so.60`.

Integrity: `fetch.mjs` pins and verifies the sha256 of the downloaded .deb
(`f01f61f57e63dc905e02e6441d10370fe0c79e43e70e6f5fe24b342fd2633209`) and of
each extracted library (see the `LIBS` table in `fetch.mjs`). A mismatch
aborts the fetch — nothing partial or untrusted is written. Requires
`curl`, `ar`, and `tar`.

`src/test-support/embedded-pg.ts` prepends this directory to
`LD_LIBRARY_PATH` before spawning initdb/postgres, but only when
`libicuuc.so.60` is not already resolvable on the host — on machines that
ship ICU 60 (or zonky-compatible binaries) the tests use the system libs
and no fetch happens.

These libraries are used ONLY for local test clusters. Production and dev
compose databases run the official Postgres 16 image, not these binaries.
