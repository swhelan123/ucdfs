#!/usr/bin/env bash
# Copy the reference data from production into the non-production database.
#
#   ./scripts/seed-nonprod.sh            copy
#   ./scripts/seed-nonprod.sh --dry-run  say what would be copied, write nothing
#
# Why this exists: a staging environment with an empty database does not
# resemble production, and a stage that does not resemble production tells you
# nothing. /pt renders a blank canvas, /comp renders an empty schedule, and the
# first real bug they would have caught goes to the live site instead.
#
# ── What is copied, and what is deliberately not ───────────────────────────
#
# Copied: structure and content the team authored, describing the car and the
# season rather than the people:
#
#   pt_sections, pt_nodes, pt_edges   the manufacturing plan graph
#   pt_done                           tick state; node ids only, no names
#   schedule_events                   the competition timetable
#   comp_meta                         a single settings row
#   harness_doc                       the wiring design document
#
# NOT copied: every table that is about a person:
#
#   profiles, profile_details,        names, emails, courses, photo filenames,
#   profile_prompts                   and answers people wrote about themselves
#   attendance                        who was in the workshop and when
#   comp_roster, comp_requests        who is on for which day, who bought what
#   pt_done_log                       carries user_name
#   activity_log                      carries actor names
#
# The rule is not "is it sensitive" but "is it about a person". A staging
# environment is something you hand to a new committee member to break. Real
# names and faces should not be in it, and there is no version of this script
# that copies them. Adding one would defeat the reason the two databases were
# separated in the first place.
#
# Photos are not copied either. They are files on disk under data/uploads, and
# each tier has its own directory precisely so staging never holds real faces.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SRC_FILE="${UCDFS_SRC_ENV:-$ROOT/.env}"
DST_FILE="${UCDFS_DST_ENV:-$ROOT/.env.nonprod}"

die() { echo "seed: $*" >&2; exit 1; }

read_env() { # read_env <file> <var>
  grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '"'"'"' '
}

for f in "$SRC_FILE" "$DST_FILE"; do
  [ -f "$f" ] || die "no $f"
done

SRC_ENV="$(read_env "$SRC_FILE" UCDFS_ENV)"
DST_ENV="$(read_env "$DST_FILE" UCDFS_ENV)"

# The direction is the whole safety property. Reading from prod is harmless;
# writing to it from here would overwrite the live manufacturing plan with
# whatever state a staging environment had drifted into.
[ "$SRC_ENV" = "prod" ]    || die "source $SRC_FILE is '$SRC_ENV', expected prod. This script only ever reads from production"
[ "$DST_ENV" = "nonprod" ] || die "destination $DST_FILE is '$DST_ENV', expected nonprod. REFUSING to write to a production database"

SRC_URL="$(read_env "$SRC_FILE" SUPABASE_URL)"
SRC_KEY="$(read_env "$SRC_FILE" SUPABASE_SERVICE_KEY)"
DST_URL="$(read_env "$DST_FILE" SUPABASE_URL)"
DST_KEY="$(read_env "$DST_FILE" SUPABASE_SERVICE_KEY)"

[ -n "$SRC_KEY" ] || die "no SUPABASE_SERVICE_KEY in $SRC_FILE"
[ -n "$DST_KEY" ] || die "no SUPABASE_SERVICE_KEY in $DST_FILE"
[ "$SRC_URL" != "$DST_URL" ] || die "source and destination are the same project ($SRC_URL)"

echo "  from  $SRC_URL  ($SRC_ENV)"
echo "  to    $DST_URL  ($DST_ENV)"
[ "$DRY" = "1" ] && echo "  DRY RUN: nothing will be written"
echo

# ── Tables, in dependency order ────────────────────────────────────────────
# Sections before nodes before edges: nothing enforces it with a foreign key,
# but a plan whose nodes arrive before their sections renders wrong until the
# next reload, and that is a confusing first impression of a fresh environment.
#
# The second field strips columns the destination generates itself.
# schedule_events.id is `generated always as identity`, and PostgREST has no way
# to say OVERRIDING SYSTEM VALUE. Sending an explicit id is a hard 400.
TABLES=(
  # plans first, for the same reason sections come before nodes: a chart's rows
  # are unreachable until the chart itself exists. _plan_or_400 checks this
  # table, so a seeded graph with no plans row is a 400 on every request.
  #
  # created_by is stripped. A chart is reference data, the shape of a build
  # plan, but the name of whoever made it is about a person, and the rule here
  # has no exceptions.
  "plans:created_by"
  # Hyperlink cards (migrations/010). Reference data by the same test as a
  # chart: what the dashboard points at is about the team's tools, not about a
  # person. created_by is stripped for the same reason it is on plans.
  "links:created_by"
  "pt_sections:"
  "pt_nodes:"
  "pt_edges:"
  "pt_done:"
  "comp_meta:"
  "harness_doc:"
  "schedule_events:id"
)

total=0
for entry in "${TABLES[@]}"; do
  table="${entry%%:*}"
  strip="${entry#*:}"

  rows="$(curl -sS --max-time 60 \
    -H "apikey: $SRC_KEY" -H "Authorization: Bearer $SRC_KEY" \
    "$SRC_URL/rest/v1/$table?select=*")" || die "could not read $table from production"

  echo "$rows" | jq -e 'type == "array"' >/dev/null 2>&1 \
    || die "unexpected response reading $table: $(echo "$rows" | head -c 200)"

  n="$(echo "$rows" | jq 'length')"

  if [ -n "$strip" ]; then
    rows="$(echo "$rows" | jq --arg k "$strip" 'map(del(.[$k]))')"
  fi

  if [ "$n" = "0" ]; then
    printf "  %-16s %4s rows, nothing to copy\n" "$table" "$n"
    continue
  fi

  if [ "$DRY" = "1" ]; then
    printf "  %-16s %4s rows, would copy%s\n" "$table" "$n" \
      "$([ -n "$strip" ] && echo " (without $strip)")"
    total=$((total + n))
    continue
  fi

  # merge-duplicates makes this re-runnable: seeding twice updates rather than
  # colliding on the primary key, so it is safe to run again after a schema
  # change without emptying the database first.
  code="$(curl -sS --max-time 120 -o /tmp/seed-err.$$ -w '%{http_code}' \
    -X POST "$DST_URL/rest/v1/$table" \
    -H "apikey: $DST_KEY" -H "Authorization: Bearer $DST_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates,return=minimal" \
    -d "$rows")"

  if [ "$code" != "201" ] && [ "$code" != "200" ] && [ "$code" != "204" ]; then
    echo "  $table FAILED (http $code): $(head -c 300 /tmp/seed-err.$$)" >&2
    rm -f /tmp/seed-err.$$
    exit 1
  fi
  rm -f /tmp/seed-err.$$

  printf "  %-16s %4s rows copied\n" "$table" "$n"
  total=$((total + n))
done

echo
if [ "$DRY" = "1" ]; then
  echo "  $total rows would be copied. No personal data is included. See the header."
else
  echo "  $total rows copied. No personal data was included. See the header."
  echo "  Sign up in the non-prod environment to get an account; then make yourself"
  echo "  admin with the UPDATE at the bottom of migrations/000_baseline.sql."
fi
