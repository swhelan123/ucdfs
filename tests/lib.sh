#!/usr/bin/env bash
# Shared helpers for the UCDFS test suites.
#
# Every test account is created with the TEST_PREFIX below so cleanup can delete
# them without any chance of touching a real one. Do not change it without
# changing cleanup_test_accounts() to match.

TEST_PREFIX="ucdfs-test-"
TEST_PASSWORD="TestPassword123!"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/tests/.work"
mkdir -p "$WORK"

TEST_PORT="${TEST_PORT:-3979}"
BASE="http://localhost:$TEST_PORT"
CONTAINER="ucdfs-test"
IMAGE="${TEST_IMAGE:-ucdfs-attendance-bot}"

pass=0; fail=0

ck() { # ck <label> <got> <want>
  # Guard the arity before comparing anything. macOS ships bash 3.2, which
  # splits a multi-line "$(node -e "…\"…\"")" into several arguments, so ck was
  # called with five, compared two empty strings, and printed ok for ten static
  # checks that had in fact never run. Locally green, red on the bash 5 runner,
  # and nothing on screen to say which. A harness that cannot check something
  # has to say so, not pass it.
  if [ "$#" -ne 3 ]; then
    fail=$((fail+1))
    printf "  FAIL  %-46s harness bug: ck got %s args, want 3\n" "${1:-?}" "$#"
    return
  fi
  if [ "$2" = "$3" ]; then
    pass=$((pass+1)); printf "  ok    %-46s %s\n" "$1" "$2"
  else
    fail=$((fail+1)); printf "  FAIL  %-46s got %s want %s\n" "$1" "$2" "$3"
  fi
}

# The suites default to the non-production database and refuse the real one.
#
# They used to load .env, which is production: every run created real accounts
# in the live GoTrue, and cleanup_activity_log() existed because otherwise test
# rows sat on the team's dashboard pushing real activity off the homepage. All
# of that was load-bearing. Now it is a second line of defence behind a database
# nobody real is in.
#
# Overriding the file is possible and deliberately awkward. You have to name it
# AND set UCDFS_ALLOW_PROD_TESTS=1, because "just this once against prod" is how
# somebody's attendance history gets deleted by a test that asserts deletion works.
load_env() {
  ENV_FILE="${UCDFS_ENV_FILE:-$ROOT/.env.nonprod}"

  if [ ! -f "$ENV_FILE" ]; then
    echo "No $ENV_FILE." >&2
    echo "The suites run against the non-production Supabase project, not the live one." >&2
    echo "See .env.example for what goes in it." >&2
    exit 1
  fi

  set -a; . "$ENV_FILE"; set +a

  if [ "${UCDFS_ENV:-}" = "prod" ] && [ "${UCDFS_ALLOW_PROD_TESTS:-0}" != "1" ]; then
    echo "Refusing to run: $ENV_FILE is UCDFS_ENV=prod." >&2
    echo "These suites sign up accounts, write attendance and delete rows. Against" >&2
    echo "production that is real people's data." >&2
    echo "If you genuinely mean it: UCDFS_ALLOW_PROD_TESTS=1 $0" >&2
    exit 1
  fi

  if [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
    echo "SUPABASE_SERVICE_KEY is empty in $ENV_FILE. The suites need it." >&2
    exit 1
  fi

  echo "  database: ${UCDFS_ENV:-unlabelled} (${SUPABASE_URL})"
}

test_email() { echo "${TEST_PREFIX}$(date +%s)-$RANDOM@ucdconnect.ie"; }

start_test_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  # The live container on :3978 is never touched. This one mounts the working
  # tree read-only, so it always tests what is on disk right now.
  docker run -d --name "$CONTAINER" -p "$TEST_PORT:3978" \
    -v "$ROOT/main.py:/app/main.py:ro" \
    -v "$ROOT/static:/app/static:ro" \
    -e SUPABASE_URL="$SUPABASE_URL" \
    -e SUPABASE_KEY="$SUPABASE_KEY" \
    -e SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
    -e ALLOWED_EMAIL_DOMAINS="$ALLOWED_EMAIL_DOMAINS" \
    -e COOKIE_SECURE=0 \
    "$IMAGE" >/dev/null || {
      echo "Could not start the test container. Is the image '$IMAGE' built?" >&2
      echo "Build it with: cd $ROOT && docker compose build" >&2
      exit 1; }

  for _ in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    sleep 1
  done
  echo "Test container never became healthy. Logs:" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
}

stop_test_container() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }

# Delete every account created by the suites, via the GoTrue admin API.
# Guarded twice: the API filter and an explicit prefix re-check per user.
cleanup_test_accounts() {
  python3 - "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$TEST_PREFIX" <<'PY'
import json, sys, urllib.request

url, key, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}

def call(method, path):
    req = urllib.request.Request(url + path, headers=hdr, method=method)
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read()
        return json.loads(body) if body else None

