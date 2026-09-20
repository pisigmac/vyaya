#!/usr/bin/env bash
# Vyaya e2e — docker variant. Boots the full stack with docker compose
# (mock profiles: mock-openai is in the default set; mock-deskid via the
# COMPOSE_PROFILES hint), waits for healthy, migrates + seeds from the host,
# then runs the same assertion sequence as scripts/e2e-local.sh.
#
# Prereqs: docker + docker compose v2, pnpm install (host, for migrate/seed),
# curl, python3, node >= 22.12.
#
# Usage: scripts/e2e.sh [--keep]   (--keep leaves containers running)

set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vyaya-e2e-docker.XXXXXX")
E2E_LOG="$RUN_DIR/e2e.log"
export E2E_LOG ROOT RUN_DIR
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

# migrate/seed run from the host via the workspace CLIs.
if [ ! -f packages/db/dist/migrate.js ]; then
  echo "== pnpm install + build (host tooling for migrate/seed) =="
  pnpm install && pnpm -r build || { echo "FATAL: host build failed"; exit 1; }
fi

export COMPOSE_PROFILES=mock-deskid
COMPOSE=(docker compose --env-file .env)

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "--keep set: leaving the stack running (docker compose down to stop)"
  else
    echo "-- cleanup: docker compose down"
    "${COMPOSE[@]}" down >>"$E2E_LOG" 2>&1 || true
  fi
  echo "logs kept at $RUN_DIR"
}
trap cleanup EXIT

echo "== docker compose build =="
"${COMPOSE[@]}" build >>"$E2E_LOG" 2>&1 || { echo "FATAL: compose build failed (see $E2E_LOG)"; exit 1; }

echo "== docker compose up =="
"${COMPOSE[@]}" up -d >>"$E2E_LOG" 2>&1 || { echo "FATAL: compose up failed (see $E2E_LOG)"; exit 1; }

# ------------------------------------------------------- wait for healthy
HEALTHY_SERVICES="postgres redis mock-openai mock-deskid proxy worker web"
echo "== waiting for healthy: $HEALTHY_SERVICES =="
deadline=$((SECONDS + 300))
while :; do
  pending=0
  for svc in $HEALTHY_SERVICES; do
    status=$("${COMPOSE[@]}" ps --format '{{.Health}}' "$svc" 2>/dev/null || echo "missing")
    [ "$status" = "healthy" ] || pending=$((pending + 1))
  done
  [ "$pending" -eq 0 ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FATAL: services did not become healthy in 300s"
    "${COMPOSE[@]}" ps
    exit 1
  fi
  sleep 3
done
echo "all services healthy"

# -------------------------------------------------------- migrate + seed
# Run from the host against the mapped postgres port (pnpm workspace CLIs).
export DATABASE_URL="postgres://vyaya:vyaya@127.0.0.1:${POSTGRES_PORT:-5432}/vyaya"
echo "== database migrations =="
pnpm --filter @vyaya/db migrate >>"$E2E_LOG" 2>&1 || { echo "FATAL: migrations failed"; tail -20 "$E2E_LOG"; exit 1; }
echo "== seed =="
pnpm --filter @vyaya/db seed | tee -a "$E2E_LOG" || { echo "FATAL: seed failed"; exit 1; }

# ------------------------------------------------------------- assertions
export MOCK_DESKID_URL="http://127.0.0.1:8091"
export WEB_URL="http://127.0.0.1:3000"
export PROXY_URL="http://127.0.0.1:8787"
# The worker container runs the scheduler; exec a one-shot classify inside it.
export CLASSIFY_ONCE="${COMPOSE[*]} exec -T worker node dist/index.js --job classify --once"

# shellcheck source=e2e-lib.sh
source "$ROOT/scripts/e2e-lib.sh"
run_e2e_assertions
E2E_RC=$?

echo
if [ "$E2E_RC" -eq 0 ]; then
  echo "E2E (docker): PASS"
else
  echo "E2E (docker): FAIL — inspect $E2E_LOG"
  tail -40 "$E2E_LOG"
fi
exit "$E2E_RC"
