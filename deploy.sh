#!/usr/bin/env bash
# UCDFS deploy.
#
#   ./deploy.sh dev              build the working tree, run it on :3980
#   ./deploy.sh stage <tag>      run an already-built image on :3981
#   ./deploy.sh prod  <tag>      run an already-built image on :3978
#   ./deploy.sh build <tag>      build and tag an image, deploy nothing
#   ./deploy.sh rollback         list the prod images you could go back to
#
# A tag is a git sha. CI builds once, deploys that same image to stage, and
# later deploys THE SAME IMAGE to prod, promoting an artefact rather than
# rebuilding from source twice and hoping the two builds agree.
#
# The rules this script exists to enforce, because getting them wrong is silent:
#
#   - prod is the only tier that may use .env, and it must never be built from
#     an uncommitted working tree.
#   - dev and stage may never use .env. Pointing them at the real database is
#     the exact failure this whole setup was built to prevent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV="${1:-}"
TAG="${2:-}"

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
die()   { echo "deploy: $*" >&2; exit 1; }

# ── Where state lives, absolutely ──────────────────────────────────────────
# Both of these are absolute and deliberately NOT relative to the checkout.
# CI runs this from the runner's workspace (~/actions-runner/_work/ucdfs/ucdfs),
# which is a different directory on every job. A relative ./data/uploads there
# resolves to an empty folder, the mount silently succeeds, and the team's
# profile photos disappear from a site that is otherwise working fine.
#
# Secrets are on the homeserver, not in GitHub. The runner is on the same
# machine as the thing it deploys, so there is no reason to copy the
# service_role key into a CI provider to hand it back to ourselves.
HOME_DIR="${UCDFS_HOME:-/home/shane/ucdfs}"
DATA_ROOT="${UCDFS_DATA_ROOT:-$HOME_DIR/data}"

# ── Per-tier settings ──────────────────────────────────────────────────────
# Ports: 3978 is the live site and is spoken for. 3979 belongs to the test
# suite's throwaway container, deliberately not reused here, so a deploy can
# never collide with a test run in progress.
case "$ENV" in
  dev)   PORT=3980; ENV_FILE="$HOME_DIR/.env.nonprod"; DATA="$DATA_ROOT/dev/uploads"   ;;
  stage) PORT=3981; ENV_FILE="$HOME_DIR/.env.nonprod"; DATA="$DATA_ROOT/stage/uploads" ;;
  prod)  PORT=3978; ENV_FILE="$HOME_DIR/.env";         DATA="$DATA_ROOT/uploads"       ;;
  build) : ;;
  rollback)
    echo "Images available to deploy (newest first):"
    docker images ucdfs --format '  {{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' | head -20
    echo
    echo "Currently on prod: $(docker inspect -f '{{.Config.Image}}' ucdfs-prod 2>/dev/null || echo 'nothing running')"
    echo "Roll back with:    ./deploy.sh prod <tag>"
    exit 0 ;;
  *) usage ;;
esac

# ── Build ──────────────────────────────────────────────────────────────────
if [ "$ENV" = "build" ]; then
  [ -n "$TAG" ] || die "build needs a tag: ./deploy.sh build \$(git rev-parse --short HEAD)"
  echo "Building ucdfs:$TAG"
  docker build -t "ucdfs:$TAG" .
  # Also tag it with the short sha's git description, so `docker images` is
  # readable months later when the sha means nothing on its own.
  echo "Built ucdfs:$TAG"
  exit 0
fi

# ── The env file is the database ───────────────────────────────────────────
[ -f "$ENV_FILE" ] || die "no $ENV_FILE. See .env.example (set UCDFS_HOME if secrets live elsewhere)"

# Read the tier label out of the file and check it agrees with the tier we were
# asked to deploy. This is the guard that catches the copy-paste where someone
# fills .env.nonprod with production credentials: the labels stop matching and
# the deploy stops rather than quietly serving real data on a staging URL.
FILE_ENV="$(grep -E '^UCDFS_ENV=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
[ -n "$FILE_ENV" ] || die "$ENV_FILE has no UCDFS_ENV line. Label it so this check can work"

case "$ENV" in
  prod)         [ "$FILE_ENV" = "prod" ]    || die "prod must use a UCDFS_ENV=prod file; $ENV_FILE says '$FILE_ENV'" ;;
  dev|stage)    [ "$FILE_ENV" = "nonprod" ] || die "$ENV must use a UCDFS_ENV=nonprod file; $ENV_FILE says '$FILE_ENV'. Refusing to point $ENV at production" ;;
esac

grep -qE '^SUPABASE_SERVICE_KEY=.+' "$ENV_FILE" \
  || die "SUPABASE_SERVICE_KEY is empty in $ENV_FILE. The app cannot read its own data without it"

# ── What to run ────────────────────────────────────────────────────────────
if [ "$ENV" = "dev" ] && [ -z "$TAG" ]; then
  # Dev is the one tier allowed to run uncommitted work. That is what it is for.
  TAG="dev-$(date +%H%M%S)"
  echo "Building the working tree as ucdfs:$TAG"
  docker build -t "ucdfs:$TAG" .
else
  [ -n "$TAG" ] || die "$ENV needs an image tag: ./deploy.sh $ENV \$(git rev-parse --short HEAD)"
  docker image inspect "ucdfs:$TAG" >/dev/null 2>&1 \
    || die "no image ucdfs:$TAG. Build it first with ./deploy.sh build $TAG"
fi

# Production gets one more check. Deploying a sha that is not on main means
# either a rollback (fine, and the override says so out loud) or a mistake.
if [ "$ENV" = "prod" ] && [ "${ALLOW_UNTRACKED_PROD:-0}" != "1" ]; then
  git merge-base --is-ancestor "$TAG" origin/main 2>/dev/null \
    || die "$TAG is not an ancestor of origin/main. If this is a deliberate rollback, re-run with ALLOW_UNTRACKED_PROD=1"
fi

mkdir -p "$DATA"

echo "→ $ENV  image=ucdfs:$TAG  port=$PORT  env=$ENV_FILE  data=$DATA"

UCDFS_ENV="$ENV" \
UCDFS_TAG="$TAG" \
UCDFS_PORT="$PORT" \
UCDFS_ENV_FILE="$ENV_FILE" \
UCDFS_DATA="$DATA" \
  docker compose up -d --no-build --remove-orphans

# ── Prove it came up ───────────────────────────────────────────────────────
# A deploy that reports success because `docker compose up` exited 0 is a deploy
# that reports success when the app crashes on a missing env var.
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    echo "✓ $ENV is healthy on :$PORT (ucdfs:$TAG)"
    exit 0
  fi
  sleep 1
done

echo "✗ $ENV never became healthy on :$PORT. Last 30 log lines:" >&2
docker logs "ucdfs-$ENV" 2>&1 | tail -30 >&2
exit 1