try:
    users = call("GET", "/auth/v1/admin/users?per_page=1000").get("users", [])
except Exception as e:
    print(f"  cleanup: could not list users ({e})")
    sys.exit(0)

removed = 0
for u in users:
    email = (u.get("email") or "")
    # Belt and braces: never delete anything that isn't unmistakably a test user.
    if not email.startswith(prefix):
        continue
    try:
        call("DELETE", "/auth/v1/admin/users/" + u["id"])
        removed += 1
    except Exception as e:
        print(f"  cleanup: failed to delete {email} ({e})")

kept = len(users) - removed
print(f"  cleanup: removed {removed} test account(s), {kept} real account(s) untouched")
PY
}

# Display names the suites sign up as. activity_log stores the actor as text
# captured at write time, deliberately, so a feed line still reads correctly
# after the thing it names is gone, which means deleting the test *accounts*
# leaves their feed lines behind on the live dashboard. Without this, every run
# pushes real activity further down the homepage.
#
# Keep in step with the signUp() calls in the suites.
TEST_ACTORS='Profile Alpha,Profile Bravo,Profile Fresh,Profile Deep,Page Check,Comp Check,Harness Check,Admin Probe,Admin Victim,Admin Doomed,Plans Check,Links Member,Links Boss,Test Bot'

# Remove feed lines written during THIS run by those names. Guarded on both:
# a name on its own could in principle belong to a real member, and a time
# window on its own would take out real activity.
cleanup_activity_log() {
  local since="${1:-}"
  [ -z "$since" ] && return 0
  python3 - "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$TEST_ACTORS" "$since" <<'PY'
import json, sys, urllib.parse, urllib.request

url, key, actors, since = sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4]
hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}

# Names contain spaces, so the in-list has to be percent-encoded. " and , are
# PostgREST syntax here, not data, and stay literal.
inlist = ",".join('"' + a.replace('"', '') + '"' for a in actors)
q = ("/rest/v1/activity_log?actor=in.(" + urllib.parse.quote(inlist, safe='",') + ")" +
     "&created_at=gte." + urllib.parse.quote(since))

req = urllib.request.Request(url + q, headers={**hdr, "Prefer": "return=representation"},
                             method="DELETE")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.loads(r.read() or "[]")
    if rows:
        print(f"  cleanup: removed {len(rows)} test feed line(s)")
except Exception as e:
    # The table may not exist yet (002 unapplied). Never fail a run over tidying.
    print(f"  cleanup: could not tidy the activity feed ({e})")
PY
}

# Same idea for pt_done_log: suite-plans ticks a node on the 26/27 plan, and
# that audit line is append-only by design. Nothing in the app removes it when
# the node goes. Same double guard as above, name AND time window.
cleanup_links() {
  # Hyperlink cards created by suite-links (migrations/010).
  #
  # Matched on the name prefix rather than on the id, because a run that
  # crashes between creating a link and deleting it never learns the id the
  # server minted. A leftover row here is not inert: it is a card on the
  # dashboard of every account in the non-prod project.
  python3 - "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$TEST_PREFIX" <<'PY'
import json, sys, urllib.parse, urllib.request

url, key, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
q = "/rest/v1/links?name=like." + urllib.parse.quote(prefix + "*", safe="")
req = urllib.request.Request(url + q, headers={**hdr, "Prefer": "return=representation"},
                             method="DELETE")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.loads(r.read() or "[]")
    if rows:
        print(f"  cleanup: removed {len(rows)} test link(s)")
except Exception as e:
    # The table may not exist yet (010 unapplied). Never fail a run over tidying.
    print(f"  cleanup: could not tidy links ({e})")
PY
}

cleanup_pt_done_log() {
  local since="${1:-}"
  [ -z "$since" ] && return 0
  python3 - "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$TEST_ACTORS" "$since" <<'PY'
import json, sys, urllib.parse, urllib.request

url, key, actors, since = sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4]
hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}

inlist = ",".join('"' + a.replace('"', '') + '"' for a in actors)
q = ("/rest/v1/pt_done_log?user_name=in.(" + urllib.parse.quote(inlist, safe='",') + ")" +
     "&created_at=gte." + urllib.parse.quote(since))

req = urllib.request.Request(url + q, headers={**hdr, "Prefer": "return=representation"},
                             method="DELETE")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.loads(r.read() or "[]")
    if rows:
        print(f"  cleanup: removed {len(rows)} test tick line(s)")
except Exception as e:
    print(f"  cleanup: could not tidy pt_done_log ({e})")
PY
}

summary() { # summary <suite-name>
  echo
  if [ "$fail" -eq 0 ]; then
    echo "  $1: $pass passed"
  else
    echo "  $1: $pass passed, $fail FAILED"
  fi
  return "$fail"
}
