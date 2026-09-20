#!/usr/bin/env bash
# Vyaya e2e — DOCKERLESS variant. Runs the whole stack on the host:
# user-space Postgres 16 (embedded-postgres, via scripts/dev-pg.mjs), Redis 7
# built from source, and the apps as plain node processes from built dist.
# Same assertion sequence as scripts/e2e.sh (docker variant).
#
# Prereqs: pnpm install; node >= 22.12; curl; python3; gcc+make (only when
# the Redis binary must be built). No docker, no sudo.
#
# Usage: scripts/e2e-local.sh
# Env overrides: REDIS_SERVER_BIN, E2E_VENDOR_DIR, SKIP_BUILD=1.

set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vyaya-e2e.XXXXXX")
E2E_LOG="$RUN_DIR/e2e.log"
export E2E_LOG
mkdir -p "$RUN_DIR/logs"
echo "run dir: $RUN_DIR"
echo "full log: $E2E_LOG"

# ---------------------------------------------------------------- cleanup
declare -a E2E_PIDS=()
PG_PID=""
cleanup() {
  echo "-- cleanup: stopping services"
  for pid in "${E2E_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  [ -n "$PG_PID" ] && kill -TERM "$PG_PID" 2>/dev/null || true
  [ -f "$RUN_DIR/redis.pid" ] && kill "$(cat "$RUN_DIR/redis.pid")" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "logs kept at $RUN_DIR"
}
trap cleanup EXIT

start_bg() { # start_bg <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  "$@" >"$log" 2>&1 &
  local pid=$!
  E2E_PIDS+=("$pid")
  echo "started $name (pid $pid, log $log)"
}

# ------------------------------------------------------------------ build
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== pnpm -r build =="
  pnpm -r build >>"$E2E_LOG" 2>&1 || { echo "FATAL: build failed (see $E2E_LOG)"; exit 1; }
fi
# Standalone web output needs its static assets copied in (mirrors the
# Dockerfile).
if [ -d apps/web/.next/standalone ]; then
  mkdir -p apps/web/.next/standalone/apps/web/.next
  rm -rf apps/web/.next/standalone/apps/web/.next/static
  cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
else
  echo "FATAL: apps/web/.next/standalone missing — run pnpm -r build"; exit 1
fi

# ------------------------------------------------------------------ redis
REDIS_SERVER_BIN=${REDIS_SERVER_BIN:-"${E2E_VENDOR_DIR:-$HOME/vendor}/redis-7.4.5/src/redis-server"}
if [ ! -x "$REDIS_SERVER_BIN" ]; then
  echo "== building Redis 7.4.5 from source (one-time) =="
  VENDOR="${E2E_VENDOR_DIR:-$HOME/vendor}"
  mkdir -p "$VENDOR"
  curl -fsSL -o "$VENDOR/redis-7.4.5.tar.gz" https://download.redis.io/releases/redis-7.4.5.tar.gz \
    && tar xzf "$VENDOR/redis-7.4.5.tar.gz" -C "$VENDOR" \
    && make -C "$VENDOR/redis-7.4.5" -j4 >>"$E2E_LOG" 2>&1 \
    || { echo "FATAL: redis build failed (see $E2E_LOG)"; exit 1; }
fi
"$REDIS_SERVER_BIN" --version | head -1

REDIS_PORT=16379
"$REDIS_SERVER_BIN" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$RUN_DIR" \
  --save '' --appendonly no --daemonize yes --pidfile "$RUN_DIR/redis.pid" \
  --logfile "$RUN_DIR/logs/redis.log"
REDIS_CLI="$(dirname "$REDIS_SERVER_BIN")/redis-cli"
REDIS_READY=0
for _ in $(seq 1 40); do
  [ "$("$REDIS_CLI" -p "$REDIS_PORT" ping 2>/dev/null)" = "PONG" ] && REDIS_READY=1 && break
  sleep 0.5
