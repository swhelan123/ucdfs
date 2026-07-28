#!/usr/bin/env bash
# UCDFS test runner.
#
#   ./tests/run.sh                 everything
#   ./tests/run.sh static          one suite (static|auth|pages|login|comp|harness|profiles|admin)
#   ./tests/run.sh --keep          leave the test container up afterwards
#
# Runs against a throwaway container on :3979 built from the working tree.
# The live container on :3978 is never touched.
#
# Test accounts are created against the real Supabase project (there is no
# separate test project) using the ucdfs-test- prefix, and deleted on exit.
set -u

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

KEEP=0
SUITES=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)      SUITES+=("$arg") ;;
  esac
done
[ ${#SUITES[@]} -eq 0 ] && SUITES=(static auth pages login comp harness profiles admin)

load_env

# Stamped before anything runs, so cleanup can find exactly the rows this run
# wrote to the shared activity feed and nothing older.
RUN_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

needs_container=0
for s in "${SUITES[@]}"; do [ "$s" != "static" ] && needs_container=1; done

needs_node=0
for s in "${SUITES[@]}"; do
  case "$s" in static|pages|login|comp) needs_node=1 ;; esac
done

if [ "$needs_node" = "1" ] && [ ! -d "$ROOT/tests/node_modules" ]; then
  echo "Installing test dependencies (one-off)…"
  ( cd "$ROOT/tests" && npm install --silent --no-fund --no-audit ) || {
    echo "npm install failed" >&2; exit 1; }
fi

cleanup() {
  local code=$?
  if [ "$needs_container" = "1" ]; then
    echo
    cleanup_test_accounts
    cleanup_activity_log "$RUN_STARTED"
    if [ "$KEEP" = "1" ]; then
      echo "  test container left running at $BASE"
    else
      stop_test_container
    fi
  fi
  exit $code
}
trap cleanup EXIT INT TERM

if [ "$needs_container" = "1" ]; then
  echo "Starting test container on port $TEST_PORT…"
  start_test_container
fi

total_fail=0
for suite in "${SUITES[@]}"; do
  echo
  echo "═══ $suite ═══"
  case "$suite" in
    static) bash  "$ROOT/tests/suite-static.sh" || total_fail=$((total_fail+1)) ;;
    auth)   bash  "$ROOT/tests/suite-auth.sh"   || total_fail=$((total_fail+1)) ;;
    pages)  TEST_BASE="$BASE" node "$ROOT/tests/suite-pages.js" || total_fail=$((total_fail+1)) ;;
    login)  TEST_BASE="$BASE" node "$ROOT/tests/suite-login.js" || total_fail=$((total_fail+1)) ;;
    comp)   TEST_BASE="$BASE" node "$ROOT/tests/suite-comp.js"  || total_fail=$((total_fail+1)) ;;
    harness) TEST_BASE="$BASE" node "$ROOT/tests/suite-harness.js" || total_fail=$((total_fail+1)) ;;
    profiles) TEST_BASE="$BASE" node "$ROOT/tests/suite-profiles.js" || total_fail=$((total_fail+1)) ;;
    admin)   TEST_BASE="$BASE" node "$ROOT/tests/suite-admin.js" || total_fail=$((total_fail+1)) ;;
    *)      echo "Unknown suite: $suite" >&2; total_fail=$((total_fail+1)) ;;
  esac
done

echo
echo "═══════════════════════════════"
if [ "$total_fail" -eq 0 ]; then
  echo "  ALL SUITES PASSED"
else
  echo "  $total_fail SUITE(S) FAILED"
fi
echo "═══════════════════════════════"
exit "$total_fail"
