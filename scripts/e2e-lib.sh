# shellcheck shell=bash
# Shared assertion sequence for the Vyaya e2e scripts (scripts/e2e.sh and
# scripts/e2e-local.sh). Sourced, not executed. Expects these variables:
#
#   ROOT             repo root
#   RUN_DIR          scratch dir for jars/bodies (writable)
#   DATABASE_URL     postgres URL used for direct DB assertions
#   MOCK_DESKID_URL  e.g. http://127.0.0.1:8091
#   WEB_URL          e.g. http://127.0.0.1:3000
#   PROXY_URL        e.g. http://127.0.0.1:8787
#   CLASSIFY_ONCE    command string that runs the classifier once and exits
#
# The round trip: log in as the seeded Acme admin through mock-deskid
# (signup-equivalent: real RS256 token, real callback + provisioning lookup),
# create an API key through the web BFF, send a chat completion through the
# proxy, assert request_log, run the classifier, assert waste_event, then
# assert the dashboard stats API reflects it.

SEED_USER_A_SUB="00000000-0000-4000-a000-0000000000a1"
SEED_USER_A_EMAIL="admin@acme.example"

E2E_PASS=0
E2E_FAIL=0

e2e_pass() { E2E_PASS=$((E2E_PASS + 1)); echo "PASS: $1"; }
e2e_fail() { E2E_FAIL=$((E2E_FAIL + 1)); echo "FAIL: $1"; }

# check <description> <command...> — records PASS/FAIL, never aborts.
check() {
  local desc="$1"; shift
  if "$@" >>"$E2E_LOG" 2>&1; then
    e2e_pass "$desc"
    return 0
  else
    e2e_fail "$desc — command: $*"
    return 1
  fi
}

json_get() { # json_get <field> — reads JSON on stdin
  python3 -c "import json,sys; v=json.load(sys.stdin); print(v$1)"
}

# wait_for_http <name> <url> <timeout-sec> — hard failure exits the script.
wait_for_http() {
  local name="$1" url="$2" timeout="${3:-60}" waited=0
  while ! curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if [ "$waited" -ge "$timeout" ]; then
      echo "FATAL: $name did not become ready at $url within ${timeout}s" >&2
      exit 1
    fi
  done
  echo "ready: $name ($url)"
}

# poll_query_ge <desc> <sql> <min> <timeout-sec>
poll_query_ge() {
  local desc="$1" sql="$2" min="$3" timeout="${4:-30}" waited=0 got=0
  while [ "$waited" -lt "$timeout" ]; do
    got=$(node "$ROOT/scripts/e2e-sql.mjs" "$DATABASE_URL" "$sql" --json \
      | python3 -c "import json,sys; rows=json.load(sys.stdin); print(list(rows[0].values())[0] if rows else 0)" 2>>"$E2E_LOG" || echo 0)
    if [ "$got" -ge "$min" ] 2>/dev/null; then
      e2e_pass "$desc (value=$got)"
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  e2e_fail "$desc — last value $got, wanted >= $min after ${timeout}s"
  return 1
}

