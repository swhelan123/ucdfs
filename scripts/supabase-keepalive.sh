#!/usr/bin/env bash
# Keep both Supabase projects awake by making one real query against each.
#
#   ./scripts/supabase-keepalive.sh            ping both, quiet unless something is wrong
#   ./scripts/supabase-keepalive.sh --verbose  print every request and its status
#
# Why this exists: a free-tier Supabase project pauses after seven consecutive
# days with no activity, and an unpaused project is not something the free tier
# lets you schedule — you restore it by hand from the dashboard. Prod is
# `fs-attendance` and gets used most weeks, so it looks safe, but "most weeks"
# is not "every week": exam periods, the summer, and the gap between one
# committee and the next are all longer than seven days. Non-prod is worse,
# because dev and stage are only up when somebody is working on the site.
#
# The failure this prevents is not a slow site. It is the first person back
# after a quiet month finding that the login page 500s, and having to know that
# the fix is a dashboard button rather than anything in this repo.
#
# ── What counts as activity ────────────────────────────────────────────────
#
# A PostgREST request runs actual SQL against the database, which is what the
# inactivity clock watches. A request to the auth settings endpoint, or to
# anything else served from Supabase's edge rather than from Postgres, is not
# obviously the same thing, so this queries a table.
#
# `comp_meta` is the target: one row, two text columns, no personal data. Every
# other table here is either about a person or big enough to be worth not
# pulling down daily for no reason.
#
# ── Which key, and why the expected answer is no rows ──────────────────────
#
# The anon key, not the service key. There is no reason for a credential that
# bypasses RLS to sit in a path that runs unattended every day, and a keepalive
# does not need to read anything: RLS is enforced inside Postgres, so the query
# runs and the clock resets whether or not a row survives the policy check.
#
# Which means this script cannot verify it got data back — and must not want
# to. Every table in this schema has RLS on with zero policies (001, 002, 003,
# 009, 010), because the browser never talks to Supabase and authorization is
# FastAPI's job. `000_baseline.sql:307` puts it plainly: if data comes back
# with the anon key, something is wrong.
#
# So `[]` is the pass condition, and a row is the alarm. The keepalive is also
# a daily check that the anon key still reads nothing, which is the property
# that makes it safe to hold in the first place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

# Both tiers, by env file. Prod first: if the network is broken, the more
# useful line to have at the top of the log is the one about production.
ENV_FILES=("$ROOT/.env" "$ROOT/.env.nonprod")

TABLE="comp_meta"
QUERY="select=key&limit=1"
ATTEMPTS=3      # a home connection drops; one flaky night is not a reason to alert
TIMEOUT=20

die() { echo "keepalive: $*" >&2; exit 1; }

read_env() { # read_env <file> <var>
  grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '"'"'"' '
}

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') keepalive: $*"; }

failed=0

for f in "${ENV_FILES[@]}"; do
  [ -f "$f" ] || die "no $f"

  tier="$(read_env "$f" UCDFS_ENV)"
  url="$(read_env "$f" SUPABASE_URL)"
  key="$(read_env "$f" SUPABASE_KEY)"

  [ -n "$url" ] || die "no SUPABASE_URL in $f"
  [ -n "$key" ] || die "no SUPABASE_KEY in $f"

  # The project ref, not the whole URL: enough to tell the two apart in a log
  # without putting anything in there that is worth redacting later.
  ref="$(echo "$url" | sed -E 's|https?://||; s|\..*||')"

  ok=0
  for attempt in $(seq 1 $ATTEMPTS); do
    # Body and status in one call. --fail is deliberately not used: a 4xx body
    # from PostgREST says what is actually wrong, and that is the thing worth
    # having in the journal.
    resp="$(curl -s -m "$TIMEOUT" -w '\n%{http_code}' \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$url/rest/v1/$TABLE?$QUERY" 2>&1)" || resp=$'\n000'

    code="$(echo "$resp" | tail -1)"
    body="$(echo "$resp" | sed '$d')"

    # 200 means Postgres ran the query, which is the whole point. `[]` is the
    # expected body: RLS filtered it, as it filters everything holding this
    # key. Anything else in that array is data the anon key should not be able
    # to see, and it is worth failing the run to put a red unit in front of
    # somebody — a warning in the journal is a warning nobody reads.
    if [ "$code" = "200" ]; then
      ok=1
      if [ "$body" != "[]" ]; then
        log "RLS $tier ($ref): anon key read $TABLE and got ${body:0:120}"
        log "RLS $tier ($ref): expected [] — see migrations/001_auth_and_rls.sql"
        failed=1
      fi
      [ "$VERBOSE" = "1" ] && log "$tier ($ref): $code $body, attempt $attempt"
      break
    fi

    [ "$VERBOSE" = "1" ] && log "$tier ($ref): $code, attempt $attempt of $ATTEMPTS"
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep $((attempt * 5))
  done

  if [ "$ok" != "1" ]; then
    # Truncated: a PostgREST error is one short JSON object, but a proxy or a
    # captive portal in the way can return a whole HTML page.
    log "FAILED $tier ($ref): last status $code ${body:0:200}"
    failed=1
  fi
done

if [ "$failed" = "1" ]; then
  # Non-zero so systemd marks the unit failed and `--failed` finds it. A
  # keepalive that fails silently is the same as no keepalive at all, and you
  # would not find out until the project was already paused.
  die "run failed, see the lines above — a project did not answer, or the anon key read something it should not have"
fi

[ "$VERBOSE" = "1" ] && log "both projects answered"
exit 0
