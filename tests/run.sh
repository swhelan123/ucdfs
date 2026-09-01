#!/usr/bin/env bash
# UCDFS test runner.
#
#   ./tests/run.sh                 everything
#   ./tests/run.sh static          one suite (static|auth|pages|login|comp|harness|profiles|admin|plans)
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
[ ${#SUITES[@]} -eq 0 ] && SUITES=(static auth pages login comp harness profiles admin plans links)

# Stamped before anything runs, so cleanup can find exactly the rows this run
# wrote to the shared activity feed and nothing older.
RUN_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

needs_container=0
for s in "${SUITES[@]}"; do [ "$s" != "static" ] && needs_container=1; done

# Only the suites that touch a database need credentials. `static` parses files
# and greps for secrets. It should keep working on a machine that has no env
# file at all, which is also what makes it the useful first thing to run.
[ "$needs_container" = "1" ] && load_env

needs_node=0
for s in "${SUITES[@]}"; do
  case "$s" in static|pages|login|comp|plans) needs_node=1 ;; esac
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
    cleanup_pt_done_log "$RUN_STARTED"
    cleanup_links
    cleanup_groups
    if [ "$KEEP" = "1" ]; then
      echo "  test container left running at $BASE"
    else
      stop_test_container
    fi
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# ── One test run at a time on this machine ────────────────────────────────
# The container name and port are fixed, and start_test_container does a
# `docker rm -f` first, so a second run does not queue behind the first: it
# destroys it. CI runs on a self-hosted runner on this same machine, so
# "somebody ran the suite locally" and "CI is running" is a collision — and it
# does not look like one. The container vanishes mid-run and every suite after
# it dies on `fetch failed / SocketError: other side closed`, which reads as a
# bug in whatever branch CI happened to be testing. That is exactly what
# happened to PR #21, whose code was fine.
#
# Serialising rather than picking a free port per run, because the port is not
# the only thing shared. Every run points at the one non-prod Supabase project,
# and some of that state is singular: comp_meta's `runner` is a single row, and
# suite-comp borrows it.
#
# The lock is an fd held for the life of the process, so it releases on exit,
# on Ctrl-C, and on kill -9 alike. Nothing to clean up and nothing to go stale.
if [ "$needs_container" = "1" ]; then
  # A fixed path, not $TMPDIR: the whole job of this lock is to exclude runs
  # across different checkouts and different shells on one machine, and a
  # per-job or per-session TMPDIR would give each of them a private lock that
  # excludes nothing. Both the CI runner and a human shell here run as the same
  # user, so one file works for both.
  LOCKFILE="/tmp/ucdfs-tests.lock"
  exec 9>"$LOCKFILE" || { echo "Cannot open $LOCKFILE" >&2; exit 1; }
  if ! flock -n 9; then
    echo "Another test run holds the container (CI, or another terminal). Waiting…"
    flock -w 1800 9 || {
      echo "Gave up waiting for $LOCKFILE after 30 minutes." >&2
      echo "Nothing actually running? See who holds it: lsof $LOCKFILE" >&2
      exit 1; }
  fi
fi

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
    plans)   TEST_BASE="$BASE" node "$ROOT/tests/suite-plans.js" || total_fail=$((total_fail+1)) ;;
    links)   TEST_BASE="$BASE" node "$ROOT/tests/suite-links.js" || total_fail=$((total_fail+1)) ;;
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