run_e2e_assertions() {
  JAR="$RUN_DIR/cookies.jar"
  SESSION_TAG="e2e-$(date +%s)-$$"

  echo "== e2e round trip =="

  # 1. Mint a dev token for the seeded Acme admin (DeskId claim shape).
  TOKEN=$(curl -sf -X POST "$MOCK_DESKID_URL/v1/dev/token" \
    -H 'content-type: application/json' \
    -d "{\"sub\":\"$SEED_USER_A_SUB\",\"email\":\"$SEED_USER_A_EMAIL\",\"role\":\"admin\"}" \
    | json_get "['token']") || TOKEN=""
  [ -n "$TOKEN" ] && e2e_pass "mint dev token via mock-deskid" \
                  || e2e_fail "mint dev token via mock-deskid"

  # 2. Exchange it at the web auth callback (provisions/loads the user,
  #    sets the signed session cookie).
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" \
    "$WEB_URL/auth/callback?token=$TOKEN&provider=github" || echo 000)
  { [ "$CODE" = "307" ] || [ "$CODE" = "302" ]; } \
    && e2e_pass "auth callback sets session (HTTP $CODE)" \
    || e2e_fail "auth callback sets session (HTTP $CODE)"

  # 3. Session payload -> workspace id (cookie is base64url payload + HMAC).
  WS_ID=$(awk '$6 == "vyaya_session" { print $7 }' "$JAR" 2>/dev/null | tail -1 \
    | cut -d. -f1 \
    | python3 -c "import base64,json,sys; s=sys.stdin.read().strip(); s += '=' * (-len(s) % 4); print(json.loads(base64.urlsafe_b64decode(s))['workspaceId'])" 2>>"$E2E_LOG") || WS_ID=""
  [ -n "$WS_ID" ] && e2e_pass "session resolves workspace ($WS_ID)" \
                  || e2e_fail "session resolves workspace"

  # 4. Create an API key through the web BFF (plaintext shown once).
  API_KEY=$(curl -sf -b "$JAR" -X POST "$WEB_URL/api/keys" \
    -H 'content-type: application/json' -d '{"name":"e2e-roundtrip"}' \
    | json_get "['plaintext']") || API_KEY=""
  case "$API_KEY" in
    vy_live_*) e2e_pass "create API key via web BFF" ;;
    *) e2e_fail "create API key via web BFF (got: ${API_KEY:0:12}...)"; API_KEY="" ;;
  esac

  # 5. Unauthenticated stats call must be rejected.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/api/stats/summary" || echo 000)
  [ "$CODE" = "401" ] && e2e_pass "stats API rejects anonymous callers (401)" \
                      || e2e_fail "stats API rejects anonymous callers (HTTP $CODE)"

  # 6. Send a chat completion through the proxy with the new key.
  HTTP=$(curl -s -o "$RUN_DIR/proxy-response.json" -w '%{http_code}' \
    -X POST "$PROXY_URL/v1/chat/completions" \
    -H "content-type: application/json" \
    -H "X-Vyaya-Key: $API_KEY" \
    -H "X-Vyaya-Session: $SESSION_TAG" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Give me a one-word greeting."}]}' \
    || echo 000)
  if [ "$HTTP" = "200" ] \
     && python3 -c "import json; d=json.load(open('$RUN_DIR/proxy-response.json')); assert d['choices'][0]['message']['content']" 2>>"$E2E_LOG"; then
    e2e_pass "proxied chat completion (HTTP 200, content present)"
  else
    e2e_fail "proxied chat completion (HTTP $HTTP)"
  fi

  # 7. Proxy logging is fire-and-forget: poll for the request_log row.
  poll_query_ge "request_log row for proxied request" \
    "SELECT COUNT(*)::int AS c FROM request_logs WHERE session_id = '$SESSION_TAG'" 1 20

  # 8. Run the classifier once over all workspaces.
  if eval "$CLASSIFY_ONCE" >>"$E2E_LOG" 2>&1; then
    e2e_pass "worker classify --once"
  else
    e2e_fail "worker classify --once (exit $?)"
  fi

  # 9. Waste events for this workspace must exist now (seed data guarantees
  #    patterns; the classifier pins detector_version per event).
  poll_query_ge "waste_event rows for workspace" \
    "SELECT COUNT(*)::int AS c FROM waste_events WHERE workspace_id = '$WS_ID'" 1 20

  echo "-- waste types detected:"
  node "$ROOT/scripts/e2e-sql.mjs" "$DATABASE_URL" \
    "SELECT waste_type, COUNT(*)::int AS n, SUM(dollars_wasted)::float8 AS usd FROM waste_events WHERE workspace_id = '$WS_ID' GROUP BY waste_type ORDER BY usd DESC" \
    2>>"$E2E_LOG" | while IFS= read -r line; do echo "   $line"; done

  # 10. Dashboard stats API reflects the waste.
  curl -sf -b "$JAR" "$WEB_URL/api/stats/summary" > "$RUN_DIR/summary.json" \
    && python3 - "$RUN_DIR/summary.json" <<'PY' >>"$E2E_LOG" 2>&1
import json, sys
s = json.load(open(sys.argv[1]))
assert s["wasteEventCount"] >= 1, "no waste events in summary"
assert s["dollarsWasted"] > 0, "no dollars wasted in summary"
assert s["totalSpendUsd"] > 0, "no spend in summary"
print(f"summary: spend=${s['totalSpendUsd']:.4f} wasted=${s['dollarsWasted']:.4f} "
      f"rate={s['wasteRate']:.2%} events={s['wasteEventCount']} requests={s['requestCount']}")
PY
  if [ $? -eq 0 ]; then
    e2e_pass "dashboard stats API shows waste events"
    grep '^summary:' "$E2E_LOG" | tail -1
  else
    e2e_fail "dashboard stats API shows waste events"
  fi

  # 11. Top waste events list renders the same finding.
  curl -sf -b "$JAR" "$WEB_URL/api/waste-events?page=1&pageSize=3" > "$RUN_DIR/events.json" \
    && python3 - "$RUN_DIR/events.json" <<'PY' >>"$E2E_LOG" 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["total"] >= 1, "empty waste event page"
e = d["events"][0]
print(f"top event: {e['wasteType']} ${e['dollarsWasted']:.4f} — {e['suggestedFix'][:80]}")
PY
  if [ $? -eq 0 ]; then
    e2e_pass "waste events API lists findings"
    grep '^top event:' "$E2E_LOG" | tail -1
  else
    e2e_fail "waste events API lists findings"
  fi

  echo "== result: $E2E_PASS passed, $E2E_FAIL failed =="
  [ "$E2E_FAIL" -eq 0 ]
}