done
[ "$REDIS_READY" = "1" ] || { echo "FATAL: redis did not answer PING"; cat "$RUN_DIR/logs/redis.log"; exit 1; }
echo "ready: redis (127.0.0.1:$REDIS_PORT)"

# --------------------------------------------------------------- postgres
node scripts/dev-pg.mjs "$RUN_DIR/pg.json" >"$RUN_DIR/logs/postgres.log" 2>&1 &
PG_PID=$!
for _ in $(seq 1 120); do [ -s "$RUN_DIR/pg.json" ] && break; sleep 0.5; done
[ -s "$RUN_DIR/pg.json" ] || { echo "FATAL: embedded postgres did not start"; cat "$RUN_DIR/logs/postgres.log"; exit 1; }
DATABASE_URL=$(python3 -c "import json; print(json.load(open('$RUN_DIR/pg.json'))['url'])")
export DATABASE_URL
echo "ready: postgres ($DATABASE_URL)"

# ------------------------------------------------------------------- env
export NODE_ENV=development
export LOG_LEVEL=warn
export AUTH_MODE=dev
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export DESKID_ISSUER="http://127.0.0.1:8091"
export DESKID_JWKS_URL="http://127.0.0.1:8091/.well-known/jwks.json"
export DESKID_BASE_URL="http://127.0.0.1:8091"
export AUTH_SPA_CALLBACK_URL="http://127.0.0.1:3000/auth/callback"
export SESSION_COOKIE_SECRET="e2e-local-session-secret-0123456789abcdef"
export MASTER_ENCRYPTION_KEY="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
export OPENAI_BASE_URL="http://127.0.0.1:8788"
export PROXY_BASE_URL="http://127.0.0.1:8787"
export MOCK_DESKID_KEYS_DIR="$RUN_DIR/mock-deskid-keys"
export REPORT_OUTPUT_DIR="$RUN_DIR/reports"
export WORKER_CLI_PATH="$ROOT/apps/worker/dist/index.js"
export MOCK_OPENAI_LATENCY_MS=5

export MOCK_DESKID_URL="http://127.0.0.1:8091"
export WEB_URL="http://127.0.0.1:3000"
export PROXY_URL="http://127.0.0.1:8787"

# -------------------------------------------------------- migrate + seed
echo "== database migrations =="
node packages/db/dist/migrate.js >>"$E2E_LOG" 2>&1 || { echo "FATAL: migrations failed"; tail -20 "$E2E_LOG"; exit 1; }
echo "migrations applied"

echo "== seed =="
node packages/db/dist/seed.js | tee -a "$E2E_LOG" || { echo "FATAL: seed failed"; exit 1; }

# ------------------------------------------------------------- start apps
start_bg mock-openai "$RUN_DIR/logs/mock-openai.log" node apps/mock-openai/dist/index.js
start_bg mock-deskid "$RUN_DIR/logs/mock-deskid.log" node apps/mock-deskid/dist/index.js
start_bg proxy "$RUN_DIR/logs/proxy.log" node apps/proxy/dist/index.js
start_bg web "$RUN_DIR/logs/web.log" \
  env PORT=3000 HOSTNAME=127.0.0.1 NODE_ENV=production \
  node apps/web/.next/standalone/apps/web/server.js

# shellcheck source=e2e-lib.sh
source "$ROOT/scripts/e2e-lib.sh"

wait_for_http mock-openai "http://127.0.0.1:8788/healthz" 30
wait_for_http mock-deskid "$MOCK_DESKID_URL/healthz" 30
wait_for_http proxy "$PROXY_URL/healthz" 30
wait_for_http web "$WEB_URL/login" 60

export CLASSIFY_ONCE="node '$ROOT/apps/worker/dist/index.js' --job classify --once"

run_e2e_assertions
E2E_RC=$?

echo
if [ "$E2E_RC" -eq 0 ]; then
  echo "E2E-LOCAL: PASS"
else
  echo "E2E-LOCAL: FAIL — inspect $E2E_LOG and $RUN_DIR/logs/"
  tail -40 "$E2E_LOG"
fi
exit "$E2E_RC"
